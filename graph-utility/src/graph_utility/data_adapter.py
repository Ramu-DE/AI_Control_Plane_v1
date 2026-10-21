"""Structured DataAdapter — the STRUCTURED data-plane seam (precision path).

This is deliberately split from the retrieval seam (`retriever.py`). A
`DataAdapter`:
  1. discovers typed, data-agnostic metadata + bounded masked profiles
     (`DiscoveryResult`), and
  2. executes a `CompiledQuery` (validated SQL + named parameters) and returns
     typed rows.

It knows NOTHING about ontologies, mappings or ContractIQ. The legacy
`backends.BackendAdapter` (registry/execute_sql/vector_search) is preserved for
OMDAEngine compatibility; this new seam is the clean, precision-first contract.

`InMemoryDataAdapter` is an offline fixture backend: give it tables (metadata +
rows) and it answers discovery/profiling and a *safe subset* of parameterized
SQL entirely in Python — no Spark, no network. It is the backbone of the
offline tests.
"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any, Optional

from .discovery import (
    ColumnMetadata,
    ColumnProfile,
    DiscoveryResult,
    JoinMetadata,
    KeyMetadata,
    LogicalType,
    TableMetadata,
    TableProfile,
    looks_like_identifier,
    looks_like_measure,
    profile_samples,
)


@dataclass
class QueryResult:
    columns: list[str]
    rows: list[dict[str, Any]]

    @property
    def row_count(self) -> int:
        return len(self.rows)

    def to_dict(self) -> dict[str, Any]:
        return {"columns": self.columns, "rows": self.rows, "row_count": self.row_count}


# --------------------------------------------------------------------------- #
# The seam
# --------------------------------------------------------------------------- #
class DataAdapter(ABC):
    """Contract every STRUCTURED backend satisfies for the precision path."""

    source_id: str

    @abstractmethod
    def discover(self) -> DiscoveryResult:
        """Return typed, data-agnostic metadata + bounded masked profiles."""

    @abstractmethod
    def execute(self, sql: str, parameters: dict[str, Any]) -> QueryResult:
        """Execute a COMPILED query: validated SQL + named parameter bindings.

        Implementations MUST use the parameter map for values and MUST NOT
        require the caller to inline literals into `sql`.
        """


# --------------------------------------------------------------------------- #
# Offline in-memory fixture adapter
# --------------------------------------------------------------------------- #
@dataclass
class InMemoryTable:
    metadata: TableMetadata
    rows: list[dict[str, Any]]


# A very small, SAFE SQL subset parser for the fixture engine. It exists only so
# offline tests can execute the compiler's output without a database. It accepts
# exactly the shape the compiler emits and rejects everything else.
_SELECT_RE = re.compile(
    r"^SELECT\s+(?P<select>.+?)\s+FROM\s+(?P<from>.+?)"
    r"(?:\s+WHERE\s+(?P<where>.+?))?"
    r"(?:\s+GROUP BY\s+(?P<group>.+?))?"
    r"(?:\s+LIMIT\s+(?P<limit>\d+))?\s*$",
    re.IGNORECASE | re.DOTALL,
)
_PARAM_RE = re.compile(r":([A-Za-z_][A-Za-z0-9_]*)")
_IDENT_RE = re.compile(r'"([^"]+)"')


class InMemoryDataAdapter(DataAdapter):
    """Offline fixture backend: discovery + a safe parameterized SELECT engine.

    The SQL engine supports only what the precision compiler produces:
    quoted identifiers, a base table with optional equijoins, equality/ILIKE
    filters bound to NAMED parameters, optional COUNT(*)/SUM/AVG with GROUP BY,
    and LIMIT. It never interprets inlined literals — all values must arrive via
    the `parameters` map, matching the real backend contract.
    """

    def __init__(self, source_id: str, tables: list[InMemoryTable],
                 joins: Optional[list[JoinMetadata]] = None) -> None:
        self.source_id = source_id
        self._tables = {t.metadata.name: t for t in tables}
        self._joins = list(joins or [])

    # --- discovery ---
    def discover(self) -> DiscoveryResult:
        tables = tuple(self._enrich(t.metadata) for t in self._tables.values())
        profiles = tuple(self._profile(t) for t in self._tables.values())
        return DiscoveryResult(
            source_id=self.source_id,
            tables=tables,
            joins=tuple(self._joins),
            profiles=profiles,
        )

    @staticmethod
    def _enrich(meta: TableMetadata) -> TableMetadata:
        enriched = tuple(
            ColumnMetadata(
                name=c.name,
                logical_type=c.logical_type,
                native_type=c.native_type,
                nullable=c.nullable,
                is_identifier_like=looks_like_identifier(c.name, c.logical_type),
                is_measure_like=looks_like_measure(c.logical_type),
                comment=c.comment,
            )
            for c in meta.columns
        )
        return TableMetadata(
            name=meta.name, columns=enriched, keys=meta.keys,
            kind=meta.kind, comment=meta.comment,
        )

    def _profile(self, t: InMemoryTable) -> TableProfile:
        col_profiles = []
        for col in t.metadata.columns:
            values = [r.get(col.name) for r in t.rows]
            non_null = [v for v in values if v is not None]
            lengths = [len(str(v)) for v in non_null]
            col_profiles.append(ColumnProfile(
                column=col.name,
                logical_type=col.logical_type,
                non_null_count=len(non_null),
                null_count=len(values) - len(non_null),
                distinct_estimate=len({str(v) for v in non_null}),
                masked_samples=profile_samples(non_null, col.logical_type),
                min_length=min(lengths) if lengths else None,
                max_length=max(lengths) if lengths else None,
            ))
        return TableProfile(
            table=t.metadata.name,
            row_estimate=len(t.rows),
            column_profiles=tuple(col_profiles),
            sampled=True,
        )

    # --- execution (safe parameterized subset) ---
    def execute(self, sql: str, parameters: dict[str, Any]) -> QueryResult:
        parameters = parameters or {}
        m = _SELECT_RE.match(sql.strip())
        if not m:
            raise ValueError("InMemoryDataAdapter: unsupported SQL shape")

        # Every parameter marker in the SQL must have a binding (fail closed).
        for pname in _PARAM_RE.findall(sql):
            if pname not in parameters:
                raise ValueError(f"missing binding for parameter :{pname}")

        from_clause = m.group("from").strip()
        base_table, alias_map, join_specs = self._parse_from(from_clause)

        rows = self._materialize(base_table, alias_map, join_specs)
        rows = self._apply_where(rows, m.group("where"), parameters, alias_map)

        select_items = self._parse_select(m.group("select"))
        group = m.group("group")
        if any(it["agg"] for it in select_items) or group:
            out_cols, out_rows = self._aggregate(rows, select_items, group, alias_map)
        else:
            out_cols, out_rows = self._project(rows, select_items)

        limit = m.group("limit")
        if limit is not None:
            out_rows = out_rows[: int(limit)]
        return QueryResult(columns=out_cols, rows=out_rows)

    # --- FROM / JOIN parsing ---
    def _parse_from(self, clause: str):
        # Pattern: "db"."schema"."tbl" AS t0 [LEFT JOIN ... AS tN ON ... = ...]*
        parts = re.split(r"\bLEFT JOIN\b", clause, flags=re.IGNORECASE)
        base = parts[0].strip()
        base_table, base_alias = self._parse_table_ref(base)
        alias_map = {base_alias: base_table}
        join_specs = []
        for p in parts[1:]:
            on_split = re.split(r"\bON\b", p, flags=re.IGNORECASE)
            tref, cond = on_split[0], on_split[1]
            jt, ja = self._parse_table_ref(tref.strip())
            alias_map[ja] = jt
            pairs = self._parse_on(cond)
            join_specs.append((ja, jt, pairs))
        return base_table, alias_map, join_specs

    def _parse_table_ref(self, ref: str):
        idents = _IDENT_RE.findall(ref)
        if not idents:
            raise ValueError(f"unquoted table reference: {ref!r}")
        table = idents[-1]              # last quoted ident is the table name
        am = re.search(r"\bAS\s+([A-Za-z_][A-Za-z0-9_]*)", ref, re.IGNORECASE)
        alias = am.group(1) if am else table
        if table not in self._tables:
            raise ValueError(f"unknown table '{table}'")
        return table, alias

    @staticmethod
    def _parse_on(cond: str):
        pairs = []
        for eq in re.split(r"\bAND\b", cond, flags=re.IGNORECASE):
            sides = eq.split("=")
            if len(sides) != 2:
                raise ValueError(f"unsupported join condition: {cond!r}")
            left = _IDENT_RE.findall(sides[0])
            right = _IDENT_RE.findall(sides[1])
            la = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\.", sides[0])
            ra = re.search(r"([A-Za-z_][A-Za-z0-9_]*)\.", sides[1])
            pairs.append((la.group(1), left[-1], ra.group(1), right[-1]))
        return pairs

    def _materialize(self, base_table, alias_map, join_specs):
        base_alias = next(a for a, t in alias_map.items() if t == base_table
                          and a not in [j[0] for j in join_specs])
        rows = [{base_alias: dict(r)} for r in self._tables[base_table].rows]
        for (ja, jt, pairs) in join_specs:
            right_rows = self._tables[jt].rows
            joined = []
            for lr in rows:
                match = None
                for rr in right_rows:
                    ok = True
                    for (la, lc, ra, rc) in pairs:
                        # Resolve each side by alias: the joined table's alias
                        # (ja) reads from the candidate right row; any other
                        # alias reads from the already-materialized left row.
                        lval = rr[lc] if la == ja else lr.get(la, {}).get(lc)
                        rval = rr[rc] if ra == ja else lr.get(ra, {}).get(rc)
                        if lval != rval:
                            ok = False
                            break
                    if ok:
                        match = rr
                        break
                merged = dict(lr)
                merged[ja] = dict(match) if match else {}
                joined.append(merged)
            rows = joined
        return rows

    def _apply_where(self, rows, where, parameters, alias_map):
        if not where:
            return rows
        out = []
        conds = re.split(r"\bAND\b", where, flags=re.IGNORECASE)
        for row in rows:
            if all(self._eval_cond(row, c.strip(), parameters) for c in conds):
                out.append(row)
        return out

    @staticmethod
    def _eval_cond(row, cond, parameters):
        m = re.match(
            r"([A-Za-z_][A-Za-z0-9_]*)\.\"([^\"]+)\"\s+(=|ILIKE)\s+:([A-Za-z_][A-Za-z0-9_]*)",
            cond,
        )
        if not m:
            raise ValueError(f"unsupported WHERE condition: {cond!r}")
        alias, col, op, pname = m.groups()
        cell = row.get(alias, {}).get(col)
        val = parameters[pname]
        if op == "=":
            return cell == val
        pattern = str(val).replace("%", "").lower()
        return cell is not None and pattern in str(cell).lower()

    @staticmethod
    def _parse_select(select: str):
        items = []
        for raw in InMemoryDataAdapter._split_top(select):
            raw = raw.strip()
            # alias is a quoted identifier after AS
            alias_m = re.search(r'\bAS\s+"([^"]+)"\s*$', raw, re.IGNORECASE)
            alias = alias_m.group(1) if alias_m else None
            expr = raw[: alias_m.start()].strip() if alias_m else raw
            agg = None
            agg_m = re.match(r"(COUNT|SUM|AVG)\s*\((.*)\)$", expr, re.IGNORECASE)
            if agg_m:
                agg = agg_m.group(1).upper()
                inner = agg_m.group(2).strip()
                if inner == "*":
                    items.append({"agg": agg, "alias": alias, "ta": None, "col": None})
                    continue
                expr = inner
            tref = re.match(r'([A-Za-z_][A-Za-z0-9_]*)\.\"([^\"]+)\"', expr)
            items.append({
                "agg": agg, "alias": alias,
                "ta": tref.group(1) if tref else None,
                "col": tref.group(2) if tref else None,
            })
        return items

    @staticmethod
    def _split_top(s: str):
        out, depth, cur = [], 0, ""
        for ch in s:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                out.append(cur)
                cur = ""
            else:
                cur += ch
        if cur.strip():
            out.append(cur)
        return out

    def _project(self, rows, select_items):
        cols = [it["alias"] or it["col"] for it in select_items]
        out = []
        for row in rows:
            rec = {}
            for it in select_items:
                key = it["alias"] or it["col"]
                rec[key] = row.get(it["ta"], {}).get(it["col"])
            out.append(rec)
        return cols, out

    def _aggregate(self, rows, select_items, group, alias_map):
        group_keys = []
        if group:
            for g in group.split(","):
                gm = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\.\"([^\"]+)\"", g)
                group_keys.append((gm.group(1), gm.group(2)))

        buckets: dict[tuple, list] = {}
        for row in rows:
            key = tuple(row.get(ta, {}).get(col) for (ta, col) in group_keys)
            buckets.setdefault(key, []).append(row)
        if not group_keys:
            buckets = {(): rows}

        cols = [it["alias"] or (it["agg"] or it["col"]) for it in select_items]
        out = []
        for key, bucket in buckets.items():
            rec = {}
            gi = 0
            for it in select_items:
                name = it["alias"] or (it["agg"] or it["col"])
                if it["agg"] == "COUNT":
                    rec[name] = len(bucket)
                elif it["agg"] in ("SUM", "AVG"):
                    vals = [b.get(it["ta"], {}).get(it["col"]) for b in bucket]
                    vals = [v for v in vals if isinstance(v, (int, float))]
                    if it["agg"] == "SUM":
                        rec[name] = sum(vals)
                    else:
                        rec[name] = (sum(vals) / len(vals)) if vals else None
                else:
                    rec[name] = key[gi] if gi < len(key) else None
                    gi += 1
            out.append(rec)
        return cols, out
