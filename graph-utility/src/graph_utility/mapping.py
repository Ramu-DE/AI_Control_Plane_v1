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
    auto_approve      — threshold policy that clears only proposals backed by
                        MEASURED evidence (declared keys, matching datatypes,
                        exact name matches), going through the same
                        fail-closed `approve()`. Machine decisions are stamped
                        `auto:` so they stay distinguishable from human ones;
                        anything it defers still blocks strict publication.
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
    # ontology class -> the distinct values of a column, for an entity that has
    # no table of its own (a product that exists only as `sku` on orders).
    VALUE_CLASS = "value-class"


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
    # RELATIONSHIP only: the table the ontology's rdfs:domain resolved to, i.e.
    # the SUBJECT side of the edge (`target_table` is the range/object side).
    # Carried as data rather than recovered from an evidence string, so later
    # steps — value-overlap profiling in particular — cannot be broken by
    # rewording a message.
    domain_table: Optional[str] = None
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
    # Columns an ontology `owl:hasKey` resolves to in this table, for a CLASS
    # with no declared key. A CANDIDATE only: it becomes `subject_columns`
    # when profiling measures it to identify every row.
    key_candidate: tuple[str, ...] = ()
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
            "key_candidate": list(self.key_candidate),
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


def _singular(token: str) -> str:
    """Fold a plural token onto its singular so `Supplier` meets `suppliers`.

    Deliberately small and symmetric — both sides of a comparison go through
    it, so an imperfect rule (`series` -> `sery`) still compares equal to
    itself. Words ending in -ss/-us/-is are left alone (`class`, `status`,
    `analysis`), and short tokens are never touched (`ids`, `ae`).
    """
    if len(token) <= 3 or token.endswith(("ss", "us", "is")):
        return token
    if token.endswith("ies") and len(token) > 4:
        return token[:-3] + "y"
    if token.endswith(("ches", "shes", "xes", "zes")):
        return token[:-2]
    if token.endswith("s"):
        return token[:-1]
    return token


def _tokens(name: str) -> set[str]:
    import re
    # camelCase boundaries WITHOUT splitting acronyms: "siteName" -> site name,
    # "SKUCode" -> SKU code, "SKU" -> SKU. Splitting before every capital made
    # an acronym synonym (`SKU`, `NCT`, `GTIN`) into single letters that could
    # never equal the column it names.
    spaced = re.sub(r"(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", " ", name)
    spaced = re.sub(r"[^A-Za-z0-9]+", " ", spaced)
    return {_singular(t) for t in spaced.lower().split() if t}


def name_similarity(a: str, b: str) -> float:
    """Jaccard token overlap in [0,1]. Pure lexical — a weak signal by design."""
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


#: Column types that can carry a value identity. Measures and dates cannot: an
#: amount or a timestamp is an attribute, never an entity.
_VALUE_ENTITY_TYPES = (LogicalType.STRING, LogicalType.INTEGER)
_ID_SUFFIX = ("id", "code", "key", "no", "number", "nbr")


def _strip_identifier_suffix(name: str) -> str:
    """`warehouse_code` -> `warehouse`; a bare `id` is left alone."""
    import re
    parts = [p for p in re.split(r"[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])", name) if p]
    if len(parts) > 1 and parts[-1].lower() in _ID_SUFFIX:
        return "_".join(parts[:-1])
    return name


