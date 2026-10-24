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
from .discovery import (
    DiscoveryResult, JoinMetadata, KeyMetadata, KeyType, LogicalType)
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


#: A uniqueness proof over fewer rows than this says nothing useful about the
#: column: a one-row table is trivially unique.
MIN_ROWS_FOR_UNIQUENESS_PROOF = 2


@dataclass(frozen=True)
class UniquenessProof:
    """Whether a column set actually identifies a row, measured.

    This is what lets a table with no declared constraint still be keyed —
    honestly. Note what it is NOT: a guarantee. It is a point-in-time
    measurement that expires the moment a row is inserted, which is why
    `enrich_classes_with_uniqueness` re-measures on every build rather than
    trusting a previous proof. Worth knowing that a DECLARED Unity Catalog key
    is no stronger: UC constraints are informational and unenforced, so a
    measured proof taken during this build is in fact the fresher evidence.
    """

    table: str
    columns: tuple[str, ...]
    rows: int
    non_null_rows: int
    distinct: int
    exhaustive: bool
    method: str = "aggregate-sql"

    @property
    def is_non_null(self) -> bool:
        return self.rows > 0 and self.non_null_rows == self.rows

    @property
    def is_unique(self) -> bool:
        return self.non_null_rows > 0 and self.distinct == self.non_null_rows

    @property
    def proves_identity(self) -> bool:
        """Unique AND complete AND measured over the whole table.

        Non-nullness matters as much as uniqueness: `materialize.py` skips a row
        whose key is NULL or empty, so a nullable column would silently drop
        entities rather than identify them.
        """
        return (
            self.exhaustive
            and self.is_unique
            and self.is_non_null
            and self.rows >= MIN_ROWS_FOR_UNIQUENESS_PROOF
        )

    def describe(self) -> str:
        return (
            f"{self.table}.{list(self.columns)}: {self.distinct} distinct over "
            f"{self.non_null_rows} non-null of {self.rows} row(s) — "
            f"{'unique' if self.is_unique else 'NOT unique'}, "
            f"{'no nulls' if self.is_non_null else 'HAS NULLS'}, "
            f"{'exhaustive' if self.exhaustive else 'SAMPLED'}"
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "table": self.table,
            "columns": list(self.columns),
            "rows": self.rows,
            "non_null_rows": self.non_null_rows,
            "distinct": self.distinct,
            "is_unique": self.is_unique,
            "is_non_null": self.is_non_null,
            "exhaustive": self.exhaustive,
            "method": self.method,
            "proves_identity": self.proves_identity,
        }


