"""Compare two ways of mapping an ontology onto tables, on the same data.

THE QUESTION. OntoBricks maps from metadata: table and column names, comments,
types, and an LLM wizard over those. This module maps from the same metadata
PLUS measured evidence — proven key uniqueness and measured value containment.
Is the measurement worth its cost?

THE METHOD IS AN ABLATION, NOT A REIMPLEMENTATION. Both arms run the SAME
`propose_mappings` and the SAME `auto_approve`. The only difference is whether
`enrich_classes_with_uniqueness` and `enrich_relationships_with_overlap` run in
between. So the comparison isolates exactly one variable, and the baseline is
not a strawman written to lose — it is our own pipeline with the measurement
switched off, which is a fair stand-in for "metadata and names only".

What this is NOT: it does not run OntoBricks. OntoBricks needs a Databricks App
and Lakebase, and its LLM wizard would add a second uncontrolled variable
anyway. The baseline models the SIGNALS its documentation describes, which is
the part the comparison is about. Where an LLM would help is noted in
`LLM_CAVEAT` rather than quietly assumed away.

HOW IT IS SCORED. Against a ground truth supplied by the caller, never against
either arm's own confidence — a method that is confidently wrong has to score
worse, not better. Three buckets, because they have different costs:

  approved_correct  automation that worked
  approved_wrong    THE EXPENSIVE ONE: published, unreviewed, and incorrect
  missed            truth no arm auto-approved; a human still has to decide

A deferral is not an error. Deferring everything would score 100% precision and
0% recall, which is why both numbers are always reported together.

stdlib only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional

from .data_adapter import DataAdapter
from .discovery import DiscoveryResult
from .mapping import (
    AutoApprovalPolicy,
    MappingProposal,
    ProposalKind,
    ProposalStatus,
    auto_approve,
    propose_mappings,
)
from .overlap import (
    enrich_classes_with_uniqueness,
    enrich_relationships_with_overlap,
)

#: Stated so a reader does not have to infer the comparison's limits.
LLM_CAVEAT = (
    "The metadata arm uses name and type matching, not an LLM. An LLM reading "
    "good column comments would likely close part of the T5/T4 gap, and cannot "
    "close T1/T2/T3 at all: no amount of reading names reveals whether a column "
    "is unique or whether two tables' values actually overlap. Those need the "
    "data."
)

ARM_METADATA = "metadata-only"
ARM_MEASURED = "measured-evidence"


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #
def _matches_truth(p: MappingProposal, truth: dict[str, Any]) -> tuple[bool, str]:
    """Is this proposal the mapping the truth says it should be?

    Returns (correct, detail) so a wrong answer can be reported as what it
    actually said, not just as a failure.
    """
    kind = truth.get("kind")

    if kind == "class":
        got_table = p.target_table
        got_key = tuple(p.subject_columns)
        want_table = truth["table"]
        want_key = tuple(truth["subject_columns"])
        if got_table != want_table:
            return False, f"table {got_table!r} (want {want_table!r})"
        if got_key != want_key:
            # A partial key is the dangerous case: it looks like identity and
            # collapses rows, so it is counted as wrong rather than incomplete.
            return False, (
                f"subject key {list(got_key)} (want {list(want_key)})"
            )
        return True, f"{got_table} keyed by {list(got_key)}"

    if kind == "direct":
        if p.target_table != truth["table"] or p.target_column != truth["column"]:
            return False, (
                f"{p.target_table}.{p.target_column} "
                f"(want {truth['table']}.{truth['column']})"
            )
        return True, f"{p.target_table}.{p.target_column}"

    if kind == "relationship":
        j = p.join
        if j is None:
            return False, "no join"
        got = (j.left_table, tuple(j.left_columns), j.right_table,
               tuple(j.right_columns))
        want = (truth["left_table"], tuple(truth["left_columns"]),
                truth["right_table"], tuple(truth["right_columns"]))
        if got != want:
            return False, (
                f"{got[0]}.{list(got[1])} -> {got[2]}.{list(got[3])} "
                f"(want {want[0]}.{list(want[1])} -> {want[2]}.{list(want[3])})"
            )
        return True, f"{got[0]}.{list(got[1])} -> {got[2]}.{list(got[3])}"

    raise ValueError(f"ground truth for {p.ontology_uri!r} has unknown kind {kind!r}")


@dataclass
class ArmResult:
    """One arm's outcome, with every decision attributable to a proposal."""

    arm: str
    proposed: int = 0
    approved: int = 0
    approved_correct: list[dict[str, Any]] = field(default_factory=list)
    approved_wrong: list[dict[str, Any]] = field(default_factory=list)
    missed: list[dict[str, Any]] = field(default_factory=list)
    #: Approved mappings for ontology terms the truth says nothing about.
    unscored: list[dict[str, Any]] = field(default_factory=list)
    measurements: dict[str, int] = field(default_factory=dict)

    @property
    def scored(self) -> int:
        return len(self.approved_correct) + len(self.approved_wrong)

    @property
    def precision(self) -> Optional[float]:
        """Of what this arm published unreviewed, how much was right.

        None when the arm approved nothing in scope: 0/0 is not 0% precision,
        and reporting it as 0% would make a cautious arm look reckless.
        """
        if self.scored == 0:
            return None
        return len(self.approved_correct) / self.scored

    @property
    def recall(self) -> Optional[float]:
        total = self.scored + len(self.missed)
        if total == 0:
            return None
        return len(self.approved_correct) / total

    def to_dict(self) -> dict[str, Any]:
        return {
            "arm": self.arm,
            "proposed": self.proposed,
            "approved": self.approved,
            "approved_correct": len(self.approved_correct),
            "approved_wrong": len(self.approved_wrong),
            "missed": len(self.missed),
            "precision": self.precision,
            "recall": self.recall,
            "measurements": dict(self.measurements),
            "wrong_detail": list(self.approved_wrong),
            "missed_detail": list(self.missed),
            "unscored": list(self.unscored),
        }


