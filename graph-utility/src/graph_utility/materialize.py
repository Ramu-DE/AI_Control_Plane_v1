"""Materialize a published mapping set into an RDF knowledge graph (N-Quads).

THIS IS THE ENGINE THAT WAS MISSING. Until now the precision path ended at
`to_r2rml`, which emits a mapping artifact that nothing consumed — so no
ontology, however well mapped, ever became a graph. This module closes that
gap: published mappings in, triples out.

    published mappings + a DataAdapter  ->  N-Quads  ->  (S3)  ->  Neptune

N-Quads rather than a direct SPARQL write, for three reasons: it is what
Neptune's bulk loader ingests fastest; the artifact is verifiable on its own,
with no cluster required; and quads carry the named graph, which is how a build
gets an identity.

NAMED GRAPH PER BUILD. Every quad lands in `urn:kg:build:<build_id>`. That makes
teardown `DROP GRAPH <urn:kg:build:…>` — exact and atomic — instead of hunting
nodes by a property stamp, and it lets two builds sit side by side for
comparison rather than silently merging into one another.

PRECISION RULES. The whole point of the approval gate is lost if the writer
invents what the mappings would not justify:

  - NO FABRICATED SUBJECTS. A row whose subject key is NULL is skipped and
    counted in `rows_skipped_null_key`. There is no surrogate key, ever.
  - A table with direct mappings but no published, keyed CLASS cannot emit a
    precise subject, so in strict mode it raises (matching `to_r2rml`); in
    lenient mode it is omitted and recorded in `skipped`.
  - A NULL column value emits NO triple. In RDF the absence of a statement IS
    the representation of "unknown"; writing an empty string would assert
    something false. Omissions are counted in `null_values_skipped`.
  - Literals are typed from the DISCOVERED logical type, not guessed from the
    value, and canonicalised so they are valid for that datatype.
  - TRUNCATION IS REPORTED. If a row cap is hit, the table is named in
    `truncated` and the result is explicitly `complete == False`. A partial
    graph never presents itself as whole.
  - CONFLATION IS DETECTED. If two rows share a subject key, their values merge
    onto one subject and the graph asserts something FALSE rather than merely
    incomplete. Those rows are counted in `rows_with_duplicate_key`, the table
    is named in `conflated_tables`, and `has_conflation` is true. This is not
    hypothetical: Unity Catalog primary keys are informational and unenforced,
    so a declared constraint does not rule it out.
  - Output is deterministic: quads are emitted in sorted order, so the same
    mappings over the same data produce a byte-identical artifact.

stdlib only.
"""
from __future__ import annotations

import hashlib
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Optional
from urllib.parse import quote

from .data_adapter import DataAdapter
from .discovery import LogicalType
from .mapping import ProposalKind, PublishedMapping, PublishedMappingSet

RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
XSD_NS = "http://www.w3.org/2001/XMLSchema#"
PROV_NS = "http://www.w3.org/ns/prov#"
RDF_TYPE = RDF_NS + "type"

# Logical type -> XSD datatype. None means an untyped (plain) literal, which is
# correct for strings: `"x"` and `"x"^^xsd:string` are the same term in RDF 1.1,
# and the plain form is smaller and more portable.
_XSD_FOR: dict[LogicalType, Optional[str]] = {
    LogicalType.STRING: None,
    LogicalType.UUID: None,
    LogicalType.UNKNOWN: None,
    LogicalType.INTEGER: XSD_NS + "integer",
    LogicalType.DECIMAL: XSD_NS + "decimal",
    LogicalType.BOOLEAN: XSD_NS + "boolean",
    LogicalType.DATE: XSD_NS + "date",
    LogicalType.TIMESTAMP: XSD_NS + "dateTime",
}

DEFAULT_GRAPH_PREFIX = "urn:kg:build:"


class MaterializationError(ValueError):
    """Raised when a precise graph cannot be produced from these mappings."""


# --------------------------------------------------------------------------- #
# N-Quads serialization primitives
# --------------------------------------------------------------------------- #
def escape_literal(value: str) -> str:
    """Escape a string for an N-Quads quoted literal (W3C N-Quads, §Grammar).

    Backslash first, or the escapes we add would themselves be re-escaped.
    Remaining C0 control characters become \\uXXXX; everything else stays as
    UTF-8, which N-Quads permits.
    """
    out = value.replace("\\", "\\\\").replace('"', '\\"')
    out = out.replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t")
    return "".join(
        c if ord(c) >= 0x20 else f"\\u{ord(c):04X}"
        for c in out
    )


