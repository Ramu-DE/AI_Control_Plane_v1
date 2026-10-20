"""Generic OMDA engine — tenant-agnostic, driven by a GraphSource descriptor.

Ported and generalized from the Contract IQ notebooks (04_omda_query_engine):
all Contract-IQ-specific constants (catalog, schema, join key, base table) now
come from the GraphSource descriptor + the mapping registry loaded via a
BackendAdapter. The SAME engine serves any BU by switching graph_source_id.

Pipeline:  question -> concept extraction -> filter detection -> SQL generation
           -> execute (via adapter) -> structured result

No heavy deps here: concept extraction/SQL generation are pure Python; execution
and vector search are delegated to the adapter.
"""
from __future__ import annotations

import json
import re
from typing import Any, Optional

from .descriptor import GraphSource
from .backends import BackendAdapter


# --------------------------------------------------------------------------- #
# Concept extraction
# --------------------------------------------------------------------------- #
class ConceptExtractor:
    """Resolve ontology concepts from a question using the loaded registry.

    Keyword/alias matching first (fast, precise, grounded ONLY in the registry);
    optional LLM fallback via an injected callable so the engine stays free of
    any specific LLM SDK.
    """

    def __init__(self, registry: list[dict], llm_fn=None) -> None:
        self.registry = registry
        self.llm_fn = llm_fn  # optional: (prompt:str) -> str
        self.alias_index = self._build_alias_index(registry)
        self._concept_list = "\n".join(
            f"- {e['ontology_label']} (aliases: {e.get('search_aliases', '')})"
            for e in registry
            if e.get("entity_type") == "property"
        )

    @staticmethod
    def _build_alias_index(registry: list[dict]) -> dict[str, dict]:
        idx: dict[str, dict] = {}
        for entry in registry:
            keys = [entry["ontology_label"].lower().strip()]
            if entry.get("search_aliases"):
                keys += [a.strip().lower() for a in entry["search_aliases"].split("|") if a.strip()]
            for k in keys:
                existing = idx.get(k)
                if existing is None:
                    idx[k] = entry
                elif existing.get("entity_type") == "class" and entry.get("entity_type") == "property":
                    idx[k] = entry  # property wins over class for shared alias
        return idx

    def extract_by_keywords(self, question: str) -> list[dict]:
        q = question.lower()
        matched, seen = [], set()
        for alias in sorted(self.alias_index, key=len, reverse=True):
            entry = self.alias_index[alias]
            if alias in q and entry["ontology_uri"] not in seen:
                matched.append(entry)
                seen.add(entry["ontology_uri"])
        return matched

    def extract_by_llm(self, question: str) -> list[str]:
        if not self.llm_fn:
            return []
        prompt = (
            "You are a concept extraction assistant. Identify which of the "
            "following ontology concepts are referenced in the question. Return "
            "ONLY a JSON array of concept labels.\n\n"
            f"Available concepts:\n{self._concept_list}\n\nQuestion: {question}\n\n"
            "JSON array:"
        )
        try:
            content = (self.llm_fn(prompt) or "").strip()
            if content.startswith("["):
                return json.loads(content)
            if "```" in content:
                block = content.split("```")[1].strip()
                if block.startswith("json"):
                    block = block[4:].strip()
                return json.loads(block)
        except Exception as e:  # pragma: no cover
            print(f"[ConceptExtractor] LLM fallback failed: {e}")
        return []

    def extract(self, question: str) -> list[dict]:
        kw = self.extract_by_keywords(question)
        if len(kw) >= 2:
            return kw
        seen = {m["ontology_uri"] for m in kw}
        extra = []
        for label in self.extract_by_llm(question):
            e = self.alias_index.get(label.lower().strip())
            if e and e["ontology_uri"] not in seen:
                extra.append(e)
                seen.add(e["ontology_uri"])
        return kw + extra


# --------------------------------------------------------------------------- #
# SQL generation (generic — base table/join key from descriptor + registry)
# --------------------------------------------------------------------------- #
class SqlGenerator:
    """JOIN-aware SQL builder driven by the descriptor (no hardcoded schema)."""

    DEFAULT_LIMIT = 100

    def __init__(self, source: GraphSource) -> None:
        self.source = source
        self.schema_fqn = f"{source.backend.catalog}.{source.backend.schema}"
        self.join_key = source.backend.universal_join_key

    def _pick_base_table(self, tables_needed: dict[str, str]) -> str:
        # Prefer a table whose join_key == the universal join key; else first.
        for tbl, jk in tables_needed.items():
            if jk == self.join_key:
                return tbl
        return next(iter(tables_needed))

    def generate(
        self,
        select_concepts: list[dict],
        filter_concepts: Optional[list[dict]] = None,
        filter_values: Optional[dict] = None,
        aggregate: bool = False,
        limit: Optional[int] = None,
    ) -> str:
        filter_concepts = filter_concepts or []
        filter_values = filter_values or {}
        limit = limit or self.DEFAULT_LIMIT

        all_concepts = select_concepts + filter_concepts
        tables_needed: dict[str, str] = {}
        for c in all_concepts:
            tables_needed.setdefault(c["uc_table"], c["join_key"])
        if not tables_needed:
            raise ValueError("No tables resolved from concepts")

        base_tbl = self._pick_base_table(tables_needed)
        aliases = {tbl: f"t{i}" for i, tbl in enumerate(tables_needed)}
        base_alias = aliases[base_tbl]

        # SELECT
        select_parts: list[str] = []
        for c in select_concepts:
            col = c.get("uc_column")
            if col:
                a = aliases[c["uc_table"]]
                label = re.sub(r"[^A-Za-z0-9_]", "_", c["ontology_label"])
                if aggregate and c.get("is_aggregatable"):
                    select_parts.append(f"SUM({a}.{col}) AS total_{label}")
                else:
                    select_parts.append(f"{a}.{col} AS {label}")
        if not select_parts:
            select_parts = [f"{base_alias}.*"]

        # FROM + JOINs
        from_clause = f"{self.schema_fqn}.{base_tbl} AS {base_alias}"
        join_clauses = []
        for tbl, jk in tables_needed.items():
            if tbl == base_tbl:
                continue
            a = aliases[tbl]
            join_clauses.append(
                f"LEFT JOIN {self.schema_fqn}.{tbl} AS {a} "
                f"ON {a}.{jk} = {base_alias}.{jk}"
            )

        # WHERE (parameterized-ish; values escaped for single quotes)
        where_parts = []
        for c in filter_concepts:
            label = c["ontology_label"]
            if label in filter_values:
                a = aliases[c["uc_table"]]
                col = c["uc_column"]
                val = filter_values[label]
                if isinstance(val, str):
                    safe = val.replace("'", "''")
                    where_parts.append(f"{a}.{col} ILIKE '%{safe}%'")
                elif isinstance(val, (int, float)):
                    where_parts.append(f"{a}.{col} = {val}")

        # GROUP BY
        group_by = []
        if aggregate:
            for c in select_concepts:
                if c.get("uc_column") and not c.get("is_aggregatable"):
                    group_by.append(f"{aliases[c['uc_table']]}.{c['uc_column']}")

        newline = ",\n  "
        sql = f"SELECT\n  {newline.join(select_parts)}\n"
        sql += f"FROM {from_clause}\n"
        for jc in join_clauses:
            sql += jc + "\n"
        if where_parts:
            sql += "WHERE " + " AND ".join(where_parts) + "\n"
        if group_by:
            sql += "GROUP BY " + ", ".join(group_by) + "\n"
        sql += f"LIMIT {limit}"
        return sql


