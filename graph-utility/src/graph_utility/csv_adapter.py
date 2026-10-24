"""A directory of CSV files as a data source.

Most BU data reaches a platform as an export long before anyone wires a
connector: a CSV per table out of an ERP, a LIMS, a spreadsheet. This adapter
makes such a directory a first-class source, so the ontology-first build does
not depend on Unity Catalog being the system of record.

What it does NOT do is pretend the files carry metadata they do not:
  - types are INFERRED from the values (every non-empty value must parse);
  - NO keys and NO joins are declared — a CSV has none. Identity and
    relationships must therefore be MEASURED (`--profile-keys`,
    `--profile-joins`) or declared by the ontology (`owl:hasKey`), exactly as
    for a constraint-free warehouse schema;
  - an empty field is NULL, never the empty string, so a missing value emits
    no triple.

stdlib only. Execution reuses the in-memory engine, so queries run with the
ANSI dialect.
"""
from __future__ import annotations

import csv
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Optional

from .data_adapter import InMemoryDataAdapter, InMemoryTable
from .discovery import ColumnMetadata, LogicalType, TableMetadata

_INT = re.compile(r"^[+-]?\d+$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$")
_TABLE_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _is_decimal(v: str) -> bool:
    try:
        Decimal(v)
        return "." in v or "e" in v.lower()
    except InvalidOperation:
        return False


def infer_type(values: list[str]) -> LogicalType:
    """The narrowest type EVERY non-empty value parses as; STRING otherwise.

    Integers are checked before decimals and dates before timestamps, so
    `120` is an INTEGER and `2026-11-02` a DATE. A column of all-empty values
    is STRING (nothing to infer from)."""
    present = [v for v in values if v != ""]
    if not present:
        return LogicalType.STRING
    if all(_INT.match(v) for v in present):
        return LogicalType.INTEGER
    if all(_INT.match(v) or _is_decimal(v) for v in present):
        return LogicalType.DECIMAL
    if all(v.lower() in ("true", "false") for v in present):
        return LogicalType.BOOLEAN
    if all(_DATE.match(v) for v in present):
        return LogicalType.DATE
    if all(_TIMESTAMP.match(v) for v in present):
        return LogicalType.TIMESTAMP
    return LogicalType.STRING


def _convert(value: str, lt: LogicalType) -> Any:
    if value == "":
        return None
    if lt == LogicalType.INTEGER:
        return int(value)
    if lt == LogicalType.DECIMAL:
        return Decimal(value)
    if lt == LogicalType.BOOLEAN:
        return value.lower() == "true"
    if lt == LogicalType.DATE:
        return date.fromisoformat(value)
    if lt == LogicalType.TIMESTAMP:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


class CsvDirectoryAdapter(InMemoryDataAdapter):
    """One table per `<name>.csv` (header row required)."""

    @classmethod
    def from_directory(cls, path: str, source_id: Optional[str] = None,
                       table_filter: Optional[str] = None) -> "CsvDirectoryAdapter":
        root = Path(path).expanduser()
        if not root.is_dir():
            raise FileNotFoundError(f"CSV source directory not found: {root}")
        tables: list[InMemoryTable] = []
        for file in sorted(root.glob("*.csv")):
            name = file.stem
            if table_filter and not name.startswith(table_filter):
                continue
            if not _TABLE_NAME.match(name):
                raise ValueError(f"'{file.name}': table names must be plain identifiers")
            with file.open(newline="", encoding="utf-8-sig") as fh:
                reader = csv.DictReader(fh)
                header = list(reader.fieldnames or [])
                raw = [{k: (row.get(k) or "") for k in header} for row in reader]
            if not header:
                raise ValueError(f"'{file.name}' has no header row")
            columns = []
            types: dict[str, LogicalType] = {}
            for col in header:
                values = [r[col] for r in raw]
                types[col] = infer_type(values)
                columns.append(ColumnMetadata(col, types[col], native_type="csv",
                                              nullable=any(v == "" for v in values)))
            rows = [{c: _convert(r[c], types[c]) for c in header} for r in raw]
            tables.append(InMemoryTable(
                TableMetadata(name=name, columns=tuple(columns), keys=()), rows))
        if not tables:
            raise ValueError(f"no .csv files in {root}")
        return cls(source_id=source_id or f"csv:{root.name}", tables=tables, joins=[])

    def table_qualifier(self):
        return None