def iri_segment(value: Any) -> str:
    """Percent-encode a value for safe inclusion in an IRI path segment.

    Nothing is left to chance: every character outside the unreserved set is
    encoded, so a key containing a space, a slash or a quote cannot produce a
    malformed IRI or collide with the segment separator.
    """
    return quote(str(value), safe="")


def quad(subject: str, predicate: str, obj: str, graph: str) -> str:
    """One N-Quads line. `obj` must already be a term (IRI form or literal)."""
    return f"<{subject}> <{predicate}> {obj} <{graph}> ."


def iri_term(iri: str) -> str:
    return f"<{iri}>"


# --------------------------------------------------------------------------- #
# Structured triples
# --------------------------------------------------------------------------- #
# Triples are carried as data, not as rendered text, because the entailment pass
# has to pattern-match on them. Serialization is the LAST step, so a reasoner
# never has to parse strings back apart — which is where subtle corruption would
# otherwise creep in.
#
#   object position: ("iri", "<uri>") or ("lit", '"already rendered"^^<dt>')
ObjectTerm = tuple[str, str]
Triple = tuple[str, str, ObjectTerm]


def obj_iri(uri: str) -> ObjectTerm:
    return ("iri", uri)


def obj_literal(term: str) -> ObjectTerm:
    """Wrap an ALREADY-RENDERED literal term (see `typed_literal`)."""
    return ("lit", term)


def is_iri(obj: ObjectTerm) -> bool:
    return obj[0] == "iri"


def render_object(obj: ObjectTerm) -> str:
    return f"<{obj[1]}>" if obj[0] == "iri" else obj[1]


def serialize_quads(triples: Iterable[Triple], graph: str) -> list[str]:
    """Render triples into sorted N-Quads lines in one named graph."""
    return sorted(
        quad(s, p, render_object(o), graph) for (s, p, o) in triples
    )


def _canonical_decimal(text: str) -> tuple[str, str]:
    """Return (lexical, datatype) for a decimal, promoting to double if needed.

    `1e-05` is a valid xsd:double but NOT a valid xsd:decimal. Emitting it as
    decimal would produce an ill-typed literal that some stores reject and
    others silently coerce, so the datatype follows the lexical form.
    """
    if "e" in text or "E" in text:
        return text, XSD_NS + "double"
    return text, XSD_NS + "decimal"


def typed_literal(value: Any, logical_type: LogicalType) -> str:
    """Render a column value as an N-Quads literal term, correctly typed.

    Canonicalisation is per-datatype rather than a blanket `str()`:
    booleans become `true`/`false`, timestamps get the `T` separator xsd:dateTime
    requires (Databricks and most warehouses return a space), and decimals in
    exponent form are promoted to xsd:double.
    """
    dt = _XSD_FOR.get(logical_type)

    if isinstance(value, bool) or logical_type == LogicalType.BOOLEAN:
        if isinstance(value, bool):
            lexical = "true" if value else "false"
        else:
            lexical = str(value).strip().lower()
            if lexical in ("1", "t", "yes", "y"):
                lexical = "true"
            elif lexical in ("0", "f", "no", "n"):
                lexical = "false"
        return f'"{escape_literal(lexical)}"^^<{XSD_NS}boolean>'

    if logical_type == LogicalType.TIMESTAMP:
        lexical = value.isoformat() if hasattr(value, "isoformat") else str(value)
        if " " in lexical and "T" not in lexical:
            lexical = lexical.replace(" ", "T", 1)
        return f'"{escape_literal(lexical)}"^^<{XSD_NS}dateTime>'

    if logical_type == LogicalType.DATE:
        lexical = value.isoformat() if hasattr(value, "isoformat") else str(value)
        return f'"{escape_literal(lexical)}"^^<{XSD_NS}date>'

    if logical_type == LogicalType.DECIMAL:
        lexical, datatype = _canonical_decimal(str(value))
        return f'"{escape_literal(lexical)}"^^<{datatype}>'

    if dt:
        return f'"{escape_literal(str(value))}"^^<{dt}>'
    return f'"{escape_literal(str(value))}"'


