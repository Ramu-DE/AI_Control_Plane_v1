"""Discovery contracts — typed, data-agnostic metadata and profiling.

The PRECISION-FIRST path begins here. Discovery describes *what exists* in a
structured data source without assuming anything about a particular dataset
(no ContractIQ columns, no universal join key). Everything is a typed record:

    TableMetadata      — a table/view/collection and its columns
    ColumnMetadata     — one column: name, logical type, nullability, flags
    KeyMetadata        — a primary/unique/foreign key (composite-aware)
    JoinMetadata       — a declared or discovered join between two tables
    ColumnProfile      — bounded, MASKED sample profile of a column
    TableProfile       — row-count estimate + per-column profiles
    DiscoveryResult    — the full data-agnostic picture a DataAdapter returns

Profiling is deliberately *bounded* (sample caps) and *masked* (no raw PII
values leak): the sample values carried in a ColumnProfile are redacted/hashed
representatives, never verbatim cell contents. This keeps discovery safe to log
and to show a human approver.

stdlib only — imports cleanly in any runtime.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Optional


# --------------------------------------------------------------------------- #
# Logical type system (backend-neutral)
# --------------------------------------------------------------------------- #
class LogicalType(str, Enum):
    """Backend-neutral logical types. Adapters map native types onto these."""

    STRING = "string"
    INTEGER = "integer"
    DECIMAL = "decimal"
    BOOLEAN = "boolean"
    DATE = "date"
    TIMESTAMP = "timestamp"
    UUID = "uuid"
    UNKNOWN = "unknown"

    @classmethod
    def coerce(cls, raw: Optional[str]) -> "LogicalType":
        if not raw:
            return cls.UNKNOWN
        r = raw.strip().lower()
        if any(x in r for x in ("char", "text", "string", "varchar", "clob")):
            return cls.STRING
        if any(x in r for x in ("decimal", "numeric", "double", "float", "real", "money")):
            return cls.DECIMAL
        if any(x in r for x in ("bigint", "smallint", "tinyint", "int", "serial")):
            return cls.INTEGER
        if "bool" in r:
            return cls.BOOLEAN
        if "timestamp" in r or "datetime" in r:
            return cls.TIMESTAMP
        if "date" in r:
            return cls.DATE
        if "uuid" in r or "guid" in r:
            return cls.UUID
        return cls.UNKNOWN


class KeyType(str, Enum):
    PRIMARY = "primary"
    UNIQUE = "unique"
    FOREIGN = "foreign"


# --------------------------------------------------------------------------- #
# Metadata records
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ColumnMetadata:
    name: str
    logical_type: LogicalType = LogicalType.UNKNOWN
    native_type: Optional[str] = None
    nullable: bool = True
    # Discovery FLAGS are hints only; they never authorize a mapping on their own.
    is_identifier_like: bool = False      # looks like an id/key by shape
    is_measure_like: bool = False         # numeric & aggregatable by shape
    comment: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["logical_type"] = self.logical_type.value
        return d


@dataclass(frozen=True)
class KeyMetadata:
    """A key on a table. `columns` is ordered and may be composite."""

    key_type: KeyType
    columns: tuple[str, ...]
    name: Optional[str] = None
    # For foreign keys only:
    references_table: Optional[str] = None
    references_columns: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["key_type"] = self.key_type.value
        d["columns"] = list(self.columns)
        d["references_columns"] = list(self.references_columns)
        return d


@dataclass(frozen=True)
class JoinMetadata:
    """A join between two tables. Column lists are positionally paired and may
    be composite. Declared joins come from foreign keys; discovered joins come
    from ontology relationships or an approver — never from a global assumption.
    """

    left_table: str
    left_columns: tuple[str, ...]
    right_table: str
    right_columns: tuple[str, ...]
    cardinality: str = "many-to-one"      # one-to-one|one-to-many|many-to-one|many-to-many
    origin: str = "declared"              # declared|discovered|proposed|value
    name: Optional[str] = None
    # Set when the join's right side is a VALUE ENTITY (an ontology class
    # minted from a column's distinct values) rather than a keyed table:
    # `left_columns` is the referencing column and the object IRI is minted
    # from its value. None for every ordinary table-to-table join.
    value_class: Optional[str] = None

    def __post_init__(self) -> None:
        if len(self.left_columns) != len(self.right_columns):
            raise ValueError(
                f"join {self.name or ''}: left/right column counts differ "
                f"({len(self.left_columns)} vs {len(self.right_columns)})"
            )
        if not self.left_columns:
            raise ValueError("join must have at least one column pair")

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["left_columns"] = list(self.left_columns)
        d["right_columns"] = list(self.right_columns)
        return d


@dataclass(frozen=True)
class TableMetadata:
    name: str
    columns: tuple[ColumnMetadata, ...]
    keys: tuple[KeyMetadata, ...] = ()
    kind: str = "table"                   # table|view|collection
    comment: Optional[str] = None

    def column(self, name: str) -> Optional[ColumnMetadata]:
        for c in self.columns:
            if c.name == name:
                return c
        return None

    def primary_key(self) -> Optional[KeyMetadata]:
        for k in self.keys:
            if k.key_type == KeyType.PRIMARY:
                return k
        return None

    def subject_key(self) -> Optional[KeyMetadata]:
        """The declared key usable for minting subject IRIs.

        A PRIMARY key if there is one, otherwise a declared UNIQUE constraint:
        both identify a row, so refusing the second would block a table for no
        reason. `primary_key()` stays literal — it answers only about PRIMARY —
        because other callers ask that narrower question.
        """
        pk = self.primary_key()
        if pk:
            return pk
        for k in self.keys:
            if k.key_type == KeyType.UNIQUE:
                return k
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "kind": self.kind,
            "comment": self.comment,
            "columns": [c.to_dict() for c in self.columns],
            "keys": [k.to_dict() for k in self.keys],
        }


# --------------------------------------------------------------------------- #
# Profiling records (bounded + masked)
# --------------------------------------------------------------------------- #
# Hard cap: a profile NEVER carries more than this many representative samples.
MAX_SAMPLE_VALUES = 5


def mask_value(value: Any, logical_type: LogicalType = LogicalType.UNKNOWN) -> str:
    """Return a masked, non-reversible representative of a cell value.

    - None -> "<null>"
    - numbers -> order-of-magnitude bucket (never the exact value)
    - everything else -> "<type:len:hash8>" (short salted-free sha256 prefix)

    This guarantees no raw PII/business value is ever carried in a profile while
    still letting a human/algorithm reason about shape and cardinality.
    """
    if value is None:
        return "<null>"
    if isinstance(value, bool):
        return f"<bool:{str(value).lower()}>"
    if isinstance(value, (int, float)):
        try:
            magnitude = len(str(abs(int(value))))
        except (ValueError, OverflowError):
            magnitude = 0
        return f"<num:{magnitude}d>"
    s = str(value)
    digest = hashlib.sha256(s.encode("utf-8")).hexdigest()[:8]
    return f"<str:{len(s)}:{digest}>"


@dataclass(frozen=True)
class ColumnProfile:
    column: str
    logical_type: LogicalType
    non_null_count: int
    null_count: int
    distinct_estimate: int
    # Bounded list of MASKED representative values (len <= MAX_SAMPLE_VALUES).
    masked_samples: tuple[str, ...] = ()
    min_length: Optional[int] = None
    max_length: Optional[int] = None

    def __post_init__(self) -> None:
        if len(self.masked_samples) > MAX_SAMPLE_VALUES:
            raise ValueError(
                f"column '{self.column}': masked_samples exceeds cap "
                f"{MAX_SAMPLE_VALUES} (got {len(self.masked_samples)})"
            )
        for s in self.masked_samples:
            if not (s.startswith("<") and s.endswith(">")):
                raise ValueError(
                    f"column '{self.column}': sample '{s}' is not masked — "
                    "profiles must never carry raw values"
                )

    @property
    def total_count(self) -> int:
        return self.non_null_count + self.null_count

    @property
    def null_fraction(self) -> float:
        t = self.total_count
        return (self.null_count / t) if t else 0.0

    @property
    def is_unique_candidate(self) -> bool:
        """Shape-only hint: looks unique (distinct ~= non-null, no nulls)."""
        return (
            self.null_count == 0
            and self.non_null_count > 0
            and self.distinct_estimate >= self.non_null_count
        )

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["logical_type"] = self.logical_type.value
        d["masked_samples"] = list(self.masked_samples)
        d["null_fraction"] = round(self.null_fraction, 4)
        d["is_unique_candidate"] = self.is_unique_candidate
        return d


@dataclass(frozen=True)
class TableProfile:
    table: str
    row_estimate: int
    column_profiles: tuple[ColumnProfile, ...] = ()
    sampled: bool = True

    def profile(self, column: str) -> Optional[ColumnProfile]:
        for p in self.column_profiles:
            if p.column == column:
                return p
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "table": self.table,
            "row_estimate": self.row_estimate,
            "sampled": self.sampled,
            "column_profiles": [p.to_dict() for p in self.column_profiles],
        }


@dataclass(frozen=True)
class DiscoveryResult:
    """The complete, data-agnostic picture a structured DataAdapter returns."""

    source_id: str
    tables: tuple[TableMetadata, ...] = ()
    joins: tuple[JoinMetadata, ...] = ()
    profiles: tuple[TableProfile, ...] = ()

    def table(self, name: str) -> Optional[TableMetadata]:
        for t in self.tables:
            if t.name == name:
                return t
        return None

    def profile(self, name: str) -> Optional[TableProfile]:
        for p in self.profiles:
            if p.table == name:
                return p
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "tables": [t.to_dict() for t in self.tables],
            "joins": [j.to_dict() for j in self.joins],
            "profiles": [p.to_dict() for p in self.profiles],
        }


# --------------------------------------------------------------------------- #
# Shape heuristics (hints only; never authorize a mapping)
# --------------------------------------------------------------------------- #
_ID_SHAPE = re.compile(r"(^|_)(id|key|code|uuid|guid|number|no|nbr)$", re.IGNORECASE)


def looks_like_identifier(column_name: str, logical_type: LogicalType) -> bool:
    if logical_type in (LogicalType.UUID,):
        return True
    return bool(_ID_SHAPE.search(column_name))


def looks_like_measure(logical_type: LogicalType) -> bool:
    return logical_type in (LogicalType.DECIMAL, LogicalType.INTEGER)


def profile_samples(values: list[Any], logical_type: LogicalType) -> tuple[str, ...]:
    """Build a bounded, masked sample tuple from raw values.

    Raw values are consumed here and NEVER stored — only their masked
    representatives (capped at MAX_SAMPLE_VALUES) are returned.
    """
    out: list[str] = []
    seen: set[str] = set()
    for v in values:
        m = mask_value(v, logical_type)
        if m not in seen:
            seen.add(m)
            out.append(m)
        if len(out) >= MAX_SAMPLE_VALUES:
            break
    return tuple(out)