def score_arm(
    arm: str,
    proposals: list[MappingProposal],
    truth: dict[str, Any],
    *,
    measurements: Optional[dict[str, int]] = None,
) -> ArmResult:
    """Score one arm's proposals against ground truth.

    Only AUTO-APPROVED proposals count as the arm's answer. A proposal left
    PROPOSED is a question put to a human, and crediting it would score the
    human's future work as the machine's.
    """
    res = ArmResult(arm=arm, proposed=len(proposals),
                    measurements=dict(measurements or {}))
    seen: set[str] = set()

    for p in proposals:
        if p.status != ProposalStatus.APPROVED:
            continue
        res.approved += 1
        want = truth.get(p.ontology_uri)
        entry = {
            "ontology_uri": p.ontology_uri,
            "kind": p.kind.value if isinstance(p.kind, ProposalKind) else str(p.kind),
            "confidence": round(p.confidence, 3),
            "evidence": sorted({e.kind for e in p.evidence}),
        }
        if want is None:
            res.unscored.append(entry)
            continue
        # A term the truth covers can only be answered once per arm; if an arm
        # approved two mappings for the same term, the extra ones are wrong by
        # construction (the planner would have to pick, and could pick either).
        if p.ontology_uri in seen:
            res.approved_wrong.append({**entry, "detail": "duplicate approval",
                                       "trap": want.get("trap")})
            continue
        seen.add(p.ontology_uri)
        correct, detail = _matches_truth(p, want)
        entry = {**entry, "detail": detail, "trap": want.get("trap")}
        (res.approved_correct if correct else res.approved_wrong).append(entry)

    for uri, want in truth.items():
        if uri not in seen:
            res.missed.append({"ontology_uri": uri, "kind": want.get("kind"),
                               "trap": want.get("trap")})
    return res


# --------------------------------------------------------------------------- #
# The two arms
# --------------------------------------------------------------------------- #
def run_metadata_arm(
    discovery: DiscoveryResult,
    ontology: dict[str, list[dict]],
    *,
    policy: Optional[AutoApprovalPolicy] = None,
) -> ArmResult:
    """Names, types and declared keys only — no data is read.

    This is the OntoBricks-documented signal set. It is also strictly cheaper:
    it issues zero profiling queries, which is the case FOR it.
    """
    proposals = propose_mappings(discovery, ontology, id_prefix="meta")
    auto_approve(proposals, policy=policy)
    return score_arm(ARM_METADATA, proposals, {}, measurements={"profile_queries": 0})


