"""Typed semantic query plan, planner, and SQL compiler (precision path).

The precision planner resolves concepts ONLY against a PublishedMappingSet
(approved + valid), and FAILS CLOSED on ambiguity or unmapped concepts. The
compiler emits a CompiledQuery whose SQL contains validated, quoted identifiers
and NAMED PARAMETER MARKERS only — values are never inlined. Limits are clamped.

Types:
    Projection  — a column to return (optionally aggregated)
    Filter      — column OP value (value goes to a parameter, never inline)
    Aggregation — kind (COUNT/SUM/AVG) + optional group-by projections
    JoinPath    — ordered joins connecting the referenced tables
    SemanticQueryPlan — the whole typed plan
    CompiledQuery      — { sql, parameters, ... }

stdlib only.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Optional

from .mapping import PublishedMappingSet, PublishedMapping
from .discovery import LogicalType


# --------------------------------------------------------------------------- #
# Errors — all fail-closed
# --------------------------------------------------------------------------- #
class PlanningError(ValueError):
    pass


class UnmappedConceptError(PlanningError):
    pass


class AmbiguousConceptError(PlanningError):
    pass


class CompileError(ValueError):
    pass


# --------------------------------------------------------------------------- #
# Plan types
# --------------------------------------------------------------------------- #
class AggKind(str, Enum):
    NONE = "none"
    COUNT = "count"
    SUM = "sum"
    AVG = "avg"


class FilterOp(str, Enum):
    EQ = "eq"
    ILIKE = "ilike"

    @property
    def sql(self) -> str:
        return {"eq": "=", "ilike": "ILIKE"}[self.value]


@dataclass(frozen=True)
class Projection:
    table: str
    column: str
    label: str
    aggregate: AggKind = AggKind.NONE

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["aggregate"] = self.aggregate.value
        return d


@dataclass(frozen=True)
class Filter:
    table: str
    column: str
    op: FilterOp
    value: Any

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["op"] = self.op.value
        return d


@dataclass(frozen=True)
class Aggregation:
    kind: AggKind
    group_by: tuple[Projection, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind.value, "group_by": [p.to_dict() for p in self.group_by]}


@dataclass(frozen=True)
class JoinPath:
    """An ordered list of joins (as dicts from JoinMetadata.to_dict())."""

    joins: tuple[dict, ...] = ()

    def tables(self) -> list[str]:
        out: list[str] = []
        for j in self.joins:
            for t in (j["left_table"], j["right_table"]):
                if t not in out:
                    out.append(t)
        return out

    def to_dict(self) -> dict[str, Any]:
        return {"joins": list(self.joins)}


@dataclass
class SemanticQueryPlan:
    source_id: str
    base_table: str
    projections: list[Projection] = field(default_factory=list)
    filters: list[Filter] = field(default_factory=list)
    aggregation: Aggregation = field(default_factory=lambda: Aggregation(AggKind.NONE))
    join_path: JoinPath = field(default_factory=JoinPath)
    limit: int = 100
    # Provenance of the published mapping set this plan was resolved against.
    # These make a plan auditable and reproducible: mapping_version is the
    # published set's version; set_fingerprint content-addresses exactly which
    # approved mappings were in force when the plan was built.
    mapping_version: str = ""
    set_fingerprint: str = ""

    def tables(self) -> set[str]:
        s = {self.base_table}
        for p in self.projections:
            s.add(p.table)
        for f in self.filters:
            s.add(f.table)
        s.update(self.join_path.tables())
        return s

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "base_table": self.base_table,
            "projections": [p.to_dict() for p in self.projections],
            "filters": [f.to_dict() for f in self.filters],
            "aggregation": self.aggregation.to_dict(),
            "join_path": self.join_path.to_dict(),
            "limit": self.limit,
            "mapping_version": self.mapping_version,
            "set_fingerprint": self.set_fingerprint,
        }


@dataclass(frozen=True)
class CompiledQuery:
    sql: str
    parameters: dict[str, Any]
    plan: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {"sql": self.sql, "parameters": self.parameters, "plan": self.plan}


# --------------------------------------------------------------------------- #
# Planner
# --------------------------------------------------------------------------- #
# Aggregatable logical types (for fanout/operator validation).
_NUMERIC_AGG = {AggKind.SUM, AggKind.AVG}


@dataclass(frozen=True)
class ConceptRef:
    """A concept the caller wants, resolved by ontology label or URI."""

    label: str
    is_filter: bool = False
    filter_op: FilterOp = FilterOp.ILIKE
    filter_value: Any = None


class SemanticPlanner:
    """Builds a SemanticQueryPlan from concept refs against a PublishedMappingSet.

    Fails closed:
      - a concept with NO published direct mapping -> UnmappedConceptError
      - a concept with >1 published direct mapping to different columns ->
        AmbiguousConceptError (never guess)
      - an aggregate requested on a non-numeric column -> PlanningError
      - a join that would cause many-to-many fanout without explicit allowance
        -> PlanningError
    """

    MAX_LIMIT = 1000
    DEFAULT_LIMIT = 100

    def __init__(self, published: PublishedMappingSet) -> None:
        self.published = published

    def _resolve(self, label: str) -> PublishedMapping:
        matches = self.published.direct_for_label(label)
        if not matches:
            # also allow URI
            matches = self.published.direct_for_uri(label)
        if not matches:
            raise UnmappedConceptError(
                f"concept '{label}' has no approved+published mapping")
        targets = {(m.target_table, m.target_column) for m in matches}
        if len(targets) > 1:
            raise AmbiguousConceptError(
                f"concept '{label}' is ambiguous: resolves to {sorted(targets)}")
        return matches[0]

    def plan(
        self,
        select: list[str],
        *,
        filters: Optional[list[ConceptRef]] = None,
        aggregate: AggKind = AggKind.NONE,
        group_by: Optional[list[str]] = None,
        limit: Optional[int] = None,
    ) -> SemanticQueryPlan:
        filters = filters or []
        group_by = group_by or []

        sel_maps = [self._resolve(lbl) for lbl in select]
        filt_specs = [(self._resolve(f.label), f) for f in filters]
        group_maps = [self._resolve(lbl) for lbl in group_by]

        # Determine involved tables and base table deterministically.
        involved = []
        for m in sel_maps + [fm for fm, _ in filt_specs] + group_maps:
            if m.target_table and m.target_table not in involved:
                involved.append(m.target_table)
        if not involved:
            raise PlanningError("no tables resolved from concepts")
        base_table = sorted(involved)[0]

        # Build projections.
        projections: list[Projection] = []
        for m in sel_maps:
            agg = AggKind.NONE
            if aggregate in _NUMERIC_AGG:
                # Only aggregate a column if it is a numeric measure; validate.
                if not self._is_numeric(m):
                    raise PlanningError(
                        f"cannot apply {aggregate.value.upper()} to non-numeric "
                        f"concept '{m.ontology_label}' ({m.target_table}.{m.target_column})")
                agg = aggregate
            projections.append(Projection(
                table=m.target_table, column=m.target_column,
                label=_safe_label(m.ontology_label), aggregate=agg))

        group_projections = tuple(
            Projection(table=m.target_table, column=m.target_column,
                       label=_safe_label(m.ontology_label))
            for m in group_maps
        )
        agg_spec = Aggregation(kind=aggregate, group_by=group_projections)

        # Build filters (values flow to parameters at compile time).
        plan_filters: list[Filter] = []
        for m, ref in filt_specs:
            # ILIKE is a TEXT operator: permit it only on string columns, using
            # the discovered logical type as the sole authority (never the
            # column name). Fail closed on a text match against a non-text type.
            if ref.filter_op == FilterOp.ILIKE and not self._is_text(m):
                raise PlanningError(
                    f"cannot apply ILIKE to non-text concept "
                    f"'{m.ontology_label}' ({m.target_table}.{m.target_column}) "
                    f"of logical type '{m.logical_type}'")
            plan_filters.append(Filter(
                table=m.target_table, column=m.target_column,
                op=ref.filter_op, value=ref.filter_value))

        # Resolve join path from published relationship joins (fail closed on
        # fanout; NO universal join key).
        join_path = self._resolve_joins(base_table, involved)

        clamped = self._clamp_limit(limit)
        return SemanticQueryPlan(
            source_id=self.published.source_id, base_table=base_table,
            projections=projections, filters=plan_filters,
            aggregation=agg_spec, join_path=join_path, limit=clamped,
            mapping_version=self.published.mapping_version,
            set_fingerprint=self.published.set_fingerprint)

    def _clamp_limit(self, limit: Optional[int]) -> int:
        if limit is None:
            return self.DEFAULT_LIMIT
        if limit < 1:
            return 1
        return min(int(limit), self.MAX_LIMIT)

    @staticmethod
    def _is_numeric(m: PublishedMapping) -> bool:
        # Authority is the DISCOVERED logical type carried on the published
        # mapping — NEVER the column name. SUM/AVG are permitted only for
        # integer/decimal columns; anything else (string, date, unknown) fails
        # closed. This is the single source of type truth.
        return m.logical_type in (LogicalType.INTEGER.value, LogicalType.DECIMAL.value)

    @staticmethod
    def _is_text(m: PublishedMapping) -> bool:
        # Authority is the DISCOVERED logical type. ILIKE is only valid on text.
        return m.logical_type == LogicalType.STRING.value

    def _resolve_joins(self, base_table: str, involved: list[str]) -> JoinPath:
        if len(involved) <= 1:
            return JoinPath()
        available = self.published.joins()
        needed = set(involved)
        reachable = {base_table}
        used: list[dict] = []
        progressed = True
        while progressed and not needed.issubset(reachable):
            progressed = False
            for j in available:
                lt, rt = j["left_table"], j["right_table"]
                if lt in reachable and rt not in reachable:
                    self._guard_fanout(j)
                    used.append(j)
                    reachable.add(rt)
                    progressed = True
                elif rt in reachable and lt not in reachable:
                    self._guard_fanout(j)
                    used.append(j)
                    reachable.add(lt)
                    progressed = True
        if not needed.issubset(reachable):
            raise PlanningError(
                f"cannot connect tables {sorted(needed)} with published joins; "
                f"reachable={sorted(reachable)} (no universal join key is assumed)")
        return JoinPath(joins=tuple(used))

    @staticmethod
    def _guard_fanout(join: dict) -> None:
        if join.get("cardinality") == "many-to-many":
            raise PlanningError(
                f"join {join.get('name')} is many-to-many; refusing to plan a "
                "fan-out join without an explicit resolution (fail closed)")


def _safe_label(label: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", label).strip("_") or "col"


# --------------------------------------------------------------------------- #
# Compiler
# --------------------------------------------------------------------------- #
_VALID_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _quote_ident(name: str) -> str:
    """Validate then double-quote an identifier. Rejects anything unsafe."""
    if not _VALID_IDENT.match(name or ""):
        raise CompileError(f"invalid identifier: {name!r}")
    return '"' + name + '"'


class SqlCompiler:
    """Compile a SemanticQueryPlan into a CompiledQuery (validated SQL + params).

    Guarantees:
      - every identifier is validated against a strict pattern and double-quoted;
      - every value is bound to a NAMED parameter (`:p0`, `:p1`, ...) — never
        inlined into the SQL string;
      - the LIMIT is a clamped integer literal (safe; not user text);
      - aliases are generated, never taken from input.
    """

    def __init__(self, schema_prefix: str = "") -> None:
        # Optional fully-qualified prefix like `catalog`.`schema`. Validated and
        # quoted per-part. Empty => bare table names (used by the offline fixture).
        self.schema_prefix = schema_prefix

    def _qualified(self, table: str) -> str:
        parts = [p for p in self.schema_prefix.split(".") if p] if self.schema_prefix else []
        quoted = [_quote_ident(p) for p in parts] + [_quote_ident(table)]
        return ".".join(quoted)

    def compile(self, plan: SemanticQueryPlan) -> CompiledQuery:
        if not plan.projections:
            raise CompileError("plan has no projections")

        # Alias every involved table deterministically.
        tables = [plan.base_table] + [t for t in sorted(plan.tables()) if t != plan.base_table]
        alias = {t: f"t{i}" for i, t in enumerate(tables)}

        params: dict[str, Any] = {}
        agg = plan.aggregation.kind

        # SELECT
        select_parts: list[str] = []
        if agg == AggKind.COUNT:
            select_parts.append("COUNT(*) AS " + _quote_ident("record_count"))
        for p in plan.projections:
            a = alias[p.table]
            col = f"{a}.{_quote_ident(p.column)}"
            lbl = _quote_ident(p.label)
            if p.aggregate == AggKind.SUM:
                select_parts.append(f"SUM({col}) AS {_quote_ident('total_' + p.label)}")
            elif p.aggregate == AggKind.AVG:
                select_parts.append(f"AVG({col}) AS {_quote_ident('avg_' + p.label)}")
            elif agg == AggKind.COUNT:
                # under COUNT, non-aggregated projections become group dimensions
                select_parts.append(f"{col} AS {lbl}")
            else:
                select_parts.append(f"{col} AS {lbl}")

        # FROM + JOINs
        base_a = alias[plan.base_table]
        from_clause = f"{self._qualified(plan.base_table)} AS {base_a}"
        join_sql = []
        present = {plan.base_table}
        for j in plan.join_path.joins:
            lt, rt = j["left_table"], j["right_table"]
            # Bring in whichever side is not already in the FROM graph.
            if lt in present and rt not in present:
                target = rt
            elif rt in present and lt not in present:
                target = lt
            elif lt not in present and rt not in present:
                # neither present yet: attach left as the anchor, bring in right
                target = rt
                present.add(lt)
            else:
                # both present already — join still needed as a constraint edge
                target = rt
            conds = " AND ".join(
                f"{alias[lt]}.{_quote_ident(lc)} = {alias[rt]}.{_quote_ident(rc)}"
                for lc, rc in zip(j["left_columns"], j["right_columns"])
            )
            join_sql.append(
                f"LEFT JOIN {self._qualified(target)} AS {alias[target]} ON {conds}")
            present.add(target)

        # WHERE (named parameters only)
        where_parts = []
        for i, f in enumerate(plan.filters):
            a = alias[f.table]
            pname = f"p{i}"
            params[pname] = f"%{f.value}%" if f.op == FilterOp.ILIKE else f.value
            where_parts.append(f"{a}.{_quote_ident(f.column)} {f.op.sql} :{pname}")

        # GROUP BY
        group_parts = []
        if agg == AggKind.COUNT:
            for p in plan.projections:
                group_parts.append(f"{alias[p.table]}.{_quote_ident(p.column)}")
        elif agg in _NUMERIC_AGG:
            for gp in plan.aggregation.group_by:
                group_parts.append(f"{alias[gp.table]}.{_quote_ident(gp.column)}")
            # non-aggregated projections must also be grouped
            for p in plan.projections:
                if p.aggregate == AggKind.NONE:
                    group_parts.append(f"{alias[p.table]}.{_quote_ident(p.column)}")

        # Also emit group_by projections in SELECT for SUM/AVG
        if agg in _NUMERIC_AGG:
            for gp in plan.aggregation.group_by:
                select_parts.append(
                    f"{alias[gp.table]}.{_quote_ident(gp.column)} AS {_quote_ident(gp.label)}")

        sql = "SELECT " + ", ".join(select_parts)
        sql += " FROM " + from_clause
        for js in join_sql:
            sql += " " + js
        if where_parts:
            sql += " WHERE " + " AND ".join(where_parts)
        if group_parts:
            # de-dup while preserving order
            seen, uniq = set(), []
            for g in group_parts:
                if g not in seen:
                    seen.add(g)
                    uniq.append(g)
            sql += " GROUP BY " + ", ".join(uniq)
        sql += f" LIMIT {int(plan.limit)}"

        return CompiledQuery(sql=sql, parameters=params, plan=plan.to_dict())
