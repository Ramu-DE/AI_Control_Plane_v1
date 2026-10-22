"""Value-overlap profiling: measure a candidate join instead of guessing it.

Most real datasets have no declared foreign keys — the live `agentexpress_*`
tables in this very workspace have none — so a discoverer that only reads
constraints finds no relationships at all, and one that matches column names is
back to guessing. This module provides the third option: ASK THE DATA.

For a candidate join, measure referential containment:

    how many distinct non-null values of left.(cols) actually exist
    in right.(cols), and is right.(cols) genuinely unique?

That is a measurement, not a resemblance, which is why it is allowed to satisfy
the auto-approval gate. Name similarity never is.

TWO THINGS MUST BOTH HOLD before a profiled join may auto-approve:

  1. FULL containment (every left value is present on the right). Anything less
     means orphan rows. Real foreign keys have referential integrity; 0.98
     containment is a signal that this is NOT the relationship you think it is,
     and a human should see it.
  2. The right side is genuinely UNIQUE. Joining to a non-unique column
     fabricates edges by fan-out, so without uniqueness the "join" is not a
     foreign key at all.

HONESTY ABOUT SAMPLING. A containment figure computed from a capped sample is
not a measurement of the relation. `JoinOverlap.exhaustive` records whether the
whole relation was examined, and a non-exhaustive probe can never auto-approve —
it is evidence for a human instead. Adapters that can answer with aggregate SQL
(see `UnityCatalogDataAdapter.join_overlap`) are always exhaustive; the generic
fallback pulls rows and is exhaustive only below the cap.

stdlib only.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Sequence

from .data_adapter import DataAdapter
from .discovery import DiscoveryResult, JoinMetadata, KeyType
from .mapping import (
    Evidence,
    MappingProposal,
    ProposalKind,
    ProposalStatus,
    ValidationIssue,
)

#: Containment required before a PROFILED join may auto-approve. Full integrity
#: by default: orphans mean a human should look.
MIN_CONTAINMENT_FOR_AUTO = 1.0
#: Rows the generic fallback will pull before giving up on exhaustiveness.
DEFAULT_PROBE_LIMIT = 50_000


@dataclass(frozen=True)
class JoinOverlap:
    """The measured relationship between two column sets."""

    left_table: str
    left_columns: tuple[str, ...]
    right_table: str
    right_columns: tuple[str, ...]
    #: Distinct non-null key tuples on the left.
    left_distinct: int
    #: Of those, how many exist on the right.
    matched: int
    #: Distinct key tuples on the right, and total rows there.
    right_distinct: int
    right_rows: int
    #: True when the WHOLE relation was examined, not a sample.
    exhaustive: bool
    method: str = "aggregate"

    @property
    def containment(self) -> float:
        """Fraction of left keys present on the right. 0.0 when left is empty."""
        return (self.matched / self.left_distinct) if self.left_distinct else 0.0

    @property
    def right_is_unique(self) -> bool:
        """Whether the right columns actually identify a row."""
        return self.right_rows > 0 and self.right_distinct == self.right_rows

    @property
    def supports_auto_approval(self) -> bool:
        return (
            self.exhaustive
            and self.right_is_unique
            and self.left_distinct > 0
            and self.containment >= MIN_CONTAINMENT_FOR_AUTO
        )

    def describe(self) -> str:
        pct = self.containment * 100
        return (
            f"{self.matched}/{self.left_distinct} distinct "
            f"{self.left_table}.{list(self.left_columns)} values "
            f"({pct:.1f}%) exist in {self.right_table}.{list(self.right_columns)}; "
            f"right side {'is' if self.right_is_unique else 'is NOT'} unique "
            f"({self.right_distinct} distinct / {self.right_rows} rows); "
            f"{'exhaustive' if self.exhaustive else 'SAMPLED'}"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "left_table": self.left_table,
            "left_columns": list(self.left_columns),
            "right_table": self.right_table,
            "right_columns": list(self.right_columns),
            "left_distinct": self.left_distinct,
            "matched": self.matched,
            "containment": round(self.containment, 6),
            "right_distinct": self.right_distinct,
            "right_rows": self.right_rows,
            "right_is_unique": self.right_is_unique,
            "exhaustive": self.exhaustive,
            "method": self.method,
            "supports_auto_approval": self.supports_auto_approval,
        }


def measure_join_overlap(
    adapter: DataAdapter,
    left_table: str,
    left_columns: Sequence[str],
    right_table: str,
    right_columns: Sequence[str],
    *,
    probe_limit: int = DEFAULT_PROBE_LIMIT,
) -> JoinOverlap:
    """Measure containment, using the adapter's native path when it has one.

    An adapter that can answer in aggregate SQL returns an exhaustive result
    without moving rows. The fallback pulls the joined keys and counts in
    Python — correct, and exhaustive only while under `probe_limit`.
    """
    if len(left_columns) != len(right_columns) or not left_columns:
        raise ValueError("join overlap needs equal, non-empty column lists")

    native = getattr(adapter, "join_overlap", None)
    if callable(native):
        return native(left_table, tuple(left_columns), right_table, tuple(right_columns))

    return _fallback_overlap(
        adapter, left_table, tuple(left_columns),
        right_table, tuple(right_columns), probe_limit=probe_limit,
    )


def _fallback_overlap(
    adapter: DataAdapter,
    left_table: str,
    left_columns: tuple[str, ...],
    right_table: str,
    right_columns: tuple[str, ...],
    *,
    probe_limit: int,
) -> JoinOverlap:
    """Generic probe: read the keys and count. Works on any DataAdapter."""
    from .materialize import ANSI_DIALECT, _join_sql, _select_sql

    joined = adapter.execute(
        _join_sql(left_table, list(left_columns), right_table, list(right_columns),
                  list(zip(left_columns, right_columns)),
                  dialect=ANSI_DIALECT, limit=probe_limit + 1),
        {},
    )
    rows = joined.rows
    exhaustive = len(rows) <= probe_limit
    rows = rows[:probe_limit]

    left_keys: set[tuple] = set()
    matched_keys: set[tuple] = set()
    for row in rows:
        lk = tuple(row.get(f"d{i}") for i in range(len(left_columns)))
        rk = tuple(row.get(f"o{i}") for i in range(len(right_columns)))
        if any(v is None for v in lk):
            continue      # a null key is not a reference
        left_keys.add(lk)
        if all(v is not None for v in rk):
            matched_keys.add(lk)

    right = adapter.execute(
        _select_sql(right_table, list(right_columns),
                    dialect=ANSI_DIALECT, limit=probe_limit + 1),
        {},
    )
    right_rows_data = right.rows
    if len(right_rows_data) > probe_limit:
        exhaustive = False
        right_rows_data = right_rows_data[:probe_limit]
    right_tuples = [
        tuple(r.get(f"c{i}") for i in range(len(right_columns)))
        for r in right_rows_data
    ]
    right_present = [t for t in right_tuples if all(v is not None for v in t)]

    return JoinOverlap(
        left_table=left_table, left_columns=left_columns,
        right_table=right_table, right_columns=right_columns,
        left_distinct=len(left_keys), matched=len(matched_keys),
        right_distinct=len(set(right_present)), right_rows=len(right_present),
        exhaustive=exhaustive, method="row-probe",
    )


# --------------------------------------------------------------------------- #
# Turning a measurement into a proposal
# --------------------------------------------------------------------------- #
def candidate_column_sets(
    discovery: DiscoveryResult, left_table: str, right_table: str
) -> list[tuple[tuple[str, ...], tuple[str, ...]]]:
    """Column pairings worth probing, ordered most-likely first.

    The RIGHT side is always a declared key of the parent — a join to a
    non-key is not a foreign key, so there is nothing to profile. The LEFT side
    is any identifier-shaped column set of matching arity. Name shape is used
    only to pick what to MEASURE; it never justifies the result.
    """
    left = discovery.table(left_table)
    right = discovery.table(right_table)
    if not left or not right:
        return []

    parent_keys = [k for k in right.keys if k.key_type in (KeyType.PRIMARY, KeyType.UNIQUE)]
    if not parent_keys:
        return []

    def tautological(left_cols: tuple[str, ...], right_cols: tuple[str, ...]) -> bool:
        """A column set joined to ITSELF on the same table proves nothing.

        Containment is vacuously 1.0 and the parent key is trivially unique, so
        the measurement would "support" a reflexive edge for every row — found
        exactly this way in a live run, where a self-referential ontology
        relationship produced `<site/S1> spansRegion <site/S1>`. A genuine
        self-reference (`employee.manager_id -> employee.employee_id`) uses
        DIFFERENT columns and is still probed.
        """
        return left_table == right_table and tuple(left_cols) == tuple(right_cols)

    out: list[tuple[tuple[str, ...], tuple[str, ...]]] = []
    seen: set[tuple] = set()
    for key in parent_keys:
        arity = len(key.columns)
        if arity == 1:
            target = key.columns[0]
            for col in left.columns:
                if not col.is_identifier_like:
                    continue
                if tautological((col.name,), (target,)):
                    continue
                pair = ((col.name,), (target,))
                # Same-name first, then any identifier-shaped column.
                if pair not in seen:
                    seen.add(pair)
                    out.append(pair)
            out.sort(key=lambda p: (p[0][0] != target, p[0][0]))
        else:
            # Composite: only probe an exact column-name match, since trying
            # every permutation of identifier columns would be guesswork at
            # combinatorial cost.
            names = {c.name for c in left.columns}
            if set(key.columns) <= names and not tautological(
                    tuple(key.columns), tuple(key.columns)):
                pair = (tuple(key.columns), tuple(key.columns))
                if pair not in seen:
                    seen.add(pair)
                    out.append(pair)
    return out


def enrich_relationships_with_overlap(
    proposals: list[MappingProposal],
    adapter: DataAdapter,
    discovery: DiscoveryResult,
    *,
    probe_limit: int = DEFAULT_PROBE_LIMIT,
    max_probes: int = 40,
) -> list[JoinOverlap]:
    """Profile relationship proposals that have no declared key, in place.

    A relationship whose endpoints resolved but which found no foreign key is
    currently blocked with `no-key-evidence`. If the data shows full containment
    into a unique parent key, that block is replaced by a measured join: the
    `no-key-evidence` issue is cleared and `value-overlap` evidence is attached,
    so the normal auto-approval policy can then act on it.

    When the measurement is partial, sampled, or the parent key is not unique,
    the proposal KEEPS its blocking issue and gains the measurement as evidence
    for a human. Returns every measurement taken, for the audit trail.
    """
    measurements: list[JoinOverlap] = []
    probes = 0

    for p in proposals:
        if p.kind != ProposalKind.RELATIONSHIP or p.status != ProposalStatus.PROPOSED:
            continue
        if p.join is not None:
            continue   # a declared key already justifies it
        if not any(i.code == "no-key-evidence" for i in p.validation_issues):
            continue   # endpoints never resolved; nothing to probe
        left_table = p.domain_table
        right_table = p.target_table
        if not left_table or not right_table:
            continue

        best: Optional[JoinOverlap] = None
        for left_cols, right_cols in candidate_column_sets(discovery, left_table, right_table):
            if probes >= max_probes:
                break
            probes += 1
            try:
                m = measure_join_overlap(
                    adapter, left_table, left_cols, right_table, right_cols,
                    probe_limit=probe_limit)
            except Exception as exc:   # a probe failing must not fail the build
                p.evidence.append(Evidence(
                    "profile",
                    f"overlap probe {left_table}.{list(left_cols)} -> "
                    f"{right_table}.{list(right_cols)} failed: {exc}",
                    weight=0.0))
                continue
            measurements.append(m)
            if best is None or m.containment > best.containment:
                best = m
            if m.supports_auto_approval:
                break

        if best is None:
            continue

        p.evidence.append(Evidence(
            "value-overlap", best.describe(),
            weight=0.3 if best.supports_auto_approval else 0.05))

        if best.supports_auto_approval:
            p.join = JoinMetadata(
                left_table=best.left_table, left_columns=best.left_columns,
                right_table=best.right_table, right_columns=best.right_columns,
                cardinality="many-to-one", origin="profiled",
                name=p.ontology_label,
            )
            # The block existed because there was no key evidence. There is now.
            p.validation_issues = [
                i for i in p.validation_issues if i.code != "no-key-evidence"
            ]
            p.evidence.append(Evidence(
                "key-metadata",
                f"join profiled from data: {list(best.left_columns)} -> "
                f"{list(best.right_columns)} with full referential containment",
                weight=0.2))
            p.confidence = max(p.confidence, 0.6)
        else:
            p.validation_issues.append(ValidationIssue(
                "overlap-insufficient",
                f"profiled join is not usable without review — {best.describe()}",
                severity="warning"))

    return measurements