# --------------------------------------------------------------------------- #
# Subject IRIs
# --------------------------------------------------------------------------- #
def mint_subject_iri(base_uri: str, table: str, key_values: Iterable[Any]) -> str:
    """Build a stable subject IRI from a table and its DISCOVERED key values.

    The shape matches `to_r2rml`'s subject template
    (`{base}{table}/{k1}/{k2}`), so the artifact and the graph agree on identity
    and a re-run over unchanged data mints the same IRIs.
    """
    parts = [iri_segment(v) for v in key_values]
    return f"{base_uri}{iri_segment(table)}/" + "/".join(parts)


# --------------------------------------------------------------------------- #
# Result
# --------------------------------------------------------------------------- #
@dataclass
class MaterializationResult:
    """Exactly what was written, and what was not."""

    build_id: str
    graph_uri: str
    source_id: str
    set_fingerprint: str
    source_fingerprint: str
    quads: int = 0
    class_instances: int = 0
    literal_triples: int = 0
    relationship_triples: int = 0
    provenance_quads: int = 0
    rows_read: int = 0
    rows_skipped_null_key: int = 0
    null_values_skipped: int = 0
    #: Rows whose subject key had already been seen. Each one means two source
    #: rows were CONFLATED into a single subject carrying both their values —
    #: a false assertion, not a missing one.
    rows_with_duplicate_key: int = 0
    #: Tables where that happened, so the cause can be found.
    conflated_tables: list[str] = field(default_factory=list)
    per_table: dict[str, int] = field(default_factory=dict)
    skipped: list[dict[str, Any]] = field(default_factory=list)
    truncated: list[str] = field(default_factory=list)
    built_at: str = ""

    @property
    def complete(self) -> bool:
        """False whenever any row cap was hit — a partial graph says so.

        Completeness is about COVERAGE only. A conflated build can be complete
        and still wrong, which is why `has_conflation` is reported separately
        rather than folded in here.
        """
        return not self.truncated

    @property
    def has_conflation(self) -> bool:
        """True when a subject key was not unique, so entities were merged."""
        return self.rows_with_duplicate_key > 0

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["complete"] = self.complete
        d["has_conflation"] = self.has_conflation
        return d


# --------------------------------------------------------------------------- #
# SQL generation
# --------------------------------------------------------------------------- #
# Identifier quoting is NOT portable, and getting it wrong is not a cosmetic
# error. Databricks reads a double-quoted token as a STRING LITERAL, so
# `t0."site_id"` does not select a column there — it is a parse error, verified
# against a live warehouse. ANSI stores want the opposite. So the dialect is an
# explicit input rather than an assumption baked into the generator.
_IDENT_OK = __import__("re").compile(r"^[A-Za-z_][A-Za-z0-9_$ -]*$")


@dataclass(frozen=True)
class SqlDialect:
    """How one backend spells a quoted identifier."""

    name: str
    quote: str

    def ident(self, raw: str) -> str:
        """Validate against a conservative pattern, then quote.

        Identifiers reach here from catalog metadata, not user input, so the
        answer to a name containing a quote, a newline or a semicolon is to
        REFUSE it, not to escape it: such a name is a sign something is wrong
        upstream, and escaping would quietly carry the problem into the query.
        """
        if not isinstance(raw, str) or not _IDENT_OK.match(raw):
            raise MaterializationError(f"unsafe SQL identifier: {raw!r}")
        return f"{self.quote}{raw}{self.quote}"


#: ANSI/default. Matches the offline fixture adapter and most warehouses.
ANSI_DIALECT = SqlDialect("ansi", '"')
#: Databricks / Spark SQL. Required for Unity Catalog.
DATABRICKS_DIALECT = SqlDialect("databricks", "`")


def _qualify(
    table: str, qualifier: Optional[Callable[[str], str]], dialect: SqlDialect
) -> str:
    """Render a table reference, letting the caller fully qualify it.

    A bare quoted name by default; a backend needing `catalog.schema.table`
    supplies a qualifier rather than this module guessing at a naming scheme.
    """
    if qualifier:
        return qualifier(table)
    return dialect.ident(table)


def _select_sql(
    table: str,
    columns: list[str],
    *,
    qualifier: Optional[Callable[[str], str]] = None,
    limit: Optional[int] = None,
    dialect: SqlDialect = ANSI_DIALECT,
) -> str:
    """SELECT with positional aliases, so duplicate columns cannot collide."""
    q = dialect.ident
    items = ", ".join(f"t0.{q(c)} AS {q('c' + str(i))}" for i, c in enumerate(columns))
    sql = f"SELECT {items} FROM {_qualify(table, qualifier, dialect)} AS t0"
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return sql


