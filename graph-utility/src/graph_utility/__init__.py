"""Graph Utility — generic, multi-BU Ontology-Mediated Data Access (OMDA).

Two layers coexist:

LEGACY (preserved for OMDAEngine compatibility):
    GraphSource, GraphSourceRegistry   — per-BU descriptor + resolver
    OMDAEngine                          — generic query engine (by graph_source_id)
    make_adapter                        — backend adapter factory (UC today)

PRECISION-FIRST (new vertical slice — no guessed mappings, approval-gated):
    discovery.*     — typed, data-agnostic metadata + bounded masked profiles
    DataAdapter     — structured data seam (discover + execute compiled query)
    Retriever       — provider-neutral passage retrieval seam
    mapping.*       — MappingProposal, approve/reject, publish_mappings, R2RML
    planner.*       — SemanticQueryPlan, SemanticPlanner, SqlCompiler, CompiledQuery
"""
# --- legacy ---
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

# --- precision-first ---
from .discovery import (
    LogicalType,
    KeyType,
    ColumnMetadata,
    KeyMetadata,
    JoinMetadata,
    TableMetadata,
    ColumnProfile,
    TableProfile,
    DiscoveryResult,
    mask_value,
    MAX_SAMPLE_VALUES,
)
from .data_adapter import DataAdapter, InMemoryDataAdapter, InMemoryTable, QueryResult
from .retriever import (
    Retriever,
    RetrievalRequest,
    Passage,
    RetrieverCapabilities,
    FieldMapping,
    InMemoryRetriever,
    DatabricksVectorRetriever,
    federate,
    dedupe,
    rrf_fuse,
)
from .mapping import (
    MappingProposal,
    ProposalStatus,
    ProposalKind,
    Evidence,
    ValidationIssue,
    PublishedMapping,
    PublishedMappingSet,
    propose_mappings,
    approve,
    reject,
    publish_mappings,
    to_r2rml,
    R2RMLError,
    name_similarity,
    discovery_fingerprint,
    UnapprovedPublishError,
    AutoApprovalPolicy,
    AutoApprovalResult,
    auto_approve,
    auto_approval_verdict,
    was_auto_approved,
    AUTO_APPROVE_MIN_CONFIDENCE,
    NAME_SIMILARITY_MAX_CONFIDENCE,
    HARD_EVIDENCE_KINDS,
)

# --- ontology-first: supplied ontology -> real graph ---
from .ontology import NeptuneOntologyClient, make_ontology_client
from .ontology_file import (
    RdfFileOntologyClient,
    OntologyFileError,
    infer_format,
    is_meta_term,
)
from .materialize import (
    MaterializationError,
    MaterializationResult,
    materialize_to_nquads,
    write_nquads,
    drop_graph_sparql,
    mint_subject_iri,
    typed_literal,
    escape_literal,
    iri_segment,
    DEFAULT_GRAPH_PREFIX,
)
from .planner import (
    Projection,
    Filter,
    Aggregation,
    JoinPath,
    SemanticQueryPlan,
    CompiledQuery,
    SemanticPlanner,
    SqlCompiler,
    ConceptRef,
    AggKind,
    FilterOp,
    PlanningError,
    UnmappedConceptError,
    AmbiguousConceptError,
    CompileError,
)

# --- agentic hybrid-RAG (router + critic + pipeline) ---
from .router import (
    QuestionKind,
    Route,
    RerouteSignal,
    DEFAULT_RETRIEVER,
    ESCALATION_ORDER,
    classify,
    reroute,
)
from .critic import (
    Verdict,
    CriticThresholds,
    evaluate,
)
from .pipeline import (
    RetrieverRegistry,
    Attempt,
    PipelineResult,
    Synthesizer,
    run,
)

__all__ = [
    # legacy
    "GraphSource", "OntologySource", "BackendSource", "GraphSourceRegistry",
    "BackendAdapter", "DatabricksUCAdapter", "make_adapter",
    "OMDAEngine", "ConceptExtractor", "SqlGenerator",
    "fetch_ontology_schema", "derive_mappings", "merge_registry",
    "smoke_test", "emit_descriptor", "run_build",
    # discovery
    "LogicalType", "KeyType", "ColumnMetadata", "KeyMetadata", "JoinMetadata",
    "TableMetadata", "ColumnProfile", "TableProfile", "DiscoveryResult",
    "mask_value", "MAX_SAMPLE_VALUES",
    # data adapter
    "DataAdapter", "InMemoryDataAdapter", "InMemoryTable", "QueryResult",
    # retriever
    "Retriever", "RetrievalRequest", "Passage", "RetrieverCapabilities",
    "FieldMapping", "InMemoryRetriever", "DatabricksVectorRetriever",
    "federate", "dedupe", "rrf_fuse",
    # mapping
    "MappingProposal", "ProposalStatus", "ProposalKind", "Evidence",
    "ValidationIssue", "PublishedMapping", "PublishedMappingSet",
    "propose_mappings", "approve", "reject", "publish_mappings", "to_r2rml",
    "name_similarity", "discovery_fingerprint", "UnapprovedPublishError",
    "R2RMLError",
    # threshold auto-approval
    "AutoApprovalPolicy", "AutoApprovalResult", "auto_approve",
    "auto_approval_verdict", "was_auto_approved",
    "AUTO_APPROVE_MIN_CONFIDENCE", "NAME_SIMILARITY_MAX_CONFIDENCE",
    "HARD_EVIDENCE_KINDS",
    # ontology-first ingest + materialisation
    "NeptuneOntologyClient", "make_ontology_client", "RdfFileOntologyClient",
    "OntologyFileError", "infer_format", "is_meta_term",
    "MaterializationError", "MaterializationResult", "materialize_to_nquads",
    "write_nquads", "drop_graph_sparql", "mint_subject_iri", "typed_literal",
    "escape_literal", "iri_segment", "DEFAULT_GRAPH_PREFIX",
    # planner
    "Projection", "Filter", "Aggregation", "JoinPath", "SemanticQueryPlan",
    "CompiledQuery", "SemanticPlanner", "SqlCompiler", "ConceptRef", "AggKind",
    "FilterOp", "PlanningError", "UnmappedConceptError", "AmbiguousConceptError",
    "CompileError",
    # agentic hybrid-RAG
    "QuestionKind", "Route", "RerouteSignal", "DEFAULT_RETRIEVER",
    "ESCALATION_ORDER", "classify", "reroute",
    "Verdict", "CriticThresholds", "evaluate",
    "RetrieverRegistry", "Attempt", "PipelineResult", "Synthesizer", "run",
]

__version__ = "0.2.0"