def verify_uniqueness(
    adapter: DataAdapter,
    table: str,
    columns: Sequence[str],
    *,
    probe_limit: int = DEFAULT_PROBE_LIMIT,
) -> UniquenessProof:
    """Measure whether `columns` identify a row in `table`.

    Uses the adapter's native aggregate path when it has one, so the answer is
    exact at any table size. The generic fallback reads rows and is exhaustive
    only under `probe_limit` — and a non-exhaustive proof proves nothing, which
    `proves_identity` enforces.
    """
    if not columns:
        raise ValueError("uniqueness needs at least one column")

    native = getattr(adapter, "verify_uniqueness", None)
    if callable(native):
        return native(table, tuple(columns))

    from .materialize import ANSI_DIALECT, _select_sql

    res = adapter.execute(
        _select_sql(table, list(columns), dialect=ANSI_DIALECT,
                    limit=probe_limit + 1),
        {},
    )
    rows = res.rows
    exhaustive = len(rows) <= probe_limit
    rows = rows[:probe_limit]
    tuples = [tuple(r.get(f"c{i}") for i in range(len(columns))) for r in rows]
    # Match materialize.py, which treats "" as a missing key just like None.
    present = [t for t in tuples
               if all(v is not None and str(v) != "" for v in t)]
    return UniquenessProof(
        table=table, columns=tuple(columns), rows=len(tuples),
        non_null_rows=len(present), distinct=len(set(present)),
        exhaustive=exhaustive, method="row-probe",
    )


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
    discovery: DiscoveryResult,
    left_table: str,
    right_table: str,
    *,
    parent_key_columns: Optional[tuple[str, ...]] = None,
) -> list[tuple[tuple[str, ...], tuple[str, ...]]]:
    """Column pairings worth probing, ordered most-likely first.

    The RIGHT side is a key of the parent — a join to a non-key is not a
    foreign key, so there is nothing to profile. `parent_key_columns` lets a key
    established by MEASUREMENT stand in when the catalog declares none;
    without it the two profiling features would not compose, and on a
    constraint-free schema (the common real case) join profiling would find no
    candidates at all and silently produce an edgeless graph.

    The LEFT side is any type-compatible column, RANKED. Name shape decides
    what to MEASURE; it never justifies the result.
    """
    left = discovery.table(left_table)
    right = discovery.table(right_table)
    if not left or not right:
        return []

    parent_keys = [k for k in right.keys if k.key_type in (KeyType.PRIMARY, KeyType.UNIQUE)]
    if not parent_keys and parent_key_columns:
        parent_keys = [KeyMetadata(KeyType.UNIQUE, tuple(parent_key_columns),
                                   name="measured-subject-key")]
    if not parent_keys:
        return []

    from .mapping import name_similarity

    right_by_name = {c.name: c for c in right.columns}

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
    ranked: list[tuple[tuple, tuple, tuple]] = []   # (sort_key, left, right)
    seen: set[tuple] = set()
    for key in parent_keys:
        arity = len(key.columns)
        if arity == 1:
            target = key.columns[0]
            target_col = right_by_name.get(target)
            for col in left.columns:
                if tautological((col.name,), (target,)):
                    continue
                # A key cannot be implemented by a column of a different type,
                # so this excludes the whole numeric-measure family (`qty`
                # against a STRING key) without needing a name rule for it.
                if target_col is not None \
                        and col.logical_type != LogicalType.UNKNOWN \
                        and target_col.logical_type != LogicalType.UNKNOWN \
                        and col.logical_type != target_col.logical_type:
                    continue
                pair = ((col.name,), (target,))
                if pair in seen:
                    continue
                seen.add(pair)
                # Rank by how likely this column is to BE the key, so a bounded
                # probe budget is spent on the plausible candidates first.
                # Alphabetical order (the previous tiebreak) spent it on
                # `attr_1, attr_10, …` and never reached the real foreign key.
                sort_key = (
                    col.name != target,                 # exact name match wins
                    not col.is_identifier_like,          # then id-shaped names
                    -round(max(name_similarity(col.name, target),
                               name_similarity(col.name, right_table)), 4),
                    col.nullable,                        # not-null before nullable
                    col.name,                            # stable tiebreak
                )
                ranked.append((sort_key, pair[0], pair[1]))
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
                    # A composite exact-name match is the strongest signal
                    # available, so it leads.
                    ranked.append(((False, False, -1.0, False, ""), pair[0], pair[1]))

    ranked.sort(key=lambda r: r[0])
    out = [(left_cols, right_cols) for _k, left_cols, right_cols in ranked]
    return out


