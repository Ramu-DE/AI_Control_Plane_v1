"""Mapping proposals, approval gate, and publication (precision path).

Replaces the legacy "derive a registry row and treat it as truth" behavior with
a review pipeline that is honest about uncertainty:

    MappingProposal   — a CANDIDATE mapping (ontology concept -> asset/column or
                        a relationship/join), carrying evidence, confidence,
                        validation issues, a status, and version/fingerprints.
    propose_mappings  — turn discovery + ontology schema into proposals. Name
                        similarity may PROPOSE but may NEVER auto-approve.
                        Fetched ontology relationships yield relationship/join
                        proposals. No universal-join-key assumption.
    approve / reject  — explicit, human-gated status transitions.
    publish_mappings  — compile ONLY approved + valid proposals into a
                        PublishedMappingSet (runtime registry) and an
                        R2RML-compatible artifact with provenance. Unapproved or
                        invalid rows can NEVER publish.

stdlib only.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional

from .discovery import DiscoveryResult, JoinMetadata, LogicalType


MAPPING_VERSION = "1.0"


class ProposalStatus(str, Enum):
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"


class ProposalKind(str, Enum):
    DIRECT = "direct"              # ontology property -> table.column
    CLASS = "class"               # ontology class -> table
    RELATIONSHIP = "relationship"  # ontology object-property -> join between tables


@dataclass(frozen=True)
class Evidence:
    """One justification for a proposal. Evidence is additive and auditable."""

    kind: str                     # name-similarity | type-compatibility |
                                  # ontology-relationship | key-metadata | profile
    detail: str
    weight: float = 0.0           # contribution to confidence [0..1]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class ValidationIssue:
    code: str
    message: str
    severity: str = "error"       # error blocks approval/publish; warning does not

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class MappingProposal:
    """A candidate mapping under review. Never authoritative until approved."""

    id: str
    kind: ProposalKind
    ontology_uri: str
    ontology_label: str
    ontology_type: str                        # class | datatype-property | object-property
    # Target asset. For DIRECT: table + column. For CLASS: table. For
    # RELATIONSHIP: target_table + join describe the relationship.
    target_table: Optional[str] = None
    target_column: Optional[str] = None
    join: Optional[JoinMetadata] = None
    # Discovered logical type of the target column (DIRECT proposals only). This
    # is the SINGLE authority for type-dependent planning decisions (SUM/AVG,
    # ILIKE). It is copied verbatim from discovery — never inferred from a
    # column's name.
    logical_type: LogicalType = LogicalType.UNKNOWN
    # Discovered primary-key subject columns for a CLASS proposal (the columns
    # that identify a row/subject in the mapped table). Empty for non-class
    # proposals, and empty for a class whose table has no discovered PK — in
    # that case the proposal carries a blocking `no-subject-key` issue.
    subject_columns: tuple[str, ...] = ()
    evidence: list[Evidence] = field(default_factory=list)
    confidence: float = 0.0
    validation_issues: list[ValidationIssue] = field(default_factory=list)
    status: ProposalStatus = ProposalStatus.PROPOSED
    mapping_version: str = MAPPING_VERSION
    # Provenance
    source_fingerprint: str = ""              # fingerprint of discovery inputs
    proposal_fingerprint: str = ""            # fingerprint of this proposal's identity
    approver: Optional[str] = None
    decided_at: Optional[str] = None
    notes: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.proposal_fingerprint:
            self.proposal_fingerprint = self._fingerprint()

    def _fingerprint(self) -> str:
        basis = {
            "kind": self.kind.value,
            "ontology_uri": self.ontology_uri,
            "target_table": self.target_table,
            "target_column": self.target_column,
            "logical_type": self.logical_type.value,
            "subject_columns": list(self.subject_columns),
            "join": self.join.to_dict() if self.join else None,
            "mapping_version": self.mapping_version,
        }
        raw = json.dumps(basis, sort_keys=True).encode("utf-8")
        return hashlib.sha256(raw).hexdigest()[:16]

    @property
    def has_blocking_issue(self) -> bool:
        return any(i.severity == "error" for i in self.validation_issues)

    @property
    def is_approvable(self) -> bool:
        """Approvable only if there are no blocking validation issues."""
        return not self.has_blocking_issue

    @property
    def is_publishable(self) -> bool:
        """Publishable only if APPROVED and free of blocking issues."""
        return self.status == ProposalStatus.APPROVED and not self.has_blocking_issue

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind.value,
            "ontology_uri": self.ontology_uri,
            "ontology_label": self.ontology_label,
            "ontology_type": self.ontology_type,
            "target_table": self.target_table,
            "target_column": self.target_column,
            "logical_type": self.logical_type.value,
            "subject_columns": list(self.subject_columns),
            "join": self.join.to_dict() if self.join else None,
            "evidence": [e.to_dict() for e in self.evidence],
            "confidence": round(self.confidence, 4),
            "validation_issues": [i.to_dict() for i in self.validation_issues],
            "status": self.status.value,
            "mapping_version": self.mapping_version,
            "source_fingerprint": self.source_fingerprint,
            "proposal_fingerprint": self.proposal_fingerprint,
            "approver": self.approver,
            "decided_at": self.decided_at,
            "notes": self.notes,
        }


# --------------------------------------------------------------------------- #
# Fingerprint of discovery inputs (shared provenance basis)
# --------------------------------------------------------------------------- #
def discovery_fingerprint(discovery: DiscoveryResult) -> str:
    raw = json.dumps(discovery.to_dict(), sort_keys=True).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


# --------------------------------------------------------------------------- #
# Proposer
# --------------------------------------------------------------------------- #
def _local_name(uri: str) -> str:
    if "#" in uri:
        return uri.rsplit("#", 1)[1]
    return uri.rstrip("/").rsplit("/", 1)[-1]


def _tokens(name: str) -> set[str]:
    import re
    spaced = re.sub(r"(?<!^)(?=[A-Z])", " ", name)
    spaced = re.sub(r"[^A-Za-z0-9]+", " ", spaced)
    return {t for t in spaced.lower().split() if t}


def name_similarity(a: str, b: str) -> float:
    """Jaccard token overlap in [0,1]. Pure lexical — a weak signal by design."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


