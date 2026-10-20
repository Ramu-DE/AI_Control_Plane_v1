"""Graph Utility — generic, multi-BU Ontology-Mediated Data Access (OMDA).

Public API:
    GraphSource, GraphSourceRegistry   — per-BU descriptor + resolver
    OMDAEngine                          — generic query engine (by graph_source_id)
    make_adapter                        — backend adapter factory (UC today)
"""
from .descriptor import GraphSource, OntologySource, BackendSource, GraphSourceRegistry
from .backends import BackendAdapter, DatabricksUCAdapter, make_adapter
from .engine import OMDAEngine, ConceptExtractor, SqlGenerator
from .registry_build import (
    fetch_ontology_schema,
    derive_mappings,
    merge_registry,
    smoke_test,
    emit_descriptor,
    run_build,
)

__all__ = [
    "GraphSource",
    "OntologySource",
    "BackendSource",
    "GraphSourceRegistry",
    "BackendAdapter",
    "DatabricksUCAdapter",
    "make_adapter",
    "OMDAEngine",
    "ConceptExtractor",
    "SqlGenerator",
    "fetch_ontology_schema",
    "derive_mappings",
    "merge_registry",
    "smoke_test",
    "emit_descriptor",
    "run_build",
]

__version__ = "0.1.0"