def _join_sql(
    drive_table: str,
    drive_columns: list[str],
    other_table: str,
    other_columns: list[str],
    on_pairs: list[tuple[str, str]],
    *,
    qualifier: Optional[Callable[[str], str]] = None,
    limit: Optional[int] = None,
    dialect: SqlDialect = ANSI_DIALECT,
) -> str:
    q = dialect.ident
    items = [f"t0.{q(c)} AS {q('d' + str(i))}" for i, c in enumerate(drive_columns)]
    items += [f"t1.{q(c)} AS {q('o' + str(i))}" for i, c in enumerate(other_columns)]
    on = " AND ".join(f"t0.{q(l)} = t1.{q(r)}" for l, r in on_pairs)
    sql = (
        f"SELECT {', '.join(items)} FROM {_qualify(drive_table, qualifier, dialect)} AS t0 "
        f"LEFT JOIN {_qualify(other_table, qualifier, dialect)} AS t1 ON {on}"
    )
    if limit is not None:
        sql += f" LIMIT {int(limit)}"
    return sql


# --------------------------------------------------------------------------- #
# The materializer
# --------------------------------------------------------------------------- #
def materialize_graph(
    published: PublishedMappingSet,
    adapter: DataAdapter,
    *,
    build_id: str,
    base_uri: str = "http://graph-utility/resource/",
    graph_uri: Optional[str] = None,
    strict: bool = True,
    max_rows_per_table: Optional[int] = None,
    table_qualifier: Optional[Callable[[str], str]] = None,
    dialect: SqlDialect = ANSI_DIALECT,
) -> tuple[set[Triple], MaterializationResult]:
    """Build the ASSERTED triples from published mappings, as structured data.

    Separated from serialization so the entailment pass can consume triples
    directly. Only PUBLISHED mappings are read, so the approval gate is the only
    way in: this function has no path to an unapproved proposal.
    """
    graph = graph_uri or f"{DEFAULT_GRAPH_PREFIX}{build_id}"
    result = MaterializationResult(
        build_id=build_id,
        graph_uri=graph,
        source_id=published.source_id,
        set_fingerprint=published.set_fingerprint,
        source_fingerprint=published.source_fingerprint,
        built_at=datetime.now(timezone.utc).isoformat(),
    )
    triples: set[Triple] = set()

    # ---- direct mappings, grouped per table ---- #
    by_table: dict[str, list[PublishedMapping]] = {}
    for m in published.mappings:
        if m.kind == ProposalKind.DIRECT.value and m.target_table and m.target_column:
            by_table.setdefault(m.target_table, []).append(m)

    # Subject keys per table, needed by both phases below.
    subject_keys: dict[str, tuple[str, ...]] = {}
    for table in sorted({*by_table, *_relationship_tables(published)}):
        cls = published.class_for_table(table)
        if cls and cls.subject_columns:
            subject_keys[table] = tuple(cls.subject_columns)

    for table in sorted(by_table):
        mappings = sorted(by_table[table], key=lambda m: (m.ontology_uri, m.target_column or ""))
        cls = published.class_for_table(table)
        if cls is None or not cls.subject_columns:
            msg = (
                f"table '{table}' has {len(mappings)} direct mapping(s) but no "
                f"published keyed CLASS mapping; cannot mint subject IRIs "
                f"(no fabricated surrogate key)"
            )
            if strict:
                raise MaterializationError(msg)
            result.skipped.append({
                "table": table,
                "code": "no-published-class-key",
                "message": msg,
                "omitted_predicates": [m.ontology_uri for m in mappings],
            })
            continue

        keys = tuple(cls.subject_columns)
        value_columns = [m.target_column for m in mappings]
        # Keys first so their positions are known; a key that is also mapped is
        # selected twice under different aliases, which is harmless.
        columns = list(keys) + value_columns
        sql = _select_sql(
            table, columns, qualifier=table_qualifier, dialect=dialect,
            limit=(max_rows_per_table + 1) if max_rows_per_table else None,
        )
        qr = adapter.execute(sql, {})
        rows = qr.rows
        if max_rows_per_table is not None and len(rows) > max_rows_per_table:
            rows = rows[:max_rows_per_table]
            result.truncated.append(table)

        emitted_here = 0
        # Subject keys are supposed to identify a row. When two rows share one,
        # their property values MERGE onto a single subject — the graph then
        # asserts that one entity has both rows' values, which is false rather
        # than merely incomplete. Unity Catalog constraints are informational
        # and unenforced, so a DECLARED primary key does not rule this out; the
        # only way to know is to watch for it here.
        seen_subjects: set[str] = set()
        for row in rows:
            result.rows_read += 1
            key_values = [row.get(f"c{i}") for i in range(len(keys))]
            if any(v is None or str(v) == "" for v in key_values):
                result.rows_skipped_null_key += 1
                continue
            subject = mint_subject_iri(base_uri, table, key_values)
            if subject in seen_subjects:
                result.rows_with_duplicate_key += 1
                if table not in result.conflated_tables:
                    result.conflated_tables.append(table)
            else:
                seen_subjects.add(subject)
                emitted_here += 1
            triples.add((subject, RDF_TYPE, obj_iri(cls.ontology_uri)))
            for offset, m in enumerate(mappings):
                value = row.get(f"c{len(keys) + offset}")
                if value is None:
                    result.null_values_skipped += 1
                    continue
                lt = LogicalType.coerce(m.logical_type)
                triples.add((subject, m.ontology_uri, obj_literal(typed_literal(value, lt))))
                result.literal_triples += 1
        # Count DISTINCT subjects, not rows: reporting one instance per row
        # while the graph holds one node is exactly the kind of quiet
        # disagreement the manifest exists to prevent.
        result.class_instances += len(seen_subjects)
        result.per_table[table] = emitted_here

    # ---- relationships ---- #
    for m in sorted(
        (m for m in published.mappings
         if m.kind == ProposalKind.RELATIONSHIP.value and m.join),
        key=lambda m: (m.ontology_uri, str(m.join)),
    ):
        join = m.join or {}
        left_table, right_table = join["left_table"], join["right_table"]
        left_cols = list(join["left_columns"])
        right_cols = list(join["right_columns"])

        missing = [t for t in (left_table, right_table) if t not in subject_keys]
        if missing:
            msg = (
                f"relationship '{m.ontology_label}' needs subject IRIs for "
                f"{missing}, but no published keyed CLASS mapping exists for "
                f"them; the edge cannot be minted precisely"
            )
            if strict:
                raise MaterializationError(msg)
            result.skipped.append({
                "relationship": m.ontology_uri,
                "code": "no-published-class-key",
                "message": msg,
            })
            continue

        # Drive the query FROM the table holding the foreign key. One row per
        # edge either way, and it avoids fanning out from the parent side.
        if join.get("cardinality") == "one-to-many":
            drive, other = right_table, left_table
            drive_keys, other_keys = subject_keys[right_table], subject_keys[left_table]
            on_pairs = list(zip(right_cols, left_cols))
            drive_is_left = False
        else:
            drive, other = left_table, right_table
            drive_keys, other_keys = subject_keys[left_table], subject_keys[right_table]
            on_pairs = list(zip(left_cols, right_cols))
            drive_is_left = True

        sql = _join_sql(
            drive, list(drive_keys), other, list(other_keys), on_pairs,
            qualifier=table_qualifier, dialect=dialect,
            limit=(max_rows_per_table + 1) if max_rows_per_table else None,
        )
        qr = adapter.execute(sql, {})
        rows = qr.rows
        if max_rows_per_table is not None and len(rows) > max_rows_per_table:
            rows = rows[:max_rows_per_table]
            result.truncated.append(f"{left_table}->{right_table}")

        for row in rows:
            result.rows_read += 1
            dv = [row.get(f"d{i}") for i in range(len(drive_keys))]
            ov = [row.get(f"o{i}") for i in range(len(other_keys))]
            # An unmatched LEFT JOIN row, or a NULL key on either end, is not an
            # edge. Skipping is the only honest option: a dangling reference
            # cannot be expressed as a triple.
            if any(v is None or str(v) == "" for v in dv + ov):
                result.rows_skipped_null_key += 1
                continue
            drive_iri = mint_subject_iri(base_uri, drive, dv)
            other_iri = mint_subject_iri(base_uri, other, ov)
            subject, obj = (drive_iri, other_iri) if drive_is_left else (other_iri, drive_iri)
            triples.add((subject, m.ontology_uri, obj_iri(obj)))
            result.relationship_triples += 1

    result.quads = len(triples)
    return triples, result