# Name similarity alone must NEVER reach the approval gate. We cap its
# contribution strictly below the threshold a human approver would use.
NAME_SIMILARITY_MAX_CONFIDENCE = 0.5
_RANGE_TYPE = {
    "string": LogicalType.STRING, "decimal": LogicalType.DECIMAL,
    "double": LogicalType.DECIMAL, "float": LogicalType.DECIMAL,
    "integer": LogicalType.INTEGER, "int": LogicalType.INTEGER,
    "date": LogicalType.DATE, "datetime": LogicalType.TIMESTAMP,
    "boolean": LogicalType.BOOLEAN,
}


def _range_logical_type(rng: Optional[str]) -> LogicalType:
    if not rng:
        return LogicalType.UNKNOWN
    r = rng.lower()
    for key, lt in _RANGE_TYPE.items():
        if key in r:
            return lt
    return LogicalType.UNKNOWN


def propose_mappings(
    discovery: DiscoveryResult,
    ontology_schema: dict[str, list[dict]],
    *,
    id_prefix: str = "mp",
) -> list[MappingProposal]:
    """Produce CANDIDATE proposals from discovery + ontology schema.

    - Each ontology property is matched against every column by name similarity
      and type compatibility. Name similarity may propose; it never approves.
    - Each ontology class is matched against tables by name similarity.
    - Each ontology relationship (object property with domain+range) produces a
      RELATIONSHIP proposal with a candidate join derived from discovered keys —
      NOT from any universal join key.
    """
    src_fp = discovery_fingerprint(discovery)
    proposals: list[MappingProposal] = []
    counter = 0

    def next_id() -> str:
        nonlocal counter
        counter += 1
        return f"{id_prefix}-{counter:04d}"

    # ---- class -> table proposals (name similarity only) ----
    for c in ontology_schema.get("classes", []):
        uri = c.get("class") or c.get("entity") or ""
        if not uri:
            continue
        local = _local_name(uri)
        label = c.get("label") or local
        for t in discovery.tables:
            sim = max(name_similarity(label, t.name), name_similarity(local, t.name))
            if sim <= 0:
                continue
            conf = min(sim, NAME_SIMILARITY_MAX_CONFIDENCE)
            # The subject key for this class is the table's DISCOVERED primary
            # key. Without one, the class cannot produce stable subject IRIs, so
            # the proposal is blocked (no fabricated surrogate key).
            pk = t.primary_key()
            subject_cols = tuple(pk.columns) if pk else ()
            issues = _name_only_issues(conf)
            if not subject_cols:
                issues.append(ValidationIssue(
                    "no-subject-key",
                    f"class '{label}' -> table '{t.name}' has no discovered "
                    f"primary key; cannot mint stable subject IRIs",
                    severity="error"))
            evidence = [Evidence("name-similarity",
                                 f"class '{label}' ~ table '{t.name}' (jaccard={sim:.2f})",
                                 weight=conf)]
            if subject_cols:
                evidence.append(Evidence(
                    "key-metadata",
                    f"subject key {list(subject_cols)} from discovered PK",
                    weight=0.2))
            proposals.append(MappingProposal(
                id=next_id(), kind=ProposalKind.CLASS,
                ontology_uri=uri, ontology_label=label, ontology_type="class",
                target_table=t.name,
                subject_columns=subject_cols,
                evidence=evidence,
                confidence=conf,
                validation_issues=issues,
                source_fingerprint=src_fp,
            ))

    # ---- property -> column proposals (name similarity + type compat) ----
    for p in ontology_schema.get("properties", []):
        uri = p.get("property") or ""
        if not uri:
            continue
        ptype = (p.get("ptype") or "").lower()
        if "object" in ptype:
            continue  # handled as relationships below
        local = _local_name(uri)
        label = p.get("label") or local
        want_lt = _range_logical_type(p.get("range"))
        for t in discovery.tables:
            for col in t.columns:
                sim = max(name_similarity(label, col.name), name_similarity(local, col.name))
                if sim <= 0:
                    continue
                evidence = [Evidence("name-similarity",
                                     f"property '{label}' ~ column '{t.name}.{col.name}' "
                                     f"(jaccard={sim:.2f})", weight=min(sim, NAME_SIMILARITY_MAX_CONFIDENCE))]
                conf = min(sim, NAME_SIMILARITY_MAX_CONFIDENCE)
                type_ok = True
                if want_lt != LogicalType.UNKNOWN and col.logical_type != LogicalType.UNKNOWN:
                    if want_lt == col.logical_type:
                        evidence.append(Evidence("type-compatibility",
                                                 f"ontology range {want_lt.value} == column {col.logical_type.value}",
                                                 weight=0.25))
                        conf = min(conf + 0.25, 0.9)
                    else:
                        type_ok = False
                issues = _name_only_issues(min(sim, NAME_SIMILARITY_MAX_CONFIDENCE))
                if not type_ok:
                    issues.append(ValidationIssue(
                        "type-mismatch",
                        f"ontology range {want_lt.value} != column type {col.logical_type.value}",
                        severity="error"))
                proposals.append(MappingProposal(
                    id=next_id(), kind=ProposalKind.DIRECT,
                    ontology_uri=uri, ontology_label=label,
                    ontology_type="datatype-property",
                    target_table=t.name, target_column=col.name,
                    logical_type=col.logical_type,
                    evidence=evidence, confidence=conf,
                    validation_issues=issues, source_fingerprint=src_fp,
                ))

    # ---- relationship -> join proposals (from ontology + discovered keys) ----
    for rel in ontology_schema.get("relationships", []):
        uri = rel.get("property") or ""
        if not uri:
            continue
        local = _local_name(uri)
        label = rel.get("label") or local
        domain, rng = rel.get("domain"), rel.get("range")
        left = _match_table(discovery, domain)
        right = _match_table(discovery, rng)
        if not left or not right:
            # Relationship references a class we couldn't resolve to a table:
            # still emit a proposal, but mark it blocking so it can't publish.
            proposals.append(MappingProposal(
                id=next_id(), kind=ProposalKind.RELATIONSHIP,
                ontology_uri=uri, ontology_label=label, ontology_type="object-property",
                evidence=[Evidence("ontology-relationship",
                                   f"relationship '{label}' domain={domain} range={rng}", weight=0.4)],
                confidence=0.0,
                validation_issues=[ValidationIssue(
                    "unresolved-relationship",
                    f"could not resolve relationship endpoints to tables "
                    f"(domain={domain}, range={rng})", severity="error")],
                source_fingerprint=src_fp,
            ))
            continue
        join = _candidate_join(left, right, label)
        issues: list[ValidationIssue] = []
        conf = 0.4
        if join is None:
            issues.append(ValidationIssue(
                "no-key-evidence",
                f"no foreign/primary key evidence to join '{left.name}' and "
                f"'{right.name}'; join must be supplied by an approver",
                severity="error"))
        else:
            conf = 0.6
        proposals.append(MappingProposal(
            id=next_id(), kind=ProposalKind.RELATIONSHIP,
            ontology_uri=uri, ontology_label=label, ontology_type="object-property",
            target_table=right.name, join=join,
            evidence=[Evidence("ontology-relationship",
                               f"relationship '{label}': {left.name} -> {right.name}", weight=0.4)]
                     + ([Evidence("key-metadata", f"join via {join.left_columns}->{join.right_columns}", 0.2)]
                        if join else []),
            confidence=conf, validation_issues=issues, source_fingerprint=src_fp,
        ))

    return proposals