def _subject_keys_from_proposals(
    proposals: list[MappingProposal],
) -> dict[str, tuple[str, ...]]:
    """Subject keys the CLASS proposals have settled on, declared or measured.

    Discovery only knows what the catalog declares, so a key established by
    `enrich_classes_with_uniqueness` lives on the proposal. Join profiling needs
    it, or the two features cannot compose.
    """
    out: dict[str, tuple[str, ...]] = {}
    for p in proposals:
        if p.kind == ProposalKind.CLASS and p.target_table and p.subject_columns:
            if p.status != ProposalStatus.REJECTED:
                out.setdefault(p.target_table, tuple(p.subject_columns))
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
    subject_keys = _subject_keys_from_proposals(proposals)
    cache: dict[tuple, JoinOverlap] = {}

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

        # The budget is PER PROPOSAL. A single wide table used to exhaust one
        # global budget and starve every later relationship, silently.
        probes = 0
        best: Optional[JoinOverlap] = None
        qualifying: list[JoinOverlap] = []
        candidates = candidate_column_sets(
            discovery, left_table, right_table,
            parent_key_columns=subject_keys.get(right_table))
        starved = False
        for left_cols, right_cols in candidates:
            if probes >= max_probes:
                starved = True
                break
            cache_key = (left_table, left_cols, right_table, right_cols)
            if cache_key in cache:
                m = cache[cache_key]
                measurements.append(m)
                if best is None or m.containment > best.containment:
                    best = m
                if m.supports_auto_approval:
                    qualifying.append(m)
                continue
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
            cache[cache_key] = m
            measurements.append(m)
            if best is None or m.containment > best.containment:
                best = m
            if m.supports_auto_approval:
                qualifying.append(m)
                # NOTE: we do NOT stop here. Stopping at the first qualifying
                # column is cheaper, but it cannot tell a single clear answer
                # from several equally good ones — and with a widened shortlist
                # the ambiguous case is the dangerous one.

        if starved:
            # "We stopped looking" must never read like "we looked and found
            # nothing": they call for different actions.
            p.validation_issues.append(ValidationIssue(
                "overlap-probe-budget",
                f"probe budget ({max_probes}) exhausted after {probes} of "
                f"{len(candidates)} candidate(s) for "
                f"{left_table} -> {right_table}; no conclusion was reached",
                severity="warning"))

        if len(qualifying) > 1:
            # AMBIGUITY BLOCKS AUTOMATION. Several columns fully contain into
            # the parent key, so picking one is a guess dressed as a
            # measurement. A low-cardinality attribute can reach full
            # containment by coincidence, which is exactly what widening the
            # shortlist makes more likely.
            options = ", ".join(f"{list(m.left_columns)}" for m in qualifying)
            p.evidence.extend(
                Evidence("value-overlap", m.describe(), weight=0.05)
                for m in qualifying
            )
            p.validation_issues.append(ValidationIssue(
                "overlap-ambiguous",
                f"{len(qualifying)} column(s) fully contain into "
                f"{right_table}.{list(qualifying[0].right_columns)} ({options}); "
                f"a reviewer must choose which one implements this relationship",
                severity="warning"))
            continue

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