def provenance_quads(
    published: PublishedMappingSet,
    result: MaterializationResult,
    *,
    base_uri: str = "http://graph-utility/resource/",
    extra: Optional[dict[str, str]] = None,
) -> list[str]:
    """Build-level provenance, in its own graph so it never pollutes the data."""
    graph = result.graph_uri
    prov_graph = f"{graph}:prov"
    build_iri = f"{base_uri}build/{iri_segment(result.build_id)}"
    lines = [
        quad(build_iri, PROV_NS + "generatedAtTime",
             f'"{escape_literal(result.built_at)}"^^<{XSD_NS}dateTime>', prov_graph),
        quad(build_iri, f"{base_uri}vocab/setFingerprint",
             f'"{escape_literal(published.set_fingerprint)}"', prov_graph),
        quad(build_iri, f"{base_uri}vocab/sourceFingerprint",
             f'"{escape_literal(published.source_fingerprint)}"', prov_graph),
        quad(build_iri, f"{base_uri}vocab/sourceId",
             f'"{escape_literal(published.source_id)}"', prov_graph),
        quad(build_iri, f"{base_uri}vocab/dataGraph", iri_term(graph), prov_graph),
    ]
    for pred, value in sorted((extra or {}).items()):
        lines.append(quad(build_iri, f"{base_uri}vocab/{pred}",
                          f'"{escape_literal(value)}"', prov_graph))
    return sorted(set(lines))