def _name_only_issues(conf: float) -> list[ValidationIssue]:
    """A proposal justified ONLY by name similarity carries a non-blocking
    warning so reviewers know it needs human judgement. It never auto-approves
    (confidence is capped below any sane auto-approve threshold)."""
    if conf <= NAME_SIMILARITY_MAX_CONFIDENCE:
        return [ValidationIssue(
            "name-similarity-only",
            "candidate justified primarily by name similarity; requires review",
            severity="warning")]
    return []


def _match_table(discovery: DiscoveryResult, class_uri: Optional[str]):
    if not class_uri:
        return None
    local = _local_name(class_uri)
    best, best_sim = None, 0.0
    for t in discovery.tables:
        sim = max(name_similarity(local, t.name), name_similarity(class_uri, t.name))
        if sim > best_sim:
            best, best_sim = t, sim
    return best if best_sim > 0 else None


def _candidate_join(left, right, name) -> Optional[JoinMetadata]:
    """Derive a join from DISCOVERED keys only (FK on either side). Returns None
    when there is no key evidence — the proposer never invents a join key."""
    from .discovery import KeyType
    # FK from left -> right
    for k in left.keys:
        if k.key_type == KeyType.FOREIGN and k.references_table == right.name:
            return JoinMetadata(
                left_table=left.name, left_columns=k.columns,
                right_table=right.name, right_columns=k.references_columns or k.columns,
                cardinality="many-to-one", origin="discovered", name=name)
    # FK from right -> left
    for k in right.keys:
        if k.key_type == KeyType.FOREIGN and k.references_table == left.name:
            return JoinMetadata(
                left_table=left.name, left_columns=k.references_columns or k.columns,
                right_table=right.name, right_columns=k.columns,
                cardinality="one-to-many", origin="discovered", name=name)
    return None