# --------------------------------------------------------------------------- #
# Subject identity from measurement
# --------------------------------------------------------------------------- #
def enrich_classes_with_uniqueness(
    proposals: list[MappingProposal],
    adapter: DataAdapter,
    discovery: DiscoveryResult,
    *,
    probe_limit: int = DEFAULT_PROBE_LIMIT,
    max_probes: int = 20,
) -> list[UniquenessProof]:
    """Unblock CLASS proposals whose table has no DECLARED key, by measuring.

    A class with no declared key carries a blocking `no-subject-key` issue, so
    it cannot be approved at all — not even by a human. That is right when the
    alternative is inferring identity from a `*_id`-shaped NAME, and wrong when
    the data can simply be asked.

    On proof the subject key is set, the block is cleared, and
    `uniqueness-verified` evidence is attached. Without proof the block REMAINS
    and the measurement is recorded as a warning, so a reviewer sees the number
    rather than a bare refusal.

    Name shape chooses what to MEASURE; it never decides the outcome.
    """
    proofs: list[UniquenessProof] = []
    probes = 0
    uniqueness_cache: dict[tuple[str, str], UniquenessProof] = {}

    for p in proposals:
        if p.kind != ProposalKind.CLASS or p.status != ProposalStatus.PROPOSED:
            continue
        if p.subject_columns:
            continue   # a declared key already identifies this class
        if not any(i.code == "no-subject-key" for i in p.validation_issues):
            continue
        table = discovery.table(p.target_table or "")
        if table is None:
            continue

        # Pass 0 — the ONTOLOGY's own declaration (owl:hasKey), resolved to
        # columns by the proposer. Declared by the ontology owner, so name
        # shape is irrelevant; adopted only if the data confirms it. If it
        # fails, that is reported and the shape-based passes still run.
        if p.key_candidate and probes < max_probes:
            probes += 1
            try:
                declared = verify_uniqueness(adapter, table.name, tuple(p.key_candidate),
                                             probe_limit=probe_limit)
            except Exception as exc:
                declared = None
                p.evidence.append(Evidence(
                    "profile", f"owl:hasKey probe {table.name}.{list(p.key_candidate)} "
                               f"failed: {exc}", weight=0.0))
            if declared is not None:
                proofs.append(declared)
                if declared.proves_identity:
                    p.evidence.append(Evidence(
                        "uniqueness-verified",
                        f"owl:hasKey {list(p.key_candidate)} confirmed: {declared.describe()}",
                        weight=0.2))
                    p.subject_columns = tuple(p.key_candidate)
                    p.validation_issues = [
                        i for i in p.validation_issues if i.code != "no-subject-key"]
                    continue
                p.validation_issues.append(ValidationIssue(
                    "haskey-not-unique",
                    f"the ontology declares {list(p.key_candidate)} as the key of "
                    f"'{table.name}', but the data does not confirm it: {declared.describe()}",
                    severity="warning"))

        starved = False
        adoptable: list[UniquenessProof] = []
        reported: list[UniquenessProof] = []
        candidates = _identity_candidates(table)

        def probe(col: str) -> Optional[UniquenessProof]:
            """Measure one column, reusing a previous answer for the same one.

            The proposer emits a CLASS candidate per (ontology class, table)
            pair, so the same table is reached several times. Without the cache
            each one re-ran the same SQL.
            """
            nonlocal probes, starved
            cache_key = (table.name, col)
            if cache_key in uniqueness_cache:
                return uniqueness_cache[cache_key]
            if probes >= max_probes:
                starved = True
                return None
            probes += 1
            try:
                proof = verify_uniqueness(adapter, table.name, (col,),
                                          probe_limit=probe_limit)
            except Exception as exc:
                p.evidence.append(Evidence(
                    "profile",
                    f"uniqueness probe {table.name}.{col} failed: {exc}",
                    weight=0.0))
                return None
            uniqueness_cache[cache_key] = proof
            proofs.append(proof)
            return proof

        # Pass 1 — only columns that could actually BE adopted.
        for col, may_adopt in candidates:
            if not may_adopt:
                continue
            proof = probe(col)
            if proof is None:
                break
            if proof.proves_identity:
                adoptable.append(proof)

        # Pass 2 — COMPOSITE keys, if no single column identifies a row. This
        # is not an edge case: a junction table's identity is normally the pair
        # of foreign keys it joins, so without this a constraint-free junction
        # can never be keyed and every edge through it is lost. Pairs only, and
        # only of key-shaped columns, to keep the cost linear-ish rather than
        # exponential.
        if not adoptable and not starved:
            # Composite columns are taken in TABLE COLUMN ORDER, not the
            # ranked order used for single-column probing. A measured key has
            # no inherent order, but the subject IRI embeds one, so the choice
            # must be canonical: a declared primary key is normally declared in
            # column order, and matching it means a table later gaining that
            # constraint mints the SAME IRIs instead of a parallel node set.
            adoptable_set = {c for c, may_adopt in candidates if may_adopt}
            shaped = [c.name for c in table.columns if c.name in adoptable_set]
            for i in range(len(shaped)):
                for j in range(i + 1, len(shaped)):
                    if probes >= max_probes:
                        starved = True
                        break
                    cols = (shaped[i], shaped[j])
                    cache_key = (table.name, "+".join(cols))
                    if cache_key in uniqueness_cache:
                        proof = uniqueness_cache[cache_key]
                    else:
                        probes += 1
                        try:
                            proof = verify_uniqueness(adapter, table.name, cols,
                                                      probe_limit=probe_limit)
                        except Exception as exc:
                            p.evidence.append(Evidence(
                                "profile",
                                f"uniqueness probe {table.name}.{list(cols)} "
                                f"failed: {exc}", weight=0.0))
                            continue
                        uniqueness_cache[cache_key] = proof
                        proofs.append(proof)
                    if proof.proves_identity:
                        adoptable.append(proof)
                if adoptable or starved:
                    break

        # Pass 3 — the non-key-shaped columns, and ONLY if nothing above worked.
        # Probing them otherwise costs two SQL statements each to learn
        # something that can never be acted on.
        if not adoptable and not starved:
            for col, may_adopt in candidates:
                if may_adopt:
                    continue
                proof = probe(col)
                if proof is None:
                    break
                if proof.proves_identity:
                    reported.append(proof)

        if starved and not adoptable:
            # Never let "we stopped looking" read like "we looked and found
            # nothing" — they call for different actions.
            p.validation_issues.append(ValidationIssue(
                "uniqueness-probe-budget",
                f"ran out of uniqueness probes before testing every candidate "
                f"column of '{table.name}'; no conclusion was reached",
                severity="warning"))

        # Anything unique but not key-shaped is surfaced for a reviewer, never
        # adopted: a reviewer who knows the domain can approve it, the machine
        # cannot tell it from an accident.
        for proof in reported:
            p.evidence.append(Evidence("profile", proof.describe(), weight=0.0))

        if len(adoptable) > 1:
            # Several key-shaped columns identify a row, so which one IS the
            # identity is a modelling decision, not a measurement.
            options = ", ".join(str(list(pr.columns)) for pr in adoptable)
            for pr in adoptable:
                p.evidence.append(Evidence("profile", pr.describe(), weight=0.0))
            p.validation_issues.append(ValidationIssue(
                "uniqueness-ambiguous",
                f"{len(adoptable)} candidate key(s) of '{table.name}' each "
                f"identify a row ({options}); a reviewer must choose which is "
                f"the subject identity",
                severity="warning"))
            continue

        if adoptable:
            proof = adoptable[0]
            p.evidence.append(Evidence(
                "uniqueness-verified", proof.describe(), weight=0.2))
            p.subject_columns = tuple(proof.columns)
            p.validation_issues = [
                i for i in p.validation_issues if i.code != "no-subject-key"
            ]
        elif not starved:
            detail = (f"; {len(reported)} non-key-shaped column(s) are unique "
                      f"and could be approved by a reviewer" if reported else "")
            p.validation_issues.append(ValidationIssue(
                "uniqueness-unproven",
                f"no candidate key of '{table.name}' was measured to identify "
                f"a row{detail}",
                severity="warning"))

    return proofs


