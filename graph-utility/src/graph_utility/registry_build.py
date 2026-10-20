"""Registry auto-build — the BUILD PLANE.

Turns an ontology (read from Neptune) into mapping-registry rows and MERGEs them
into the backend. This realizes "automatically take care of the knowledge graph
by looking into the graph": the registry is DERIVED from the ontology, not hand
-maintained.

Design: each step is a discrete, **idempotent activity** with a pure signature
(inputs -> outputs, no hidden state). Today they run in sequence as a Databricks
Job (see `run_build` + `04_*`-style notebook). Tomorrow the SAME activities drop
into a Temporal workflow unchanged — that's why they're small and idempotent.

Activities:
  1. fetch_ontology_schema(source)      -> {classes, properties, relationships}
  2. derive_mappings(source, schema)    -> list[registry_row]
  3. merge_registry(adapter, rows)      -> {inserted/updated counts}   (idempotent MERGE)
  4. smoke_test(engine)                 -> {passed, details}
  5. emit_descriptor(source)            -> descriptor dict for AgentControl

Heavy deps are isolated in the ontology client / adapter, so this module
imports cleanly for inspection and unit testing with fakes.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Optional

from .descriptor import GraphSource


# --------------------------------------------------------------------------- #
# Helpers: ontology local-name + alias synthesis
# --------------------------------------------------------------------------- #
def local_name(uri: str) -> str:
    """Last path/fragment segment of a URI (ma#therapeuticArea -> therapeuticArea)."""
    if "#" in uri:
        return uri.rsplit("#", 1)[1]
    return uri.rstrip("/").rsplit("/", 1)[-1]


def to_snake(name: str) -> str:
    """camelCase/PascalCase ontology local name -> snake_case column guess."""
    s = re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()
    return re.sub(r"__+", "_", s)


def synth_aliases(label: str, local: str) -> str:
    """Pipe-delimited NLP aliases from label + local name (dedup, lowercase)."""
    parts = {label.lower(), local.lower(), to_snake(local).replace("_", " ")}
    return "|".join(sorted(p for p in parts if p))


# --------------------------------------------------------------------------- #
# Activity 1 — fetch ontology schema
# --------------------------------------------------------------------------- #
def fetch_ontology_schema(source: GraphSource, client=None) -> dict[str, list[dict]]:
    """Read classes/properties/relationships from the ontology (read-only).

    `client` may be injected (for tests/fakes); otherwise a NeptuneOntologyClient
    is created from the descriptor.
    """
    if client is None:
        from .ontology import NeptuneOntologyClient

        client = NeptuneOntologyClient(source)
    return {
        "classes": client.list_classes(),
        "properties": client.list_properties(),
        "relationships": client.list_relationships(),
    }


# --------------------------------------------------------------------------- #
# Activity 2 — derive mapping rows from the ontology schema
# --------------------------------------------------------------------------- #
def derive_mappings(
    source: GraphSource,
    schema: dict[str, list[dict]],
    *,
    column_resolver: Optional[Callable[[str, str], Optional[str]]] = None,
    table_resolver: Optional[Callable[[str], Optional[str]]] = None,
) -> list[dict[str, Any]]:
    """Convert ontology classes/properties into registry rows.

    Mapping heuristics (overridable via resolvers for exact control):
      - ontology_uri      = the property/class URI
      - ontology_label    = rdfs:label, else prettified local name
      - uc_column (guess) = snake_case(local name)   [property only]
      - uc_table  (guess) = table_resolver(domain) or source default base table
      - join_key          = source.backend.universal_join_key
      - search_aliases    = synthesized from label + local name

    `column_resolver(uc_table, local_name) -> actual_column | None` and
    `table_resolver(domain_uri) -> uc_table | None` let the build job align
    guesses to the real UC schema (e.g. from INFORMATION_SCHEMA) deterministically.
    """
    join_key = source.backend.universal_join_key
    catalog = source.backend.catalog
    schema_name = source.backend.schema
    default_table = source.tags.get("base_table") or ""  # optional hint

    rows: list[dict[str, Any]] = []

    # Classes -> class-level entries (uc_column NULL)
    for c in schema.get("classes", []):
        uri = c.get("class") or c.get("entity") or ""
        if not uri:
            continue
        local = local_name(uri)
        label = c.get("label") or re.sub(r"(?<!^)(?=[A-Z])", " ", local).strip().title()
        tbl = (table_resolver(uri) if table_resolver else None) or default_table
        rows.append({
            "ontology_uri": uri, "ontology_label": label, "entity_type": "class",
            "uc_catalog": catalog, "uc_schema": schema_name, "uc_table": tbl,
            "uc_column": None, "join_key": join_key, "data_type": None,
            "search_aliases": synth_aliases(label, local),
            "is_filterable": True, "is_aggregatable": False,
        })

    # Properties -> column-level entries
    for p in schema.get("properties", []):
        uri = p.get("property") or ""
        if not uri:
            continue
        local = local_name(uri)
        label = p.get("label") or re.sub(r"(?<!^)(?=[A-Z])", " ", local).strip().title()
        domain = p.get("domain")
        tbl = (table_resolver(domain) if (table_resolver and domain) else None) or default_table
        col_guess = to_snake(local)
        col = (column_resolver(tbl, local) if column_resolver else None) or col_guess
        rng = (p.get("range") or "").lower()
        data_type = "double" if any(x in rng for x in ("decimal", "double", "float")) else (
            "date" if "date" in rng else "string")
        rows.append({
            "ontology_uri": uri, "ontology_label": label, "entity_type": "property",
            "uc_catalog": catalog, "uc_schema": schema_name, "uc_table": tbl,
            "uc_column": col, "join_key": join_key, "data_type": data_type,
            "search_aliases": synth_aliases(label, local),
            "is_filterable": True, "is_aggregatable": data_type == "double",
        })

    return rows


# --------------------------------------------------------------------------- #
# Activity 3 — MERGE rows into the registry (idempotent)
# --------------------------------------------------------------------------- #
def merge_registry(adapter, rows: list[dict[str, Any]]) -> dict[str, int]:
    """Idempotently upsert mapping rows into the backend registry table.

    Delegates to the adapter's spark session so re-runs converge (MERGE on
    ontology_uri + uc_table + uc_column). Returns counts. Requires a Databricks
    adapter with a Spark session at runtime.
    """
    table = adapter.source.backend.registry_table
    spark = adapter.spark  # raises clearly if no Spark session

    # Build a temp view from the derived rows and MERGE.
    import json as _json

    payload = _json.dumps(rows)
    df = spark.read.json(spark.sparkContext.parallelize([payload]))
    df.createOrReplaceTempView("_omda_incoming")

    spark.sql(f"""
        MERGE INTO {table} AS tgt
        USING _omda_incoming AS src
        ON  tgt.ontology_uri = src.ontology_uri
        AND tgt.uc_table     = src.uc_table
        AND COALESCE(tgt.uc_column,'') = COALESCE(src.uc_column,'')
        WHEN MATCHED THEN UPDATE SET
            ontology_label = src.ontology_label,
            search_aliases = src.search_aliases,
            data_type      = src.data_type,
            is_filterable  = src.is_filterable,
            is_aggregatable= src.is_aggregatable,
            updated_at     = current_timestamp()
        WHEN NOT MATCHED THEN INSERT (
            ontology_uri, ontology_label, entity_type, uc_catalog, uc_schema,
            uc_table, uc_column, join_key, data_type, search_aliases,
            is_filterable, is_aggregatable, created_at, updated_at
        ) VALUES (
            src.ontology_uri, src.ontology_label, src.entity_type, src.uc_catalog,
            src.uc_schema, src.uc_table, src.uc_column, src.join_key, src.data_type,
            src.search_aliases, src.is_filterable, src.is_aggregatable,
            current_timestamp(), current_timestamp()
        )
    """)
    total = spark.sql(f"SELECT COUNT(*) AS c FROM {table}").collect()[0]["c"]
    return {"incoming": len(rows), "registry_total": int(total)}


# --------------------------------------------------------------------------- #
# Activity 4 — smoke test the built registry via the engine
# --------------------------------------------------------------------------- #
def smoke_test(engine, questions: Optional[list[str]] = None) -> dict[str, Any]:
    """Dry-run a few questions to confirm concepts resolve and SQL generates."""
    questions = questions or [
        "list the first few properties",  # generic; real ones injected by caller
    ]
    details = []
    passed = 0
    for q in questions:
        r = engine.answer(q, dry_run=True)
        ok = bool(r.get("sql")) and not r.get("error")
        details.append({"q": q, "ok": ok, "concepts": r.get("concepts", []), "error": r.get("error")})
        passed += int(ok)
    return {"passed": passed, "total": len(questions), "details": details}


# --------------------------------------------------------------------------- #
# Activity 5 — emit the descriptor for AgentControl registration
# --------------------------------------------------------------------------- #
def emit_descriptor(source: GraphSource) -> dict[str, Any]:
    """Return the descriptor dict AgentControl should register for this source."""
    return source.require_valid().to_dict()


# --------------------------------------------------------------------------- #
# Orchestration — sequential today (Databricks Job); Temporal-ready tomorrow
# --------------------------------------------------------------------------- #
def run_build(
    source: GraphSource,
    adapter=None,
    ontology_client=None,
    column_resolver=None,
    table_resolver=None,
    smoke_questions: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Run the full build pipeline as a simple sequence.

    In Temporal, each call below becomes an `activity` and this function becomes
    the `workflow` — no change to the activity bodies.
    """
    source.require_valid()
    result: dict[str, Any] = {"graph_source_id": source.graph_source_id, "steps": {}}

    schema = fetch_ontology_schema(source, client=ontology_client)
    result["steps"]["fetch_ontology_schema"] = {
        "classes": len(schema["classes"]),
        "properties": len(schema["properties"]),
        "relationships": len(schema["relationships"]),
    }

    rows = derive_mappings(source, schema, column_resolver=column_resolver, table_resolver=table_resolver)
    result["steps"]["derive_mappings"] = {"rows": len(rows)}

    if adapter is not None:
        result["steps"]["merge_registry"] = merge_registry(adapter, rows)
        from .engine import OMDAEngine

        engine = OMDAEngine(source, adapter)
        result["steps"]["smoke_test"] = smoke_test(engine, smoke_questions)

    result["descriptor"] = emit_descriptor(source)
    return result