# --------------------------------------------------------------------------- #
# Approval gate
# --------------------------------------------------------------------------- #
def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def approve(proposal: MappingProposal, approver: str, notes: Optional[str] = None) -> MappingProposal:
    """Approve a proposal. Fails CLOSED if it has blocking validation issues.

    Approval is a human decision: a non-blank approver AND a non-blank note are
    both MANDATORY (mirrors the control-plane ApprovalDecision contract).
    """
    if not (isinstance(approver, str) and approver.strip()):
        raise ValueError("approve requires a non-blank approver")
    if not (isinstance(notes, str) and notes.strip()):
        raise ValueError("approve requires a non-blank note")
    if not proposal.is_approvable:
        raise ValueError(
            f"cannot approve proposal {proposal.id}: blocking validation issues "
            f"{[i.code for i in proposal.validation_issues if i.severity == 'error']}"
        )
    proposal.status = ProposalStatus.APPROVED
    proposal.approver = approver
    proposal.decided_at = _now()
    proposal.notes = notes
    return proposal


def reject(proposal: MappingProposal, approver: str, notes: Optional[str] = None) -> MappingProposal:
    """Reject a proposal as an explicit human decision.

    Reviewer identity and rationale are mandatory for the same auditability
    guarantee as approval. Rejection excludes the proposal from publication.
    """
    if not (isinstance(approver, str) and approver.strip()):
        raise ValueError("reject requires a non-blank approver")
    if not (isinstance(notes, str) and notes.strip()):
        raise ValueError("reject requires a non-blank note")
    proposal.status = ProposalStatus.REJECTED
    proposal.approver = approver
    proposal.decided_at = _now()
    proposal.notes = notes
    return proposal