def _identity_candidates(table) -> list[tuple[str, bool]]:
    """Columns worth probing as identity, with whether one may be ADOPTED.

    The asymmetry with join profiling is deliberate, not an inconsistency. A
    join is evidenced by containment into a *known parent key* — strong, and
    specific to that relationship, so the shortlist can be wide and the
    measurement can decide. Identity is evidenced only by uniqueness, which is
    weak: ANY high-cardinality column is unique, so a `cust_name` or a
    `description` would qualify. Adopting one as identity is how a graph ends up
    keyed on a display name, which conflates entities the moment two of them
    share it.

    So a column may be ADOPTED only if its name also signals identity
    (identifier-shaped, or token-matching the table name). Other unique columns
    are still probed and REPORTED, so a reviewer who knows the domain can
    approve one — the machine simply cannot tell such a column from an accident.

    Measures are excluded entirely: a DECIMAL amount is not identity even when
    it happens to be unique today.
    """
    from .mapping import name_similarity

    usable = (LogicalType.STRING, LogicalType.INTEGER, LogicalType.UUID)
    out: list[tuple[str, bool]] = []
    for col in table.columns:
        if col.logical_type not in usable:
            continue
        shaped = col.is_identifier_like
        table_like = name_similarity(col.name, table.name) >= 1.0
        out.append((col.name, bool(shaped or table_like)))
    # Adoptable first, non-null before nullable, then stable by name.
    nullable = {c.name: c.nullable for c in table.columns}
    out.sort(key=lambda t: (not t[1], nullable.get(t[0], True), t[0]))
    return out
