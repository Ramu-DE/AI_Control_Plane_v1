"""GraphSource descriptor — the per-BU configuration seam.

A GraphSource descriptor is the ONE thing that differs per Business Unit /
dataset. Everything else (the engine, the build job, AgentControl routing) is
generic and driven by this descriptor. Add a new BU tomorrow = add a new
descriptor + run the build job + point a serving endpoint. No engine code change.

The descriptor is intentionally backend-pluggable (UC today; Qdrant / Bedrock KB
/ warehouse later via the same shape) and ontology-pluggable (Neptune today).

This module is dependency-free (stdlib only) so it imports in any runtime:
Databricks, a plain Python service, or the AgentControl build tooling.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from typing import Any, Optional


# --------------------------------------------------------------------------- #
# Descriptor sub-structures
# --------------------------------------------------------------------------- #
@dataclass
class OntologySource:
    """Where the ontology (schema: classes/properties/relationships) lives.

    `type` selects the ontology adapter used by the build plane. `neptune`
    today; `rdf-file` / `rdflib` could be added without touching the engine.
    """

    type: str  # "neptune" | "rdf-file" | ...
    sparql_url: Optional[str] = None       # Neptune /sparql endpoint
    graph_uri: Optional[str] = None        # named graph URI
    namespace: Optional[str] = None        # ontology namespace prefix (ma#)
    # Auth hint for the ontology endpoint (resolved at runtime, never stored raw)
    auth: str = "sigv4-assume-role"        # "sigv4-assume-role" | "none"
    role_arn: Optional[str] = None
    region: str = "us-east-1"


@dataclass
class BackendSource:
    """Where the DATA lives + where the mapping registry for this source is.

    `type` selects the data adapter used by the query engine. `databricks-uc`
    today; `qdrant` / `bedrock-kb` / `warehouse` later via the adapter seam.
    """

    type: str  # "databricks-uc" | "qdrant" | "bedrock-kb" | "warehouse"
    # Databricks / Unity Catalog
    catalog: Optional[str] = None
    schema: Optional[str] = None
    registry_table: Optional[str] = None       # fully-qualified mapping table
    universal_join_key: str = "contract_key"   # default join key for this source
    vector_index: Optional[str] = None         # Databricks Vector Search index
    vector_endpoint: Optional[str] = None
    # Generic/future backends
    endpoint: Optional[str] = None             # e.g. Qdrant cluster URL
    collection: Optional[str] = None


@dataclass
class GraphSource:
    """One governed Graph Source = one BU's ontology + dataset + registry.

    Stored/managed in AgentControl (control plane). Passed to the query engine
    by `graph_source_id`; the engine loads the descriptor and runs generically.
    """

    graph_source_id: str
    bu: str
    display_name: str
    ontology: OntologySource
    backend: BackendSource
    llm_endpoint: str                       # Foundation Model / serving endpoint
    query_engine_url: Optional[str] = None  # Databricks Model Serving invocations URL
    description: str = ""
    # Free-form tags for governance/routing (region, sensitivity, tier, ...)
    tags: dict[str, str] = field(default_factory=dict)
    version: str = "1.0.0"

    # ----------------------------------------------------------------- #
    # Serialization
    # ----------------------------------------------------------------- #
    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "GraphSource":
        ont = d.get("ontology", {}) or {}
        bk = d.get("backend", {}) or {}
        return cls(
            graph_source_id=d["graph_source_id"],
            bu=d["bu"],
            display_name=d.get("display_name", d["graph_source_id"]),
            ontology=OntologySource(**ont),
            backend=BackendSource(**bk),
            llm_endpoint=d["llm_endpoint"],
            query_engine_url=d.get("query_engine_url"),
            description=d.get("description", ""),
            tags=d.get("tags", {}) or {},
            version=d.get("version", "1.0.0"),
        )

    @classmethod
    def from_json(cls, text: str) -> "GraphSource":
        return cls.from_dict(json.loads(text))

    # ----------------------------------------------------------------- #
    # Validation — fail fast with a clear, aggregated message
    # ----------------------------------------------------------------- #
    def validate(self) -> list[str]:
        """Return a list of problems (empty = valid)."""
        errs: list[str] = []
        if not self.graph_source_id:
            errs.append("graph_source_id is required")
        if not self.bu:
            errs.append("bu is required")
        if not self.llm_endpoint:
            errs.append("llm_endpoint is required")

        # Ontology
        if self.ontology.type == "neptune":
            if not self.ontology.sparql_url:
                errs.append("ontology.sparql_url is required for type 'neptune'")
            if not self.ontology.graph_uri:
                errs.append("ontology.graph_uri is required for type 'neptune'")
            if not self.ontology.namespace:
                errs.append("ontology.namespace is required for type 'neptune'")
        elif self.ontology.type not in ("rdf-file", "none"):
            errs.append(f"unsupported ontology.type '{self.ontology.type}'")

        # Backend
        if self.backend.type == "databricks-uc":
            for fld in ("catalog", "schema", "registry_table"):
                if not getattr(self.backend, fld):
                    errs.append(f"backend.{fld} is required for type 'databricks-uc'")
        elif self.backend.type in ("qdrant", "bedrock-kb", "warehouse"):
            # Seam for future backends — only shape-check minimally for now.
            if not self.backend.registry_table and self.backend.type == "warehouse":
                errs.append("backend.registry_table is required for type 'warehouse'")
        else:
            errs.append(f"unsupported backend.type '{self.backend.type}'")

        return errs

    def require_valid(self) -> "GraphSource":
        errs = self.validate()
        if errs:
            raise ValueError(
                "Invalid GraphSource descriptor:\n  - " + "\n  - ".join(errs)
            )
        return self


# --------------------------------------------------------------------------- #
# Registry of descriptors (control-plane side resolver)
# --------------------------------------------------------------------------- #
class GraphSourceRegistry:
    """In-memory resolver of graph_source_id -> GraphSource.

    AgentControl owns the authoritative store (DB); this class is the shared
    loading/validation logic reused by the engine, the build job, and tests.
    Load from a dict, a JSON string, or a directory of JSON files.
    """

    def __init__(self) -> None:
        self._sources: dict[str, GraphSource] = {}

    def register(self, source: GraphSource) -> None:
        source.require_valid()
        self._sources[source.graph_source_id] = source

    def get(self, graph_source_id: str) -> GraphSource:
        if graph_source_id not in self._sources:
            raise KeyError(
                f"Unknown graph_source_id '{graph_source_id}'. "
                f"Known: {sorted(self._sources)}"
            )
        return self._sources[graph_source_id]

    def ids(self) -> list[str]:
        return sorted(self._sources)

    # --- loaders ---
    @classmethod
    def from_dicts(cls, items: list[dict[str, Any]]) -> "GraphSourceRegistry":
        reg = cls()
        for d in items:
            reg.register(GraphSource.from_dict(d))
        return reg

    @classmethod
    def from_json_file(cls, path: str) -> "GraphSourceRegistry":
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        items = data if isinstance(data, list) else [data]
        return cls.from_dicts(items)

    @classmethod
    def from_dir(cls, directory: str) -> "GraphSourceRegistry":
        import os

        reg = cls()
        for name in sorted(os.listdir(directory)):
            if name.endswith(".json"):
                with open(os.path.join(directory, name), encoding="utf-8") as fh:
                    reg.register(GraphSource.from_dict(json.load(fh)))
        return reg