# --------------------------------------------------------------------------- #
# Publication — the hard gate
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class PublishedMapping:
    """One published, runtime-usable mapping (approved + valid)."""

    ontology_uri: str
    ontology_label: str
    kind: str
    target_table: Optional[str]
    target_column: Optional[str]
    join: Optional[dict]
    confidence: float
    proposal_id: str
    proposal_fingerprint: str
    approver: Optional[str]
    decided_at: Optional[str]
    # Discovered logical type of the target column (DIRECT mappings). Authority
    # for SUM/AVG/ILIKE validation downstream. Serialized as its string value.
    logical_type: str = LogicalType.UNKNOWN.value
    # Subject-key columns for a CLASS mapping (from the table's discovered PK).
    subject_columns: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["subject_columns"] = list(self.subject_columns)
        return d


@dataclass
class PublishedMappingSet:
    """The runtime registry the precision planner resolves against.

    Only approved + valid proposals are here. The set is content-addressed by a
    set_fingerprint so published artifacts are reproducible and auditable.
    """

    source_id: str
    mapping_version: str
    source_fingerprint: str
    set_fingerprint: str
    mappings: list[PublishedMapping] = field(default_factory=list)
    published_at: str = field(default_factory=_now)

    # --- lookups the planner uses ---
    def direct_for_label(self, label: str) -> list[PublishedMapping]:
        ll = label.lower().strip()
        return [m for m in self.mappings
                if m.kind == ProposalKind.DIRECT.value and m.ontology_label.lower().strip() == ll]

    def direct_for_uri(self, uri: str) -> list[PublishedMapping]:
        return [m for m in self.mappings
                if m.kind == ProposalKind.DIRECT.value and m.ontology_uri == uri]

    def class_for_table(self, table: str) -> Optional[PublishedMapping]:
        """The approved CLASS mapping whose target_table is `table`, if any.

        A published class carries the class URI (ontology_uri) and the
        discovered subject-key columns — these are what R2RML subject templates
        are built from. Returns None if no keyed class was published for the
        table (so direct mappings for that table cannot masquerade as precise).
        """
        for m in self.mappings:
            if m.kind == ProposalKind.CLASS.value and m.target_table == table:
                return m
        return None

    def joins(self) -> list[dict]:
        return [m.join for m in self.mappings
                if m.kind == ProposalKind.RELATIONSHIP.value and m.join]

    def tables(self) -> set[str]:
        out: set[str] = set()
        for m in self.mappings:
            if m.target_table:
                out.add(m.target_table)
            if m.join:
                out.add(m.join["left_table"])
                out.add(m.join["right_table"])
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "mapping_version": self.mapping_version,
            "source_fingerprint": self.source_fingerprint,
            "set_fingerprint": self.set_fingerprint,
            "published_at": self.published_at,
            "mappings": [m.to_dict() for m in self.mappings],
        }


class UnapprovedPublishError(ValueError):
    """Raised if a non-approved or invalid proposal reaches publication."""


def publish_mappings(
    source_id: str,
    proposals: list[MappingProposal],
    *,
    strict: bool = True,
) -> PublishedMappingSet:
    """Compile approved + valid proposals into a PublishedMappingSet.

    In strict mode (default), every supplied proposal must have a completed
    human decision. PROPOSED/undecided rows block publication; REJECTED rows are
    completed decisions and are excluded. APPROVED rows with blocking issues
    block publication. At least one approved, valid mapping is required.

    Callers must pass the complete proposal set for the publication scope (the
    control plane passes every proposal from one build run), preventing silent
    partial publication of an undecided review batch.
    """
    published: list[PublishedMapping] = []
    src_fp = proposals[0].source_fingerprint if proposals else ""
    version = proposals[0].mapping_version if proposals else MAPPING_VERSION

    if strict:
        undecided = [p.id for p in proposals if p.status == ProposalStatus.PROPOSED]
        if undecided:
            raise UnapprovedPublishError(
                "cannot publish with undecided proposal(s): " + ", ".join(undecided)
            )

    for p in proposals:
        if p.status != ProposalStatus.APPROVED:
            continue  # unapproved rows NEVER publish
        if p.has_blocking_issue:
            if strict:
                raise UnapprovedPublishError(
                    f"proposal {p.id} is approved but has blocking issues "
                    f"{[i.code for i in p.validation_issues if i.severity == 'error']}"
                )
            continue
        published.append(PublishedMapping(
            ontology_uri=p.ontology_uri, ontology_label=p.ontology_label,
            kind=p.kind.value, target_table=p.target_table,
            target_column=p.target_column,
            join=p.join.to_dict() if p.join else None,
            confidence=p.confidence, proposal_id=p.id,
            proposal_fingerprint=p.proposal_fingerprint,
            approver=p.approver, decided_at=p.decided_at,
            logical_type=p.logical_type.value,
            subject_columns=tuple(p.subject_columns),
        ))

    if strict and not published:
        raise UnapprovedPublishError(
            "cannot publish: no approved, valid mapping in the proposal set"
        )

    set_basis = json.dumps(
        [m.to_dict() for m in published] + [src_fp, version], sort_keys=True
    ).encode("utf-8")
    set_fp = hashlib.sha256(set_basis).hexdigest()[:16]

    return PublishedMappingSet(
        source_id=source_id, mapping_version=version,
        source_fingerprint=src_fp, set_fingerprint=set_fp, mappings=published,
    )