def term_match(
    names: list[str], synonyms: list[str], asset: str
) -> tuple[float, Optional[str], Optional[str]]:
    """Best similarity of an ontology term to an asset name, and HOW it matched.

    Returns (similarity, via, matched) where `via` is "name" for an exact match
    on the term's own name or rdfs:label, "label" for an exact match that only
    an ontology synonym (skos:prefLabel / altLabel / hiddenLabel) explains, and
    None for a partial match. The distinction is kept because a policy may
    trust the two differently: a synonym is curated, but it is still a claim
    someone wrote rather than the term itself.
    """
    best = max((name_similarity(n, asset) for n in names if n), default=0.0)
    if best >= 1.0:
        return 1.0, "name", None
    for syn in synonyms:
        if syn and name_similarity(syn, asset) >= 1.0:
            return 1.0, "label", syn
    best_syn = max((name_similarity(s, asset) for s in synonyms if s), default=0.0)
    return max(best, best_syn), None, None


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
    """Map an ontology range onto a logical type by substring match.

    Longest key first, which is not cosmetic: `xsd:dateTime` contains "date",
    so shortest-first would type it DATE, disagree with a TIMESTAMP column, and
    raise a type-mismatch ERROR that blocks a perfectly good mapping. Same for
    "integer" versus "int".
    """
    if not rng:
        return LogicalType.UNKNOWN
    r = rng.lower()
    for key, lt in sorted(_RANGE_TYPE.items(), key=lambda kv: -len(kv[0])):
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
    # Class URI -> its synonyms, so relationship endpoints and property domains
    # resolve to tables through the same vocabulary the class itself does.
    class_synonyms = {
        (c.get("class") or c.get("entity") or ""): [
            *([c["label"]] if c.get("label") else []),
            *list(c.get("synonyms") or []),
        ]
        for c in ontology_schema.get("classes", [])
    }
    # Property URI -> every name it may be matched by, for resolving owl:hasKey.
    property_names: dict[str, tuple[list[str], list[str]]] = {}
    for p in ontology_schema.get("properties", []):
        puri = p.get("property") or ""
        if puri and puri not in property_names:
            plocal = _local_name(puri)
            property_names[puri] = ([p.get("label") or plocal, plocal],
                                    list(p.get("synonyms") or []))
    # Classes that matched a TABLE exactly; only the others may become value
    # entities, so a class never gets two competing identities.
    table_classes: set[str] = set()

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
        synonyms = list(c.get("synonyms") or [])
        for t in discovery.tables:
            sim, via, matched_syn = term_match([label, local], synonyms, t.name)
            if sim <= 0:
                continue
            conf = min(sim, NAME_SIMILARITY_MAX_CONFIDENCE)
            # The subject key for this class is the table's DISCOVERED primary
            # key. Without one, the class cannot produce stable subject IRIs, so
            # the proposal is blocked (no fabricated surrogate key).
            pk = t.subject_key()
            subject_cols = tuple(pk.columns) if pk else ()
            if via is not None:
                table_classes.add(uri)
            # No declared key: does the ONTOLOGY say what identifies an
            # instance? Each owl:hasKey property must resolve to exactly one
            # column of this table by an exact name/synonym match, or the
            # declaration is not used here. It is a candidate until measured.
            key_candidate: tuple[str, ...] = ()
            if not subject_cols and c.get("has_key"):
                resolved: list[str] = []
                for kp in c["has_key"]:
                    names, syns = property_names.get(kp, ([_local_name(kp)], []))
                    hits = [col.name for col in t.columns
                            if term_match(names, syns, col.name)[1] is not None]
                    if len(hits) != 1:
                        resolved = []
                        break
                    resolved.append(hits[0])
                key_candidate = tuple(resolved)
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
            if via == "name":
                # An exact token match is qualitatively different from a partial
                # one: it is the difference between "Supplier -> suppliers" and
                # "Supplier -> supplier_contacts". The policy needs to see it.
                evidence.append(Evidence(
                    "name-exact",
                    f"class '{label}' token-matches table '{t.name}' exactly",
                    weight=0.0))
            elif via == "label":
                evidence.append(Evidence(
                    "label-exact",
                    f"table '{t.name}' matches ontology synonym '{matched_syn}' of class '{label}'",
                    weight=0.0))
            if subject_cols:
                evidence.append(Evidence(
                    "key-metadata",
                    f"subject key {list(subject_cols)} from declared "
                    f"{pk.key_type.value} constraint '{pk.name or '?'}'",
                    weight=0.2))
            if key_candidate:
                evidence.append(Evidence(
                    "ontology-haskey",
                    f"owl:hasKey of '{label}' resolves to {list(key_candidate)} in "
                    f"'{t.name}' (to be verified by measurement)",
                    weight=0.0))
            proposals.append(MappingProposal(
                id=next_id(), kind=ProposalKind.CLASS,
                ontology_uri=uri, ontology_label=label, ontology_type="class",
                target_table=t.name,
                subject_columns=subject_cols,
                key_candidate=key_candidate,
                evidence=evidence,
                confidence=conf,
                validation_issues=issues,
                source_fingerprint=src_fp,
            ))

    # ---- class -> column VALUES, for entities with no table of their own ----
    # Real datasets are rarely normalised: a product often exists only as `sku`
    # on orders and inventory, a warehouse only as a column. Without this such
    # a class can never become an entity, and every edge to it is lost.
    #
    # Identity is the value, scoped by class, so the same `sku` on two tables
    # is ONE product. That is a modelling claim, which is why these proposals
    # carry an `inferred-identity` warning and only automate under a profile
    # that allows it. A class that matched a table exactly is never offered
    # here: one class, one identity.
    value_classes: dict[str, dict[str, list[str]]] = {}   # class -> table -> [columns]
    for c in ontology_schema.get("classes", []):
        uri = c.get("class") or c.get("entity") or ""
        if not uri or uri in table_classes:
            continue
        local = _local_name(uri)
        label = c.get("label") or local
        synonyms = list(c.get("synonyms") or [])
        for t in discovery.tables:
            for col in t.columns:
                if col.logical_type not in _VALUE_ENTITY_TYPES:
                    continue
                via, matched_syn = None, None
                for candidate in dict.fromkeys((col.name, _strip_identifier_suffix(col.name))):
                    sim, via, matched_syn = term_match([label, local], synonyms, candidate)
                    if via is not None:
                        break
                if via is None:
                    continue
                value_classes.setdefault(uri, {}).setdefault(t.name, []).append(col.name)
                evidence = [
                    Evidence("name-exact" if via == "name" else "label-exact",
                             f"column '{t.name}.{col.name}' names class '{label}'"
                             + (f" via ontology synonym '{matched_syn}'" if via == "label" else ""),
                             weight=0.0),
                    Evidence("categorical-column",
                             f"'{t.name}.{col.name}' is {col.logical_type.value}, usable as a "
                             f"value identity", weight=0.25),
                ]
                proposals.append(MappingProposal(
                    id=next_id(), kind=ProposalKind.VALUE_CLASS,
                    ontology_uri=uri, ontology_label=label, ontology_type="class",
                    target_table=t.name, target_column=col.name,
                    logical_type=col.logical_type,
                    subject_columns=(col.name,),
                    evidence=evidence, confidence=0.6,
                    validation_issues=[ValidationIssue(
                        "inferred-identity",
                        f"'{label}' has no table; instances are minted from the distinct "
                        f"values of '{t.name}.{col.name}', so equal values are ONE entity",
                        severity="warning")],
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
        # The ontology's rdfs:domain says WHICH class this property belongs to.
        # Using it to constrain candidate tables is the difference between the
        # ontology driving the mapping and the ontology merely decorating it.
        domain_uri = p.get("domain")
        domain_table, _domain_sim, _ = _match_table_scored(discovery, domain_uri, class_synonyms)
        synonyms = list(p.get("synonyms") or [])
        for t in discovery.tables:
            for col in t.columns:
                sim, via, matched_syn = term_match([label, local], synonyms, col.name)
                if sim <= 0:
                    continue
                evidence = [Evidence("name-similarity",
                                     f"property '{label}' ~ column '{t.name}.{col.name}' "
                                     f"(jaccard={sim:.2f})", weight=min(sim, NAME_SIMILARITY_MAX_CONFIDENCE))]
                conf = min(sim, NAME_SIMILARITY_MAX_CONFIDENCE)
                if via == "name":
                    evidence.append(Evidence(
                        "name-exact",
                        f"property '{label}' token-matches column "
                        f"'{t.name}.{col.name}' exactly",
                        weight=0.0))
                elif via == "label":
                    evidence.append(Evidence(
                        "label-exact",
                        f"column '{t.name}.{col.name}' matches ontology synonym "
                        f"'{matched_syn}' of property '{label}'",
                        weight=0.0))
                domain_issue: Optional[ValidationIssue] = None
                if domain_table is not None:
                    if domain_table.name == t.name:
                        evidence.append(Evidence(
                            "domain-consistent",
                            f"ontology domain {_local_name(domain_uri or '')} resolves to "
                            f"table '{t.name}', which is where this column lives",
                            weight=0.15))
                    else:
                        # Not an error: domain resolution is itself name-based,
                        # so it may be wrong. But it must stop automation.
                        domain_issue = ValidationIssue(
                            "domain-mismatch",
                            f"ontology domain {_local_name(domain_uri or '')} resolves to "
                            f"table '{domain_table.name}', not '{t.name}'",
                            severity="warning")
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
                if domain_issue is not None:
                    issues.append(domain_issue)
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
        left, left_sim, left_via = _match_table_scored(discovery, domain, class_synonyms)
        right, right_sim, right_via = _match_table_scored(discovery, rng, class_synonyms)
        if rng in value_classes:
            # The range is a VALUE entity, so a table "match" for it is only a
            # partial resemblance (exact ones were excluded above). Its
            # instances come from a column of the domain's own table.
            right, right_sim, right_via = None, 0.0, None
        if left and not right and rng in value_classes and left.name in value_classes[rng]:
            cols = value_classes[rng][left.name]
            if len(cols) > 1:
                # Two columns name the same class (origin / destination both
                # being a Location): the relationship's own name must choose.
                rsyn = list(rel.get("synonyms") or [])
                cols = [col for col in cols
                        if term_match([label, local], rsyn, col)[1] is not None
                        or term_match([label, local], rsyn, _strip_identifier_suffix(col))[1] is not None]
            if len(cols) != 1:
                proposals.append(MappingProposal(
                    id=next_id(), kind=ProposalKind.RELATIONSHIP,
                    ontology_uri=uri, ontology_label=label, ontology_type="object-property",
                    target_table=left.name, domain_table=left.name,
                    evidence=[Evidence("ontology-relationship",
                                       f"relationship '{label}': {left.name} -> value {_local_name(rng)}",
                                       weight=0.4)],
                    confidence=0.0,
                    validation_issues=[ValidationIssue(
                        "value-reference-ambiguous",
                        f"'{left.name}' has {len(value_classes[rng][left.name])} column(s) naming "
                        f"{_local_name(rng)} {value_classes[rng][left.name]} and the relationship "
                        f"name does not pick exactly one", severity="error")],
                    source_fingerprint=src_fp,
                ))
                continue
            col = cols[0]
            exact = left_via is not None
            vjoin = JoinMetadata(left.name, (col,), left.name, (col,),
                                 cardinality="many-to-one", origin="value",
                                 name=f"value:{_local_name(rng)}", value_class=rng)
            rel_evidence = [
                Evidence("ontology-relationship",
                         f"relationship '{label}': {left.name} -> {_local_name(rng)} "
                         f"value of '{left.name}.{col}'", weight=0.4),
                Evidence("value-reference",
                         f"the object is minted from '{left.name}.{col}', the same column that "
                         f"defines {_local_name(rng)}, so the edge cannot dangle", weight=0.2),
            ]
            if exact:
                rel_evidence.append(Evidence(
                    "label-exact" if left_via == "label" else "name-exact",
                    f"domain matches table '{left.name}' exactly", weight=0.0))
            proposals.append(MappingProposal(
                id=next_id(), kind=ProposalKind.RELATIONSHIP,
                ontology_uri=uri, ontology_label=label, ontology_type="object-property",
                target_table=left.name, domain_table=left.name, join=vjoin,
                evidence=rel_evidence, confidence=0.6,
                validation_issues=[ValidationIssue(
                    "inferred-identity",
                    f"object identity is the value of '{left.name}.{col}'",
                    severity="warning")],
                source_fingerprint=src_fp,
            ))
            continue
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
        join = _candidate_join(left, right, label, discovery.joins)
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
        rel_evidence = [Evidence("ontology-relationship",
                                 f"relationship '{label}': {left.name} -> {right.name}", weight=0.4)]
        if join:
            rel_evidence.append(
                Evidence("key-metadata", f"join via {join.left_columns}->{join.right_columns}", 0.2))
        if left_sim >= 1.0 and right_sim >= 1.0:
            # Both endpoints resolved to tables by an exact token match. The
            # relationship itself comes from the ontology, but which TABLES it
            # connects is a name decision — so its exactness is evidence too.
            # If either end needed a synonym, the weaker kind is recorded.
            via_label = "label" in (left_via, right_via)
            rel_evidence.append(Evidence(
                "label-exact" if via_label else "name-exact",
                f"both endpoints match exactly{' (via ontology synonym)' if via_label else ''}: "
                f"'{left.name}', '{right.name}'",
                weight=0.0))
        proposals.append(MappingProposal(
            id=next_id(), kind=ProposalKind.RELATIONSHIP,
            ontology_uri=uri, ontology_label=label, ontology_type="object-property",
            target_table=right.name, domain_table=left.name, join=join,
            evidence=rel_evidence,
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


def _match_table_scored(
    discovery: DiscoveryResult,
    class_uri: Optional[str],
    class_synonyms: Optional[dict[str, list[str]]] = None,
):
    """Best table for a class URI, WITH the similarity that justified it and
    how it matched ("name", "label" or None — see `term_match`).

    The score is what lets the auto-approval policy distinguish an exact name
    match from a fuzzy guess; collapsing it to just the table (as `_match_table`
    does) throws away the only evidence of how good the match was.
    """
    if not class_uri:
        return None, 0.0, None
    local = _local_name(class_uri)
    synonyms = (class_synonyms or {}).get(class_uri, [])
    best, best_sim, best_via = None, 0.0, None
    for t in discovery.tables:
        sim, via, _ = term_match([local, class_uri], synonyms, t.name)
        # Prefer an exact name over an exact synonym when both tie at 1.0.
        if sim > best_sim or (sim == best_sim and via == "name" and best_via == "label"):
            best, best_sim, best_via = t, sim, via
    return (best, best_sim, best_via) if best_sim > 0 else (None, 0.0, None)


def _match_table(discovery: DiscoveryResult, class_uri: Optional[str]):
    return _match_table_scored(discovery, class_uri)[0]


def _candidate_join(left, right, name, declared=()) -> Optional[JoinMetadata]:
    """Derive a join from DECLARED evidence only. Returns None when there is no
    key evidence — the proposer never invents a join key.

    `declared` is `DiscoveryResult.joins`, and it is consulted FIRST because it
    is the most direct statement available: the adapter saying "these two
    tables join on these columns".

    It has to be consulted at all because the same fact has two
    representations. The Unity Catalog adapter fills both — a `FOREIGN`
    KeyMetadata on the table AND a JoinMetadata in `joins` — so reading only
    the keys happened to work there. Any other adapter that populates only
    `joins`, which the DataAdapter contract allows, had its declared foreign
    keys silently ignored: the relationship was blocked with `no-key-evidence`
    and the join could then only be recovered by profiling the data, paying a
    query to rediscover what the catalog had already said.
    """
    from .discovery import KeyType

    for j in declared or ():
        if j.left_table == left.name and j.right_table == right.name:
            return JoinMetadata(
                left_table=j.left_table, left_columns=j.left_columns,
                right_table=j.right_table, right_columns=j.right_columns,
                cardinality=j.cardinality, origin=j.origin, name=j.name or name)
        # The same declared join seen from the other side. Columns must be
        # swapped with it, or the join would read backwards.
        if j.left_table == right.name and j.right_table == left.name:
            return JoinMetadata(
                left_table=left.name, left_columns=j.right_columns,
                right_table=right.name, right_columns=j.left_columns,
                cardinality="one-to-many" if j.cardinality == "many-to-one"
                else j.cardinality,
                origin=j.origin, name=j.name or name)

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
# Threshold auto-approval
# --------------------------------------------------------------------------- #
# A build can only be "automatic irrespective of the dataset" if something other
# than a human can clear the gate. The rule is that AUTOMATION FOLLOWS EVIDENCE:
# a proposal may auto-approve only when the thing being asserted was *measured*
# (a declared key, a matching datatype, an exact name match) rather than guessed
# from name resemblance.
#
# INVARIANT: AUTO_APPROVE_MIN_CONFIDENCE > NAME_SIMILARITY_MAX_CONFIDENCE. A
# name-only proposal is capped below the bar, so it cannot auto-approve by
# arithmetic, not merely by policy. (Asserted in the test suite.)
AUTO_APPROVE_MIN_CONFIDENCE = 0.55

# Evidence kinds that record a measurement rather than a resemblance.
# `uniqueness-verified` is a measurement taken against the data during this
# build, which makes it no weaker than `key-metadata`: a Unity Catalog primary
# key is informational and unenforced, so a declared constraint is a statement
# of intent while this is an observation.
HARD_EVIDENCE_KINDS = frozenset({
    "key-metadata", "type-compatibility", "uniqueness-verified",
    # Value entities: the column's type is read from the catalog, and an edge
    # minted from the same column that defines its target cannot dangle.
    "categorical-column", "value-reference",
})
#: Evidence kinds that can justify a subject key for a CLASS proposal.
SUBJECT_KEY_EVIDENCE = frozenset({"key-metadata", "uniqueness-verified"})

# Marks machine decisions in the audit trail so they can never be mistaken for,
# or counted as, human review.
AUTO_APPROVER_PREFIX = "auto:"


@dataclass(frozen=True)
class AutoApprovalPolicy:
    """What the machine is allowed to approve on its own.

    `require_exact_name_match` is the load-bearing setting, and it applies to
    every kind. Which column or table an ontology term resolves to is a name
    decision even when the term itself is authoritative, so without this a
    partial match could publish unreviewed — and partial matches are not rare
    edge cases. `siteName` overlaps `site_id` on one of two tokens, and both
    being strings makes their types "compatible", so name+type alone would
    happily auto-approve a mapping of the site's NAME onto its ID.
    """

    min_confidence: float = AUTO_APPROVE_MIN_CONFIDENCE
    require_exact_name_match: bool = True
    #: Count an exact match through an ontology synonym (skos:*Label) as exact.
    #: Off for GxP data, where only the term's own name may automate.
    accept_label_match: bool = True
    #: Publication needs a named human even when every proposal auto-approved
    #: (computer-system validation: a machine may shorten review, never sign it).
    require_human_publish: bool = False
    #: Automate identity the data implies but nobody declared: value entities
    #: (a Product minted from `sku`) and their edges. Off for GxP, where an
    #: entity's identity is a validated modelling decision, not an inference.
    automate_inferred_identity: bool = True
    actor: str = "threshold-policy"

    @property
    def approver(self) -> str:
        return f"{AUTO_APPROVER_PREFIX}{self.actor}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "min_confidence": self.min_confidence,
            "require_exact_name_match": self.require_exact_name_match,
            "accept_label_match": self.accept_label_match,
            "require_human_publish": self.require_human_publish,
            "automate_inferred_identity": self.automate_inferred_identity,
            "approver": self.approver,
        }


#: Named per-tenant policies. A GraphSource picks one by `approval_profile`.
#: None lowers `min_confidence` below AUTO_APPROVE_MIN_CONFIDENCE, so a
#: name-only proposal cannot clear any profile by arithmetic.
APPROVAL_PROFILES: dict[str, AutoApprovalPolicy] = {
    "gxp-strict": AutoApprovalPolicy(
        accept_label_match=False, require_human_publish=True,
        automate_inferred_identity=False, actor="gxp-strict"),
    "standard": AutoApprovalPolicy(actor="standard"),
    "exploratory": AutoApprovalPolicy(actor="exploratory"),
}


def approval_policy(profile: Optional[str]) -> AutoApprovalPolicy:
    """Resolve a profile name; unknown names fail loudly rather than default."""
    if not profile:
        return APPROVAL_PROFILES["standard"]
    try:
        return APPROVAL_PROFILES[profile]
    except KeyError:
        raise ValueError(
            f"unknown approval profile '{profile}'; expected one of {sorted(APPROVAL_PROFILES)}"
        ) from None


def auto_approval_verdict(
    proposal: MappingProposal, policy: Optional[AutoApprovalPolicy] = None
) -> tuple[bool, str]:
    """Decide whether one proposal may auto-approve. Returns (eligible, reason).

    The reason is recorded either as the approval note (eligible) or as the
    deferral reason (not eligible), so every proposal carries a written
    justification regardless of which way it went.
    """
    pol = policy or AutoApprovalPolicy()
    kinds = {e.kind for e in proposal.evidence}

    if proposal.status != ProposalStatus.PROPOSED:
        return False, f"already decided ({proposal.status.value})"
    if proposal.has_blocking_issue:
        codes = [i.code for i in proposal.validation_issues if i.severity == "error"]
        return False, f"blocking validation issues {codes}"
    if not kinds & HARD_EVIDENCE_KINDS:
        return False, "no measured evidence; justified only by name resemblance"

    exact = "name-exact" in kinds or (pol.accept_label_match and "label-exact" in kinds)
    if pol.require_exact_name_match and not exact:
        if "label-exact" in kinds:
            return False, "matched only through an ontology synonym, which this profile does not automate"
        return False, "name match is only partial, so the target rests on a guess"

    # A declared domain that points somewhere else is the ontology itself
    # disagreeing with the match. Never automate past that.
    if any(i.code == "domain-mismatch" for i in proposal.validation_issues):
        return False, "ontology domain disagrees with the matched table"

    inferred_identity = proposal.kind == ProposalKind.VALUE_CLASS or (
        proposal.join is not None and proposal.join.value_class is not None)
    if inferred_identity and not pol.automate_inferred_identity:
        return False, "identity inferred from column values, which this profile does not automate"

    if proposal.kind == ProposalKind.VALUE_CLASS:
        if "categorical-column" not in kinds or not proposal.target_column:
            return False, "value entity needs a categorical (string/integer) column"
        return True, (
            f"value entity: exact match of a class with no table onto categorical column "
            f"'{proposal.target_table}.{proposal.target_column}'"
        )

    if proposal.kind == ProposalKind.RELATIONSHIP and inferred_identity:
        if "value-reference" not in kinds:
            return False, "value relationship lacks its value-reference evidence"
        return True, (
            f"relationship to a value entity via '{proposal.join.left_table}."
            f"{proposal.join.left_columns[0]}', domain matched exactly"
        )

    if proposal.kind == ProposalKind.DIRECT:
        if "type-compatibility" not in kinds:
            return False, "no type-compatibility evidence for a column mapping"
        if proposal.confidence < pol.min_confidence:
            return False, (
                f"confidence {proposal.confidence:.2f} below "
                f"{pol.min_confidence:.2f}"
            )
        domain = "domain-consistent" in kinds
        return True, (
            f"datatype property: exact column match, ontology range matches the "
            f"discovered column type, "
            f"{'domain confirmed' if domain else 'no domain declared'}, "
            f"confidence {proposal.confidence:.2f}"
        )

    if proposal.kind == ProposalKind.CLASS:
        # NOTE on the absence of a confidence check here, which is deliberate
        # and not an oversight: a CLASS proposal's confidence is capped at
        # NAME_SIMILARITY_MAX_CONFIDENCE, permanently BELOW min_confidence, so
        # applying the floor would block every class and the pipeline would
        # produce nothing. A class is therefore gated on the two things that do
        # carry information — an exact table match (checked above) and real
        # subject-key evidence — rather than on a number that cannot vary.
        key_evidence = kinds & SUBJECT_KEY_EVIDENCE
        if not key_evidence:
            return False, "class has no subject key, declared or measured"
        if not proposal.subject_columns:
            return False, "class has key evidence but no subject columns set"
        measured = key_evidence == {"uniqueness-verified"}
        return True, (
            f"class: exact table match plus "
            f"{'measured unique' if measured else 'declared'} subject key "
            f"{list(proposal.subject_columns)}"
        )

    if proposal.kind == ProposalKind.RELATIONSHIP:
        if "key-metadata" not in kinds:
            return False, "relationship has no discovered key to join on"
        if proposal.confidence < pol.min_confidence:
            return False, (
                f"confidence {proposal.confidence:.2f} below "
                f"{pol.min_confidence:.2f}"
            )
        return True, (
            "relationship: ontology domain/range with a discovered foreign key "
            "join and exact endpoint matches"
        )

    return False, f"unhandled proposal kind '{proposal.kind}'"


@dataclass(frozen=True)
class AutoApprovalResult:
    """What the policy decided, in full, for the audit trail."""

    approved: list[str] = field(default_factory=list)
    deferred: list[dict[str, str]] = field(default_factory=list)
    policy: dict[str, Any] = field(default_factory=dict)

    @property
    def needs_human(self) -> bool:
        return bool(self.deferred)

    def to_dict(self) -> dict[str, Any]:
        return {
            "approved": list(self.approved),
            "deferred": list(self.deferred),
            "policy": dict(self.policy),
            "needs_human": self.needs_human,
        }


def auto_approve(
    proposals: list[MappingProposal],
    *,
    policy: Optional[AutoApprovalPolicy] = None,
) -> AutoApprovalResult:
    """Approve every proposal the policy allows; leave the rest for a human.

    Approval goes through `approve()` rather than setting status directly, so
    the fail-closed checks apply identically to machine and human decisions.
    Anything not approved is left PROPOSED — which means strict publication will
    still refuse the batch until a human decides it. Automation shortens the
    queue; it never empties it on your behalf.
    """
    pol = policy or AutoApprovalPolicy()
    result = AutoApprovalResult(approved=[], deferred=[], policy=pol.to_dict())
    for p in proposals:
        eligible, reason = auto_approval_verdict(p, pol)
        if eligible:
            approve(p, pol.approver, f"auto-approved: {reason}")
            result.approved.append(p.id)
        else:
            result.deferred.append({"id": p.id, "reason": reason})
    return result


def was_auto_approved(proposal: MappingProposal) -> bool:
    """True when this decision was made by policy rather than by a person."""
    return bool(proposal.approver and proposal.approver.startswith(AUTO_APPROVER_PREFIX))


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
