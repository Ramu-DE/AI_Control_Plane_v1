"""Unity Catalog DataAdapter over the Databricks REST APIs — no Spark required.

The precision path had only one concrete `DataAdapter`: the in-memory test
fixture. That meant the dataset-agnostic half of the pipeline had never actually
met a dataset. This adapter closes that: `discover()` reads real Unity Catalog
metadata and `execute()` runs compiled SQL on a SQL warehouse, both over HTTPS,
so the whole ontology-first chain runs outside a Databricks runtime.

KEYS COME FROM DECLARED CONSTRAINTS, NOT FROM COLUMN NAMES. This is the point.
Unity Catalog exposes informational PRIMARY KEY / FOREIGN KEY constraints
through `information_schema`, and this adapter reads them:

    table_constraints  + key_column_usage    -> PRIMARY / UNIQUE, in key order
    referential_constraints                  -> FK -> the unique constraint it
                                                references, resolved to that
                                                constraint's table + columns

A table with no declared primary key therefore yields NO key, the class
proposal is blocked, and nothing is materialised for it. That is the intended
behaviour: inferring identity from a `*_id`-shaped name is exactly the guess
this path exists to avoid. The remedy is to declare the constraint, not to
loosen the rule.

PROFILING IS OPT-IN AND MASKED. Profiles read real values, so they are off by
default; when enabled, values pass through `mask_value` and the sample cap in
`discovery.py`, which structurally cannot carry a raw value.

stdlib only (urllib), so this imports anywhere.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Optional

from .data_adapter import DataAdapter, QueryResult
from .discovery import (
    ColumnMetadata,
    ColumnProfile,
    DiscoveryResult,
    JoinMetadata,
    KeyMetadata,
    KeyType,
    LogicalType,
    MAX_SAMPLE_VALUES,
    TableMetadata,
    TableProfile,
    looks_like_identifier,
    looks_like_measure,
    mask_value,
)
from .materialize import DATABRICKS_DIALECT

#: Hard ceiling on rows returned by one statement, so a mapping mistake cannot
#: pull a whole fact table into memory.
MAX_ROWS = 10_000
#: Ceiling on tables considered in one discovery pass.
MAX_TABLES = 500


class UnityCatalogError(RuntimeError):
    """Raised when Databricks rejects a request or a statement fails."""


class UnityCatalogDataAdapter(DataAdapter):
    """Live Unity Catalog adapter: `information_schema` + the Statements API."""

    def __init__(
        self,
        *,
        catalog: str,
        schema: str,
        source_id: Optional[str] = None,
        host: Optional[str] = None,
        token: Optional[str] = None,
        warehouse_id: Optional[str] = None,
        table_filter: Optional[str] = None,
        include_views: bool = False,
        profile: bool = False,
        timeout: int = 120,
    ) -> None:
        self.catalog = catalog
        self.schema = schema
        self.source_id = source_id or f"{catalog}.{schema}"
        # Credentials are read from the environment by NAME; nothing is stored
        # on a descriptor or persisted anywhere by this class.
        self.host = (host or os.environ.get("DATABRICKS_HOST", "")).rstrip("/")
        self._token = token or os.environ.get("DATABRICKS_TOKEN", "")
        self.warehouse_id = warehouse_id or os.environ.get("DATABRICKS_WAREHOUSE_ID", "")
        if not (self.host and self._token and self.warehouse_id):
            raise UnityCatalogError(
                "UnityCatalogDataAdapter needs DATABRICKS_HOST, DATABRICKS_TOKEN "
                "and DATABRICKS_WAREHOUSE_ID (or the matching constructor args)"
            )
        if not self.host.startswith("https://"):
            raise UnityCatalogError(f"DATABRICKS_HOST must be https, got '{self.host}'")
        self.table_filter = table_filter
        self.include_views = include_views
        self.profile = profile
        self.timeout = timeout

    # ----------------------------------------------------------------- #
    # REST plumbing
    # ----------------------------------------------------------------- #
    def _request(self, path: str, body: Optional[dict] = None, method: str = "POST") -> dict:
        req = urllib.request.Request(
            f"{self.host}{path}",
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:400]
            raise UnityCatalogError(f"Databricks {e.code} on {path}: {detail}") from e
        except urllib.error.URLError as e:
            raise UnityCatalogError(f"cannot reach Databricks at {self.host}: {e.reason}") from e

    def _sql(
        self, statement: str, parameters: Optional[dict[str, Any]] = None, *, limit: int = MAX_ROWS
    ) -> QueryResult:
        """Run one statement and return columns + dict rows.

        Values go through the API's named-parameter list, never string
        interpolation, which is what makes the DataAdapter contract honest.
        """
        body: dict[str, Any] = {
            "statement": statement,
            "warehouse_id": self.warehouse_id,
            "wait_timeout": "30s",
            "on_wait_timeout": "CONTINUE",
            "format": "JSON_ARRAY",
            "disposition": "INLINE",
            "row_limit": min(int(limit), MAX_ROWS),
        }
        if parameters:
            body["parameters"] = [
                {"name": k, "value": None if v is None else str(v)}
                for k, v in parameters.items()
            ]
        out = self._request("/api/2.0/sql/statements", body)
        statement_id = out.get("statement_id")
        deadline = time.time() + self.timeout
        while out.get("status", {}).get("state") in ("PENDING", "RUNNING"):
            if time.time() > deadline:
                raise UnityCatalogError(
                    f"statement {statement_id} still {out['status']['state']} after "
                    f"{self.timeout}s"
                )
            time.sleep(2)
            out = self._request(f"/api/2.0/sql/statements/{statement_id}", method="GET")

        state = out.get("status", {}).get("state")
        if state != "SUCCEEDED":
            err = out.get("status", {}).get("error", {})
            raise UnityCatalogError(
                f"statement failed ({state}): {err.get('error_code')} "
                f"{err.get('message', '')[:300]}"
            )

        columns = [c["name"] for c in out.get("manifest", {}).get("schema", {}).get("columns", [])]
        data = out.get("result", {}).get("data_array") or []
        rows = [dict(zip(columns, raw)) for raw in data]
        return QueryResult(columns=columns, rows=rows)

    # ----------------------------------------------------------------- #
    # DataAdapter: execute
    # ----------------------------------------------------------------- #
    def execute(self, sql: str, parameters: dict[str, Any]) -> QueryResult:
        return self._sql(sql, parameters or {})

    # ----------------------------------------------------------------- #
    # DataAdapter: discover
    # ----------------------------------------------------------------- #
    def discover(self) -> DiscoveryResult:
        tables = self._read_tables()
        columns = self._read_columns()
        keys, unique_constraints = self._read_keys()
        fks = self._read_foreign_keys(unique_constraints)

        metas: list[TableMetadata] = []
        for name in sorted(tables):
            cols = columns.get(name, [])
            if not cols:
                continue  # a table we can see but cannot describe is not usable
            table_keys = list(keys.get(name, []))
            table_keys += [key for (fk_table, key) in fks if fk_table == name]
            metas.append(TableMetadata(
                name=name,
                columns=tuple(cols),
                keys=tuple(table_keys),
                kind=tables[name]["kind"],
                comment=tables[name]["comment"],
            ))

        joins = tuple(
            JoinMetadata(
                left_table=table,
                left_columns=key.columns,
                right_table=key.references_table or "",
                right_columns=key.references_columns or key.columns,
                cardinality="many-to-one",
                origin="declared",
                name=key.name,
            )
            for table, key in fks
            if key.references_table
        )

        profiles = tuple(self._read_profiles(metas)) if self.profile else ()
        return DiscoveryResult(
            source_id=self.source_id,
            tables=tuple(metas),
            joins=joins,
            profiles=profiles,
        )

    # --- discovery helpers --- #
    def _read_tables(self) -> dict[str, dict[str, Any]]:
        kinds = "('MANAGED','EXTERNAL','VIEW')" if self.include_views else "('MANAGED','EXTERNAL')"
        res = self._sql(
            f"""SELECT table_name, table_type, comment
                FROM {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.tables
                WHERE table_schema = :schema AND table_type IN {kinds}
                ORDER BY table_name""",
            {"schema": self.schema},
            limit=MAX_TABLES,
        )
        out: dict[str, dict[str, Any]] = {}
        for r in res.rows:
            name = r["table_name"]
            if self.table_filter and not name.startswith(self.table_filter):
                continue
            out[name] = {
                "kind": "view" if r.get("table_type") == "VIEW" else "table",
                "comment": r.get("comment") or None,
            }
        return out

    def _read_columns(self) -> dict[str, list[ColumnMetadata]]:
        res = self._sql(
            f"""SELECT table_name, column_name, ordinal_position, full_data_type,
                       is_nullable, comment
                FROM {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.columns
                WHERE table_schema = :schema
                ORDER BY table_name, ordinal_position""",
            {"schema": self.schema},
        )
        out: dict[str, list[ColumnMetadata]] = {}
        for r in res.rows:
            native = r.get("full_data_type") or ""
            lt = LogicalType.coerce(native)
            out.setdefault(r["table_name"], []).append(ColumnMetadata(
                name=r["column_name"],
                logical_type=lt,
                native_type=native,
                nullable=(r.get("is_nullable") or "YES").upper() == "YES",
                is_identifier_like=looks_like_identifier(r["column_name"], lt),
                is_measure_like=looks_like_measure(lt),
                comment=r.get("comment") or None,
            ))
        return out

    def _read_keys(self) -> tuple[dict[str, list[KeyMetadata]], dict[str, tuple[str, tuple[str, ...]]]]:
        """Read PRIMARY/UNIQUE constraints in declared key order.

        Also returns a map of constraint name -> (table, columns), which is how
        a foreign key's target is resolved: `referential_constraints` names the
        unique constraint it points at, not the table.
        """
        res = self._sql(
            f"""SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
                       kcu.column_name, kcu.ordinal_position
                FROM {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.table_constraints tc
                JOIN {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.constraint_schema = kcu.constraint_schema
                WHERE tc.table_schema = :schema
                ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position""",
            {"schema": self.schema},
        )
        grouped: dict[tuple[str, str, str], list[str]] = {}
        for r in res.rows:
            key = (r["table_name"], r["constraint_name"], r["constraint_type"])
            grouped.setdefault(key, []).append(r["column_name"])

        keys: dict[str, list[KeyMetadata]] = {}
        constraint_targets: dict[str, tuple[str, tuple[str, ...]]] = {}
        for (table, cname, ctype), cols in grouped.items():
            if ctype == "PRIMARY KEY":
                kt = KeyType.PRIMARY
            elif ctype == "UNIQUE":
                kt = KeyType.UNIQUE
            else:
                continue  # foreign keys are handled separately
            keys.setdefault(table, []).append(
                KeyMetadata(kt, tuple(cols), name=cname))
            constraint_targets[cname] = (table, tuple(cols))
        return keys, constraint_targets

    def _read_foreign_keys(
        self, unique_constraints: dict[str, tuple[str, tuple[str, ...]]]
    ) -> list[tuple[str, KeyMetadata]]:
        """Resolve each FK to the table and columns it references."""
        res = self._sql(
            f"""SELECT tc.table_name, tc.constraint_name,
                       kcu.column_name, kcu.ordinal_position,
                       rc.unique_constraint_name
                FROM {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.table_constraints tc
                JOIN {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.constraint_schema = kcu.constraint_schema
                JOIN {DATABRICKS_DIALECT.ident(self.catalog)}.information_schema.referential_constraints rc
                  ON tc.constraint_name = rc.constraint_name
                 AND tc.constraint_schema = rc.constraint_schema
                WHERE tc.table_schema = :schema AND tc.constraint_type = 'FOREIGN KEY'
                ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position""",
            {"schema": self.schema},
        )
        grouped: dict[tuple[str, str, str], list[str]] = {}
        for r in res.rows:
            key = (r["table_name"], r["constraint_name"], r.get("unique_constraint_name") or "")
            grouped.setdefault(key, []).append(r["column_name"])

        out: list[tuple[str, KeyMetadata]] = []
        for (table, cname, target_constraint), cols in grouped.items():
            target = unique_constraints.get(target_constraint)
            if not target:
                # The FK points at a constraint outside this schema. Emitting a
                # half-resolved key would let a join be built on a guess.
                continue
            ref_table, ref_cols = target
            if len(ref_cols) != len(cols):
                continue  # mismatched arity cannot be paired positionally
            out.append((table, KeyMetadata(
                KeyType.FOREIGN, tuple(cols), name=cname,
                references_table=ref_table, references_columns=tuple(ref_cols),
            )))
        return out

    def _read_profiles(self, metas: list[TableMetadata]) -> list[TableProfile]:
        """Bounded, masked profiles. One statement per table."""
        profiles: list[TableProfile] = []
        q = DATABRICKS_DIALECT.ident
        for meta in metas:
            cols = [c for c in meta.columns]
            if not cols:
                continue
            select = ", ".join(f"t0.{q(c.name)} AS {q('c' + str(i))}"
                               for i, c in enumerate(cols))
            sample = self._sql(
                f"SELECT {select} FROM {q(self.catalog)}.{q(self.schema)}.{q(meta.name)} AS t0 "
                f"LIMIT {MAX_SAMPLE_VALUES * 4}"
            )
            count = self._sql(
                f"SELECT COUNT(*) AS n FROM {q(self.catalog)}.{q(self.schema)}.{q(meta.name)}"
            )
            total = int(count.rows[0]["n"]) if count.rows else 0

            col_profiles = []
            for i, c in enumerate(cols):
                values = [r.get(f"c{i}") for r in sample.rows]
                non_null = [v for v in values if v is not None]
                col_profiles.append(ColumnProfile(
                    column=c.name,
                    logical_type=c.logical_type,
                    non_null_count=len(non_null),
                    null_count=len(values) - len(non_null),
                    distinct_estimate=len({str(v) for v in non_null}),
                    masked_samples=tuple(
                        mask_value(v, c.logical_type) for v in non_null[:MAX_SAMPLE_VALUES]
                    ),
                ))
            profiles.append(TableProfile(
                table=meta.name, row_estimate=total,
                column_profiles=tuple(col_profiles), sampled=True))
        return profiles

    # ----------------------------------------------------------------- #
    # Native value-overlap profiling
    # ----------------------------------------------------------------- #
    def join_overlap(
        self,
        left_table: str,
        left_columns: tuple[str, ...],
        right_table: str,
        right_columns: tuple[str, ...],
    ):
        """Measure referential containment in aggregate SQL — no rows returned.

        The generic fallback in `overlap.py` pulls keys and counts in Python,
        which stops being exhaustive on a large table and so can never justify
        auto-approval. Pushing the counting into the warehouse keeps the answer
        exact at any size, which is the whole point: a sampled containment
        figure is not a measurement of the relation.
        """
        from .overlap import JoinOverlap

        q = DATABRICKS_DIALECT.ident
        left_fq = f"{q(self.catalog)}.{q(self.schema)}.{q(left_table)}"
        right_fq = f"{q(self.catalog)}.{q(self.schema)}.{q(right_table)}"
        left_sel = ", ".join(q(c) for c in left_columns)
        right_sel = ", ".join(q(c) for c in right_columns)
        not_null_left = " AND ".join(f"{q(c)} IS NOT NULL" for c in left_columns)
        not_null_right = " AND ".join(f"{q(c)} IS NOT NULL" for c in right_columns)
        on = " AND ".join(
            f"l.{q(l)} = r.{q(r)}" for l, r in zip(left_columns, right_columns)
        )
        # First NULL-checked column stands in for "the right row matched".
        probe_col = q(right_columns[0])

        res = self._sql(
            f"""WITH l AS (
                    SELECT DISTINCT {left_sel} FROM {left_fq} WHERE {not_null_left}
                ), r AS (
                    SELECT DISTINCT {right_sel} FROM {right_fq} WHERE {not_null_right}
                )
                SELECT COUNT(*) AS left_distinct,
                       SUM(CASE WHEN r.{probe_col} IS NOT NULL THEN 1 ELSE 0 END) AS matched
                FROM l LEFT JOIN r ON {on}""",
            limit=1,
        )
        row = res.rows[0] if res.rows else {}
        left_distinct = int(row.get("left_distinct") or 0)
        matched = int(row.get("matched") or 0)

        res2 = self._sql(
            f"""SELECT COUNT(*) AS rows_present,
                       COUNT(DISTINCT {right_sel}) AS distinct_keys
                FROM {right_fq} WHERE {not_null_right}""",
            limit=1,
        )
        row2 = res2.rows[0] if res2.rows else {}
        return JoinOverlap(
            left_table=left_table, left_columns=tuple(left_columns),
            right_table=right_table, right_columns=tuple(right_columns),
            left_distinct=left_distinct, matched=matched,
            right_distinct=int(row2.get("distinct_keys") or 0),
            right_rows=int(row2.get("rows_present") or 0),
            exhaustive=True, method="aggregate-sql",
        )

    # ----------------------------------------------------------------- #
    # Convenience for the materializer
    # ----------------------------------------------------------------- #
    def table_qualifier(self):
        """Fully-qualify a bare table name as `catalog`.`schema`.`table`."""
        q = DATABRICKS_DIALECT.ident
        prefix = f"{q(self.catalog)}.{q(self.schema)}"
        return lambda table: f"{prefix}.{q(table)}"