# --------------------------------------------------------------------------- #
# R2RML-compatible artifact (provenance where practical)
# --------------------------------------------------------------------------- #
class R2RMLError(ValueError):
    """Raised when an R2RML artifact cannot be emitted precisely (e.g. a direct
    mapping for a table that has no published keyed class)."""


def to_r2rml(
    published: PublishedMappingSet,
    *,
    base_uri: str = "http://graph-utility/mapping#",
    strict: bool = True,
) -> dict[str, Any]:
    """Produce R2RML-compatible mapping-artifact DATA (as a dict, not raw turtle).

    Subject templates are built from a published CLASS mapping's DISCOVERED
    subject-key columns and carry the class URI as `rr:class`. There is NO
    fabricated `__pk__` surrogate: a table must have an approved+published,
    keyed CLASS mapping before its DIRECT mappings can emit precise triples.

    A DIRECT mapping whose table has no published keyed class does NOT silently
    masquerade as precise:
      - strict=True (default): raises R2RMLError (fail closed), OR
      - strict=False: the table's TriplesMap is OMITTED and an explicit entry is
        recorded under the artifact's `errors` list.
    """
    triples_maps = []
    errors: list[dict[str, Any]] = []
    by_table: dict[str, list[PublishedMapping]] = {}
    for m in published.mappings:
        if m.kind == ProposalKind.DIRECT.value and m.target_table:
            by_table.setdefault(m.target_table, []).append(m)

    for table, mappings in sorted(by_table.items()):
        cls = published.class_for_table(table)
        if cls is None or not cls.subject_columns:
            msg = (
                f"table '{table}' has {len(mappings)} direct mapping(s) but no "
                f"published keyed CLASS mapping; cannot emit a precise subject "
                f"template (no fabricated surrogate key)")
            if strict:
                raise R2RMLError(msg)
            errors.append({"table": table, "code": "no-published-class-key",
                           "message": msg,
                           "omitted_predicates": [m.ontology_uri for m in mappings]})
            continue
        # Subject template from the discovered subject key + the class URI.
        key_template = "/".join("{" + c + "}" for c in cls.subject_columns)
        poms = []
        for m in mappings:
            poms.append({
                "predicate": m.ontology_uri,
                "objectMap": {"column": m.target_column,
                              "logicalType": m.logical_type},
                "provenance": {
                    "proposal_id": m.proposal_id,
                    "proposal_fingerprint": m.proposal_fingerprint,
                    "confidence": m.confidence,
                    "approver": m.approver,
                    "decided_at": m.decided_at,
                },
            })
        triples_maps.append({
            "name": f"{base_uri}{table}",
            "logicalTable": {"tableName": table},
            "subjectMap": {
                "template": f"{base_uri}{table}/{key_template}",
                "class": cls.ontology_uri,
                "subjectColumns": list(cls.subject_columns),
            },
            "predicateObjectMaps": poms,
        })

    ref_object_maps = []
    for j in published.joins():
        ref_object_maps.append({
            "parentTriplesMap": f"{base_uri}{j['right_table']}",
            "childLogicalTable": {"tableName": j["left_table"]},
            "joinConditions": [
                {"child": lc, "parent": rc}
                for lc, rc in zip(j["left_columns"], j["right_columns"])
            ],
            "cardinality": j.get("cardinality"),
            "origin": j.get("origin"),
        })

    doc: dict[str, Any] = {
        "@type": "r2rml:MappingDocument",
        "source_id": published.source_id,
        "mapping_version": published.mapping_version,
        "provenance": {
            "source_fingerprint": published.source_fingerprint,
            "set_fingerprint": published.set_fingerprint,
            "published_at": published.published_at,
        },
        "triplesMaps": triples_maps,
        "refObjectMaps": ref_object_maps,
    }
    if errors:
        doc["errors"] = errors
    return doc