# --------------------------------------------------------------------------- #
# Engine
# --------------------------------------------------------------------------- #
class OMDAEngine:
    """End-to-end generic engine for ONE GraphSource.

    Construct with a GraphSource + a BackendAdapter (loads that source's
    registry). Call .answer(question) to get {sql, concepts, results, ...}.
    """

    FILTER_PREPS = r"(?:with|for|by|from|where|named|called|in|in the)"

    def __init__(self, source: GraphSource, adapter: BackendAdapter, llm_fn=None) -> None:
        self.source = source
        self.adapter = adapter
        self.registry = adapter.load_registry()
        self.extractor = ConceptExtractor(self.registry, llm_fn=llm_fn)
        self.generator = SqlGenerator(source)

    def _all_aliases(self, concepts: list[dict]) -> set[str]:
        s: set[str] = set()
        for c in concepts:
            s.add(c["ontology_label"].lower())
            for a in (c.get("search_aliases") or "").lower().split("|"):
                if a.strip():
                    s.add(a.strip())
        return s

    def _detect_filters(self, question: str, concepts: list[dict]):
        select_c, filter_c, filter_v = [], [], {}
        q = question.lower()
        all_aliases = self._all_aliases(concepts)

        for concept in concepts:
            if concept.get("entity_type") == "class":
                continue
            aliases = [concept["ontology_label"].lower()]
            for a in (concept.get("search_aliases") or "").lower().split("|"):
                if a.strip():
                    aliases.append(a.strip())
            aliases.sort(key=len, reverse=True)

            found = False
            for alias in aliases:
                pat = rf'{self.FILTER_PREPS}\s+{re.escape(alias)}\s+([A-Za-z0-9][A-Za-z0-9 _-]{{0,40}})'
                m = re.search(pat, q)
                if m:
                    val = m.group(1).strip()
                    for other in sorted(all_aliases, key=len, reverse=True):
                        if other in val and other != alias:
                            val = val[: val.index(other)].strip()
                    for stop in (" and", " or", " with", " for", " in", " from", " where"):
                        if val.endswith(stop):
                            val = val[: val.rindex(stop)].strip()
                    val = val.strip(" ?.,")
                    if val and len(val) > 1 and val not in all_aliases:
                        filter_c.append(concept)
                        filter_v[concept["ontology_label"]] = val
                        found = True
                        break
            if not found:
                select_c.append(concept)
        return select_c, filter_c, filter_v

    def answer(self, question: str, limit: int = 100, dry_run: bool = False) -> dict[str, Any]:
        concepts = self.extractor.extract(question)
        if not concepts:
            return {
                "graph_source_id": self.source.graph_source_id,
                "question": question,
                "concepts": [],
                "sql": None,
                "error": "No ontology concepts could be identified in the question.",
            }

        select_c, filter_c, filter_v = self._detect_filters(question, concepts)
        if not select_c:
            # Fall back to a few base properties of the source's base table.
            base_props = [
                e for e in self.registry
                if e.get("entity_type") == "property"
                and e.get("join_key") == self.source.backend.universal_join_key
            ]
            select_c = base_props[:5]

        sql = self.generator.generate(
            select_concepts=select_c,
            filter_concepts=filter_c,
            filter_values=filter_v,
            limit=limit,
        )

        out: dict[str, Any] = {
            "graph_source_id": self.source.graph_source_id,
            "question": question,
            "concepts": [c["ontology_label"] for c in concepts],
            "select_columns": [c["ontology_label"] for c in select_c],
            "filters": filter_v,
            "sql": sql,
        }
        if dry_run:
            return out

        try:
            res = self.adapter.execute_sql(sql, limit=limit)
            out["row_count"] = res["row_count"]
            out["columns"] = res["columns"]
            out["rows"] = res["rows"]
        except Exception as e:
            out["error"] = str(e)
        return out
