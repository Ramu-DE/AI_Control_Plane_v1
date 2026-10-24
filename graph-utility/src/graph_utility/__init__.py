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
    term_match,
    discovery_fingerprint,
    UnapprovedPublishError,
    APPROVAL_PROFILES,
    approval_policy,
    AutoApprovalPolicy,
    AutoApprovalResult,
    auto_approve,
    auto_approval_verdict,
    was_auto_approved,
    AUTO_APPROVE_MIN_CONFIDENCE,
    NAME_SIMILARITY_MAX_CONFIDENCE,
    HARD_EVIDENCE_KINDS,
    SUBJECT_KEY_EVIDENCE,
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
    materialize_graph,
    materialize_to_nquads,
    provenance_quads,
    serialize_quads,
    obj_iri,
    obj_literal,
    is_iri,
    write_nquads,
    drop_graph_sparql,
    mint_subject_iri,
    typed_literal,
    escape_literal,
    iri_segment,
    DEFAULT_GRAPH_PREFIX,
    ANSI_DIALECT,
    DATABRICKS_DIALECT,
    SqlDialect,
)
from .overlap import (
    JoinOverlap,
    UniquenessProof,
    verify_uniqueness,
    enrich_classes_with_uniqueness,
    MIN_ROWS_FOR_UNIQUENESS_PROOF,
    measure_join_overlap,
    candidate_column_sets,
    enrich_relationships_with_overlap,
    MIN_CONTAINMENT_FOR_AUTO,
    DEFAULT_PROBE_LIMIT,
)
from .reason import (
    EntailmentReport,
    Violation,
    entail,
    axioms_fingerprint,
    prepare_tbox,
    validate_constraints,
    RDF_TYPE,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_MAX_INFERRED,
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

# Graph targets (Neptune / Neo4j / OntoBricks) + the R2RML Turtle handoff, and
# the two-arm mapping comparison that justifies the measured path.
from .ontobricks import (
    GraphTargetCapabilities,
    NEO4J,
    NEPTUNE,
    ONTOBRICKS,
    R2RMLDocument,
    TARGETS,
    target_capabilities,
    to_r2rml_turtle,
)
from .compare import (
    ARM_MEASURED,
    ARM_METADATA,
    ArmResult,
    Comparison,
    compare,
    score_arm,
)

# One governed build (materialise + entail + validate + gate) and the
# build-to-build diff. `build_graph` is the supported entry point: the
# soundness gates belong to it, not to whichever script a caller copied.
from .build import (
    BuildRefused,
    BuildReport,
    build_graph,
    describe_build,
)
from .materialize import (
    GraphDiff,
    RDFS_LABEL,
    diff_graphs,
    label_candidates,
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
    # graph targets + R2RML handoff
    # one governed build + diff + labels
    "build_graph", "BuildReport", "BuildRefused", "describe_build",
    "diff_graphs", "GraphDiff", "label_candidates", "RDFS_LABEL",
    "GraphTargetCapabilities", "TARGETS", "target_capabilities",
    "ONTOBRICKS", "NEPTUNE", "NEO4J", "to_r2rml_turtle", "R2RMLDocument",
    # mapping-method comparison
    "compare", "Comparison", "ArmResult", "score_arm",
    "ARM_METADATA", "ARM_MEASURED",
    "name_similarity", "term_match", "discovery_fingerprint", "UnapprovedPublishError",
    "R2RMLError",
    # threshold auto-approval
    "APPROVAL_PROFILES", "approval_policy",
    "AutoApprovalPolicy", "AutoApprovalResult", "auto_approve",
    "auto_approval_verdict", "was_auto_approved",
    "AUTO_APPROVE_MIN_CONFIDENCE", "NAME_SIMILARITY_MAX_CONFIDENCE",
    "HARD_EVIDENCE_KINDS",
    # ontology-first ingest + materialisation
    "NeptuneOntologyClient", "make_ontology_client", "RdfFileOntologyClient",
    "OntologyFileError", "infer_format", "is_meta_term",
    "MaterializationError", "MaterializationResult", "materialize_graph",
    "materialize_to_nquads", "provenance_quads", "serialize_quads",
    "obj_iri", "obj_literal", "is_iri",
    "write_nquads", "drop_graph_sparql", "mint_subject_iri", "typed_literal",
    "escape_literal", "iri_segment", "DEFAULT_GRAPH_PREFIX",
    "ANSI_DIALECT", "DATABRICKS_DIALECT", "SqlDialect",
    # value-overlap profiling
    "JoinOverlap", "measure_join_overlap", "candidate_column_sets",
    "enrich_relationships_with_overlap", "MIN_CONTAINMENT_FOR_AUTO",
    "DEFAULT_PROBE_LIMIT", "UniquenessProof", "verify_uniqueness",
    "enrich_classes_with_uniqueness", "MIN_ROWS_FOR_UNIQUENESS_PROOF",
    "SUBJECT_KEY_EVIDENCE",
    # reasoning + constraint validation
    "EntailmentReport", "Violation", "entail", "prepare_tbox",
    "validate_constraints", "RDF_TYPE", "axioms_fingerprint",
    "DEFAULT_MAX_ITERATIONS", "DEFAULT_MAX_INFERRED",
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