def run_measured_arm(
    discovery: DiscoveryResult,
    ontology: dict[str, list[dict]],
    adapter: DataAdapter,
    *,
    policy: Optional[AutoApprovalPolicy] = None,
    probe_limit: int = 50_000,
) -> tuple[ArmResult, list, list]:
    """The same pipeline, with uniqueness and containment measured first.

    Returns the result plus the raw proofs and overlaps, because the numbers
    are the justification: "approved because 6/6 values are contained in a
    verified-unique parent key" is reviewable, and "approved, confidence 0.78"
    is not.
    """
    proposals = propose_mappings(discovery, ontology, id_prefix="meas")
    proofs = enrich_classes_with_uniqueness(
        proposals, adapter, discovery, probe_limit=probe_limit)
    overlaps = enrich_relationships_with_overlap(
        proposals, adapter, discovery, probe_limit=probe_limit)
    auto_approve(proposals, policy=policy)
    res = score_arm(
        ARM_MEASURED, proposals, {},
        measurements={"profile_queries": len(proofs) + len(overlaps),
                      "uniqueness_proofs": len(proofs),
                      "overlap_probes": len(overlaps)},
    )
    return res, proofs, overlaps


@dataclass
class Comparison:
    """Both arms, scored on identical inputs."""

    metadata: ArmResult
    measured: ArmResult
    truth_size: int
    caveat: str = LLM_CAVEAT

    def by_trap(self) -> dict[str, dict[str, dict[str, int]]]:
        """Per-trap COUNTS for each arm, which is where the story is.

        An aggregate precision number hides the shape: both arms do fine on
        the declared-key cases, and the whole difference sits in the traps that
        need data.

        Counts, not a single label per trap. The first version of this reduced
        each trap to one word, and because a trap class holds several terms
        that could land in different buckets, the word depended on iteration
        order — a trap with three correct terms and one miss could print either
        way. A verdict that changes with dict ordering is worse than no
        verdict, because it reads as a finding.
        """
        out: dict[str, dict[str, dict[str, int]]] = {}
        for name, res in (("metadata", self.metadata), ("measured", self.measured)):
            for bucket, label in (
                (res.approved_correct, "correct"),
                (res.approved_wrong, "wrong"),
                (res.missed, "missed"),
            ):
                for item in bucket:
                    trap = item.get("trap") or "?"
                    arm = out.setdefault(trap, {}).setdefault(
                        name, {"correct": 0, "wrong": 0, "missed": 0})
                    arm[label] += 1
        return out

    def to_dict(self) -> dict[str, Any]:
        return {
            "truth_size": self.truth_size,
            "metadata_only": self.metadata.to_dict(),
            "measured_evidence": self.measured.to_dict(),
            "by_trap": self.by_trap(),
            "caveat": self.caveat,
        }


def compare(
    discovery: DiscoveryResult,
    ontology: dict[str, list[dict]],
    adapter: DataAdapter,
    truth: dict[str, Any],
    *,
    policy: Optional[AutoApprovalPolicy] = None,
    probe_limit: int = 50_000,
) -> Comparison:
    """Run both arms on the same discovery, ontology and data, and score them."""
    meta_proposals = propose_mappings(discovery, ontology, id_prefix="meta")
    auto_approve(meta_proposals, policy=policy)
    meta = score_arm(ARM_METADATA, meta_proposals, truth,
                     measurements={"profile_queries": 0})

    meas_proposals = propose_mappings(discovery, ontology, id_prefix="meas")
    proofs = enrich_classes_with_uniqueness(
        meas_proposals, adapter, discovery, probe_limit=probe_limit)
    overlaps = enrich_relationships_with_overlap(
        meas_proposals, adapter, discovery, probe_limit=probe_limit)
    auto_approve(meas_proposals, policy=policy)
    meas = score_arm(
        ARM_MEASURED, meas_proposals, truth,
        measurements={"profile_queries": len(proofs) + len(overlaps),
                      "uniqueness_proofs": len(proofs),
                      "overlap_probes": len(overlaps)},
    )

    return Comparison(metadata=meta, measured=meas, truth_size=len(truth))