def materialize_to_nquads(
    published: PublishedMappingSet,
    adapter: DataAdapter,
    *,
    build_id: str,
    base_uri: str = "http://graph-utility/resource/",
    graph_uri: Optional[str] = None,
    strict: bool = True,
    max_rows_per_table: Optional[int] = None,
    table_qualifier: Optional[Callable[[str], str]] = None,
    dialect: SqlDialect = ANSI_DIALECT,
    include_provenance: bool = True,
) -> tuple[list[str], MaterializationResult]:
    """Build and serialize in one step: published mappings -> N-Quads lines.

    Returns `(lines, result)`. `lines` is sorted and newline-free; the caller
    decides where they go (a file, S3, a SPARQL payload).
    """
    triples, result = materialize_graph(
        published, adapter, build_id=build_id, base_uri=base_uri,
        graph_uri=graph_uri, strict=strict,
        max_rows_per_table=max_rows_per_table,
        table_qualifier=table_qualifier, dialect=dialect,
    )
    lines = serialize_quads(triples, result.graph_uri)
    if include_provenance:
        prov = provenance_quads(published, result, base_uri=base_uri)
        result.provenance_quads = len(prov)
        lines = lines + prov
    result.quads = len(lines)
    return lines, result


def _relationship_tables(published: PublishedMappingSet) -> set[str]:
    out: set[str] = set()
    for m in published.mappings:
        if m.kind == ProposalKind.RELATIONSHIP.value and m.join:
            out.add(m.join["left_table"])
            out.add(m.join["right_table"])
    return out


def write_nquads(lines: list[str], path: str) -> dict[str, Any]:
    """Write the artifact and return its size + content hash.

    The hash is over the exact bytes written, so an artifact loaded into Neptune
    can be tied back to the build that produced it.
    """
    body = "".join(line + "\n" for line in lines).encode("utf-8")
    with open(path, "wb") as fh:
        fh.write(body)
    return {
        "path": path,
        "bytes": len(body),
        "lines": len(lines),
        "sha256": hashlib.sha256(body).hexdigest(),
    }


#: Suffixes of the graphs a build owns, besides the data graph itself.
BUILD_GRAPH_SUFFIXES = (":inferred", ":prov")


def build_graphs(graph_uri: str) -> list[str]:
    """Every named graph one build owns: data, entailments, provenance."""
    return [graph_uri] + [f"{graph_uri}{s}" for s in BUILD_GRAPH_SUFFIXES]


def drop_graph_sparql(graph_uri: str) -> str:
    """The SPARQL UPDATE that removes one build COMPLETELY.

    Teardown is exact because the build owns its graphs: no node-by-node
    matching, and no risk of deleting another build's statements. All three
    graphs must go — leaving `:inferred` or `:prov` behind would orphan
    statements that refer to data no longer present, which is precisely the
    accumulation problem the per-build graph exists to prevent.
    """
    return "; ".join(f"DROP GRAPH <{g}>" for g in build_graphs(graph_uri))
