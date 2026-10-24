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

    `type` selects the ontology adapter used by the build plane.

      neptune   AWS Neptune SPARQL endpoint (SigV4 + AssumeRole)
      rdfox     RDFox datastore over its REST/SPARQL endpoint. Chosen when the
                ontology needs *reasoning*: RDFox materialises Datalog/OWL 2 RL
                rules incrementally, so a re-published mapping updates the
                derived graph without re-deriving it wholesale. Commercial
                licence; in-memory, so the graph is RAM-bound.
      rdf-file  a local Turtle/RDF file (no server)
      none      the backend graph IS the ontology (e.g. Neo4j)
    """

    type: str  # "neptune" | "rdfox" | "rdf-file" | "none"
    sparql_url: Optional[str] = None       # Neptune /sparql endpoint
    graph_uri: Optional[str] = None        # named graph URI
    namespace: Optional[str] = None        # ontology namespace prefix (ma#)
    # Auth hint for the ontology endpoint (resolved at runtime, never stored raw)
    auth: str = "sigv4-assume-role"        # "sigv4-assume-role" | "none" | "api-key-ref"
    role_arn: Optional[str] = None
    region: str = "us-east-1"
    # --- rdf-file only ------------------------------------------------------
    # Path to a local RDF document (Turtle/N-Triples/N-Quads/RDF-XML/JSON-LD).
    # Chosen when the ontology is SUPPLIED rather than queried: no VPC, no
    # endpoint, and the same file can be diffed and version-controlled.
    file_path: Optional[str] = None
    # Serialization hint. None = infer from the file extension.
    file_format: Optional[str] = None
    # --- RDFox only ---------------------------------------------------------
    # Base URL of the RDFox endpoint, e.g. https://rdfox.internal:12110
    rdfox_url: Optional[str] = None
    # Datastore name within that server.
    rdfox_datastore: Optional[str] = None
    # Name of an env var / secret REFERENCE holding the API key. Never a key.
    rdfox_auth_env_var: Optional[str] = None


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
    # Legacy single-join-key seam for the databricks-uc engine ONLY. The
    # precision build/plan path derives joins from DISCOVERED keys per
    # relationship and does NOT use this field. It is intentionally EMPTY by
    # default — a generic BU must set it explicitly if (and only if) it relies
    # on the legacy universal-join-key engine. It must never silently inherit
    # another tenant's join key.
    universal_join_key: str = ""
    vector_index: Optional[str] = None         # Databricks Vector Search index
    vector_endpoint: Optional[str] = None
    # Descriptor-driven vector field mapping (replaces any hardcoded columns).
    # When unset, the adapter returns no columns rather than assuming a schema.
    vector_text_field: Optional[str] = None          # normalized text column
    vector_id_field: Optional[str] = None            # normalized id column
    vector_metadata_fields: list = field(default_factory=list)  # passthrough columns
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
    # Where a materialized graph LANDS: "neptune" | "neo4j" | "ontobricks".
    #
    # Optional, and None means "emit N-Quads and let an operator load them",
    # which is what every existing descriptor relied on — so this cannot be
    # required without invalidating them.
    #
    # It is declared rather than inferred because the targets are not
    # interchangeable, and the differences bite at BUILD time, not at load
    # time: only Neptune has named graphs (so only Neptune can scope and drop
    # one build), and only Neptune serves full SPARQL. See
    # `ontobricks.TARGETS` for the capability matrix the build plane checks
    # against before it starts.
    graph_target: Optional[str] = None
    description: str = ""
    # Free-form tags for governance/routing (region, sensitivity, tier, ...)
    tags: dict[str, str] = field(default_factory=dict)
    version: str = "1.0.0"
    # The control-plane tenant (Takeda BU/BF) that owns this source, e.g.
    # "fn-rnd". `bu` stays as the display/legacy field; when this is unset the
    # control plane falls back to `bu`, which is how a free-text BU silently
    # became a tenant that does not exist — so new descriptors should set it.
    tenant_id: Optional[str] = None
    # Which `mapping.APPROVAL_PROFILES` entry automates this source's mapping
    # review: "gxp-strict" | "standard" | "exploratory". None = "standard".
    approval_profile: Optional[str] = None

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
            graph_target=d.get("graph_target"),
            description=d.get("description", ""),
            tags=d.get("tags", {}) or {},
            version=d.get("version", "1.0.0"),
            tenant_id=d.get("tenant_id"),
            approval_profile=d.get("approval_profile"),
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
        if self.approval_profile is not None:
            from .mapping import APPROVAL_PROFILES

            if self.approval_profile not in APPROVAL_PROFILES:
                errs.append(
                    f"unsupported approval_profile '{self.approval_profile}'; "
                    f"expected one of {sorted(APPROVAL_PROFILES)}"
                )

        # Graph target. Imported lazily so descriptor.py keeps importing
        # cleanly on its own — `ontobricks` pulls in the mapping module, and a
        # descriptor must stay loadable in tooling that has no use for it.
        if self.graph_target is not None:
            from .ontobricks import TARGETS

            if self.graph_target not in TARGETS:
                errs.append(
                    f"unsupported graph_target '{self.graph_target}'; "
                    f"expected one of {sorted(TARGETS)} (or omit it to emit "
                    f"N-Quads for manual loading)"
                )

        # Ontology
        if self.ontology.type == "neptune":
            if not self.ontology.sparql_url:
                errs.append("ontology.sparql_url is required for type 'neptune'")
            if not self.ontology.graph_uri:
                errs.append("ontology.graph_uri is required for type 'neptune'")
            if not self.ontology.namespace:
                errs.append("ontology.namespace is required for type 'neptune'")
        elif self.ontology.type == "rdfox":
            # Reasoning engine: needs an endpoint + a datastore to query.
            if not self.ontology.rdfox_url:
                errs.append("ontology.rdfox_url is required for type 'rdfox'")
            if not self.ontology.rdfox_datastore:
                errs.append("ontology.rdfox_datastore is required for type 'rdfox'")
            if not self.ontology.namespace:
                errs.append("ontology.namespace is required for type 'rdfox'")
        elif self.ontology.type == "rdf-file":
            # A supplied ontology needs a path and a namespace; without the
            # namespace we cannot tell this source's terms from imported ones.
            if not self.ontology.file_path:
                errs.append("ontology.file_path is required for type 'rdf-file'")
            if not self.ontology.namespace:
                errs.append("ontology.namespace is required for type 'rdf-file'")
        elif self.ontology.type != "none":
            errs.append(f"unsupported ontology.type '{self.ontology.type}'")

        # Backend
        if self.backend.type == "databricks-uc":
            for fld in ("catalog", "schema", "registry_table"):
                if not getattr(self.backend, fld):
                    errs.append(f"backend.{fld} is required for type 'databricks-uc'")
            # The legacy databricks-uc engine builds JOINs from this single key,
            # so it must be supplied explicitly. There is NO default — inheriting
            # another tenant's join key would silently produce wrong rows.
            if not self.backend.universal_join_key:
                errs.append(
                    "backend.universal_join_key is required for type 'databricks-uc' "
                    "(no default: set this source's own join key)"
                )
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
