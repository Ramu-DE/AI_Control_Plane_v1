"""One governed build: published mappings -> N-Quads, with every gate applied.

WHY THIS MODULE EXISTS. The safety checks were real but they lived in
`integration/build_graph_live.py`: it materialized, entailed, validated
constraints, printed conflation warnings, and decided what to do. So the demo
runner was safe and every OTHER caller — the control plane, a Databricks job,
a future Temporal worker — inherited none of it. Each would have had to
re-implement the same sequence and remember the same five checks, and the one
that forgot would produce a graph that looked fine.

A guarantee belongs to the function, not to one script. `build_graph()` is now
the single supported entry point, and the gates are arguments rather than
things a caller may neglect to code.

WHAT IT REFUSES, in `strict` mode (the default):

  conflated entities      two source rows merged onto one subject — the graph
                          asserts something FALSE, not merely incomplete
  dangling edges          a relationship to an entity the graph never defines
  truncation              a prefix of the data presented as the whole
  constraint violations   the data breaks a declared axiom, which means the
                          MAPPING is wrong, not the ontology

Each is separately overridable, because they are not equally severe and a
reviewer inspecting a suspect build needs to get past one without waiving the
rest. `allow_truncation=True` for a sampled dry run is reasonable;
`allow_conflation=True` almost never is.

stdlib only.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Iterable, Optional

from .data_adapter import DataAdapter
from .mapping import PublishedMappingSet
from .materialize import (
    ANSI_DIALECT,
    MaterializationError,
    MaterializationResult,
    SqlDialect,
    Triple,
    materialize_graph,
    provenance_quads,
    serialize_quads,
)
from .reason import (
    EntailmentReport,
    Violation,
    axioms_fingerprint,
    entail,
    validate_constraints,
)


class BuildRefused(MaterializationError):
    """A gate stopped the build. Carries the report so the caller can inspect.

    Subclasses MaterializationError so existing callers that catch the latter
    keep working, while a caller that wants the detail can ask for it.
    """

    def __init__(self, message: str, report: "BuildReport") -> None:
        super().__init__(message)
        self.report = report


@dataclass
class BuildReport:
    """Everything one build did, decided and refused."""

    result: MaterializationResult
    entailment: Optional[EntailmentReport] = None
    violations: list[Violation] = field(default_factory=list)
    axioms_fingerprint: str = ""
    declared_axioms: int = 0
    inferred_triples: int = 0
    #: Gate names that fired. Empty on a clean build; populated even when the
    #: gates were waived, so a permitted problem is still on the record.
    refusals: list[str] = field(default_factory=list)
    #: Refusals the caller explicitly allowed. A waiver is a decision and is
    #: logged as one.
    waived: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.refusals

    def to_dict(self) -> dict[str, Any]:
        return {
            "result": self.result.to_dict(),
            "entailment": self.entailment.to_dict() if self.entailment else None,
            "violations": [asdict(v) for v in self.violations],
            "axioms_fingerprint": self.axioms_fingerprint,
            "declared_axioms": self.declared_axioms,
            "inferred_triples": self.inferred_triples,
            "refusals": list(self.refusals),
            "waived": list(self.waived),
            "ok": self.ok,
        }


def build_graph(
    published: PublishedMappingSet,
    adapter: DataAdapter,
    *,
    build_id: str,
    axioms: Optional[dict[str, Any]] = None,
    base_uri: str = "http://graph-utility/resource/",
    graph_uri: Optional[str] = None,
    strict: bool = True,
    allow_conflation: bool = False,
    allow_truncation: bool = False,
    allow_dangling: bool = False,
    allow_violations: bool = False,
    max_rows_per_table: Optional[int] = None,
    table_qualifier: Optional[Callable[[str], str]] = None,
    dialect: SqlDialect = ANSI_DIALECT,
    label_properties: Optional[dict[str, str]] = None,
    include_provenance: bool = True,
    reason: bool = True,
) -> tuple[list[str], BuildReport]:
    """Materialize, entail, validate and gate. Returns (nquads lines, report).

    Lines cover all three of a build's graphs: asserted data, entailments in
    `<graph>:inferred`, and provenance in `<graph>:prov`. Loading them together
    is what makes teardown exact later.

    `axioms` is optional only because a source may have none worth applying;
    passing none means no entailment and no constraint checking, and the report
    says so rather than implying the ontology was satisfied.
    """
    # Materialization runs with its own gates DISABLED, so this function can
    # collect every problem and report them together. A caller fixing a build
    # should see all of them at once, not discover the second one after fixing
    # the first.
    triples, result = materialize_graph(
        published, adapter,
        build_id=build_id, base_uri=base_uri, graph_uri=graph_uri,
        strict=False,
        max_rows_per_table=max_rows_per_table,
        table_qualifier=table_qualifier, dialect=dialect,
        label_properties=label_properties,
    )

    report = BuildReport(result=result)
    inferred: set[Triple] = set()

    if reason and axioms:
        report.declared_axioms = sum(
            len(v) for v in axioms.values() if isinstance(v, (list, tuple, set))
        )
        report.axioms_fingerprint = axioms_fingerprint(axioms)
        inferred, entail_report = entail(triples, axioms)
        report.entailment = entail_report
        report.inferred_triples = len(inferred)
        report.violations = validate_constraints(triples, axioms, inferred=inferred)

    # ---- gates ---- #
    checks = (
        ("conflation", result.has_conflation, allow_conflation,
         lambda: (f"{result.rows_with_duplicate_key} row(s) shared a subject key "
                  f"in {result.conflated_tables}: distinct entities were merged "
                  f"into one subject carrying both rows' values")),
        ("dangling-edges", result.has_dangling_edges, allow_dangling,
         lambda: (f"{result.dangling_edges} edge target(s) are never typed, so "
                  f"the graph asserts relationships to entities it does not "
                  f"define (e.g. {result.dangling_samples[0]['object']})")),
        ("truncation", bool(result.truncated), allow_truncation,
         lambda: (f"max_rows_per_table capped {result.truncated}: this graph is "
                  f"a reproducible PREFIX of the data, not the whole of it")),
        ("constraint-violations", bool(report.violations), allow_violations,
         lambda: (f"{len(report.violations)} declared constraint(s) are broken, "
                  f"e.g. {report.violations[0].code} on "
                  f"{report.violations[0].subject}: "
                  f"{report.violations[0].message}")),
    )

    messages: list[str] = []
    for name, fired, allowed, describe in checks:
        if not fired:
            continue
        report.refusals.append(name)
        if allowed:
            report.waived.append(name)
        else:
            messages.append(f"[{name}] {describe()}")

    if strict and messages:
        raise BuildRefused(
            "build refused by " + str(len(messages)) + " gate(s):\n  "
            + "\n  ".join(messages)
            + "\n(pass the matching allow_* flag to proceed anyway, or "
              "strict=False to collect every problem without raising)",
            report,
        )

    # ---- serialize all three graphs ---- #
    lines = serialize_quads(triples, result.graph_uri)
    if inferred:
        lines += serialize_quads(inferred, f"{result.graph_uri}:inferred")
    if include_provenance:
        extra: dict[str, str] = {}
        if report.axioms_fingerprint:
            extra["axiomsFingerprint"] = report.axioms_fingerprint
        if report.waived:
            # A waiver belongs IN the graph. Someone querying this data later
            # has no access to the build log, and "a human accepted this known
            # defect" is exactly what they need to know.
            extra["waived"] = ",".join(sorted(report.waived))
        prov = provenance_quads(published, result, base_uri=base_uri, extra=extra)
        result.provenance_quads = len(prov)
        lines += prov

    result.quads = len(lines)
    return lines, report


def describe_build(report: BuildReport) -> list[str]:
    """Human-readable summary lines. Shared so every caller reports alike."""
    r = report.result
    out = [
        f"graph      : <{r.graph_uri}>  ({r.quads} quad(s))",
        f"instances  : {r.class_instances}   literals: {r.literal_triples}   "
        f"edges: {r.relationship_triples}   labels: {r.label_triples}",
        f"rows read  : {r.rows_read}   null-key rows skipped: "
        f"{r.rows_skipped_null_key}   null values: {r.null_values_skipped}",
        f"complete   : {r.complete}      sound: {r.sound}",
    ]
    if r.typed_only_tables:
        out.append(
            f"typed-only : {r.typed_only_tables} — these classes were approved "
            f"with no properties, so their nodes carry only rdf:type")
    if r.has_conflation:
        out.append(
            f"CONFLATED  : {r.rows_with_duplicate_key} row(s) in "
            f"{r.conflated_tables}")
    if r.has_dangling_edges:
        out.append(f"DANGLING   : {r.dangling_edges} edge target(s) never typed")
        for s in r.dangling_samples:
            out.append(f"             {s['subject']} -{s['predicate']}-> "
                       f"{s['object']}")
    if r.truncated:
        out.append(f"TRUNCATED  : {r.truncated}")
    if report.entailment:
        out.append(
            f"reasoning  : {report.declared_axioms} axiom(s) "
            f"({report.axioms_fingerprint}) -> {report.inferred_triples} "
            f"inferred in {report.entailment.iterations} pass(es), "
            f"complete={report.entailment.complete}")
    if report.violations:
        out.append(f"VIOLATIONS : {len(report.violations)}")
        for v in report.violations[:10]:
            out.append(f"             {v.code}: {v.subject} — {v.message}")
    if report.waived:
        out.append(f"WAIVED     : {report.waived} (recorded in the prov graph)")
    return out
