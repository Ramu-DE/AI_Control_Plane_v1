"""OntoBricks as a graph target — alongside Neptune and Neo4j.

OntoBricks (databrickslabs/ontobricks) materializes Unity Catalog tables into a
knowledge graph. Since ContractIQ already lives in Unity Catalog, it is the
closest thing to a native option, so it belongs in the same seam as Neptune and
Neo4j rather than in a document.

WHAT THIS MODULE IS, AND IS NOT

It is the HANDOFF, not a reimplementation. OntoBricks owns its own ontology
designer, registry and app; what it accepts from outside is a W3C R2RML mapping
document (`src/back/core/w3c/r2rml/R2RMLParser.py`). So this module turns a
published, evidence-approved mapping set into R2RML Turtle it can ingest.

That is the whole integration argument: our side contributes mappings justified
by MEASURED evidence — value overlap and proven key uniqueness — and OntoBricks
contributes materialization, SHACL and an explorer. R2RML is a standard on both
sides, so neither has to know about the other's internals.

CAPABILITIES ARE DECLARED, NOT DISCOVERED

`ONTOBRICKS` below records what the target can and cannot do, taken from its
own source and docs (v0.9.0) rather than from optimism. The point is to refuse
a plan the target cannot execute BEFORE a build, instead of discovering it from
a query that silently returns the wrong rows. Three of these decide real
designs:

  - SPARQL is a fail-closed subset. No property paths, no GROUP BY/ORDER BY,
    no numeric FILTER. Transitive reachability and "top N by value" are not
    expressible, and those are ContractIQ questions.
  - Triples are flat (s,p,o). There are no named graphs, so a build cannot be
    scoped or dropped as a unit — the same accumulation trap we avoid on
    Neptune with one named graph per build.
  - OWL 2 RL closure runs in-memory via `owlrl` and its own comment caps it at
    "< ~50 000 triples"; past that, reasoning falls back to backend SQL rules,
    which is a weaker guarantee than OWL 2 RL.

None of that makes OntoBricks a bad target. It makes it a target whose limits
have to be checked against the question set, which is what `unsupported_for`
is for.

stdlib only.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from .mapping import ProposalKind, PublishedMappingSet, R2RMLError
from .materialize import LogicalType

# --------------------------------------------------------------------------- #
# Capability declaration
# --------------------------------------------------------------------------- #

#: SPARQL constructs the OntoBricks SQL translator rejects. Verbatim from
#: `src/back/core/w3c/sparql/SparqlCapabilityValidator.py` (v0.9.0), which is
#: fail-closed: anything not explicitly allowed is refused before SQL is
#: generated. Worth reading as a list of questions you cannot ask.
ONTOBRICKS_UNSUPPORTED_SPARQL: tuple[str, ...] = (
    "GROUP BY",
    "HAVING",
    "ORDER BY",
    "OFFSET",
    "property paths",
    "subquery",
    "MINUS",
    "VALUES",
    "SERVICE",
    "GRAPH",
    "arbitrary UNION",
    "non-literal BIND",
    "numeric FILTER",
    "complex FILTER",
)

#: FILTER forms that DO work: string containment and equality only.
ONTOBRICKS_SUPPORTED_FILTERS: tuple[str, ...] = (
    "CONTAINS",
    "STRSTARTS",
    "STRENDS",
    "string equality",
    "predicate IN",
)


@dataclass(frozen=True)
class GraphTargetCapabilities:
    """What a graph target can actually do.

    Declared per target so the build plane can refuse an impossible plan. Every
    field is a capability we have had to reason about at least once, not a
    speculative matrix.
    """

    name: str
    #: Quads / named graphs. Without this, a build cannot be scoped or dropped
    #: as a unit, and asserted vs inferred cannot be separated at the store.
    named_graphs: bool
    #: Full SPARQL 1.1 query. False means a subset — see `unsupported_sparql`.
    sparql_1_1: bool
    #: Transitive reachability in one query (SPARQL property paths / Cypher *).
    property_paths: bool
    #: Aggregation and ordering in the query language.
    aggregation: bool
    #: Numeric comparison in a filter (`?v > 1000`).
    numeric_filters: bool
    #: Triples above which the OWL closure path stops being the real one.
    reasoning_triple_ceiling: Optional[int]
    #: Deletes a previously materialized build without touching others.
    scoped_teardown: bool
    unsupported_sparql: tuple[str, ...] = ()
    notes: tuple[str, ...] = ()

    def unsupported_for(self, needs: Iterable[str]) -> list[str]:
        """Which of `needs` this target cannot serve. Empty means go ahead.

        `needs` are capability field names, so a caller states requirements in
        the same vocabulary the target declares them in — a typo raises instead
        of silently passing, which a dict of booleans would not.
        """
        missing: list[str] = []
        for need in needs:
            if not hasattr(self, need):
                raise ValueError(
                    f"unknown capability '{need}'; expected one of "
                    f"{sorted(f for f in self.__dataclass_fields__ if f != 'name')}"
                )
            value = getattr(self, need)
            if value is False:
                missing.append(need)
        return missing


#: Verified against ontobricks v0.9.0 source and docs/architecture.md.
ONTOBRICKS = GraphTargetCapabilities(
    name="ontobricks",
    named_graphs=False,
    sparql_1_1=False,
    property_paths=False,
    aggregation=False,
    numeric_filters=False,
    reasoning_triple_ceiling=50_000,
    scoped_teardown=False,
    unsupported_sparql=ONTOBRICKS_UNSUPPORTED_SPARQL,
    notes=(
        "SPARQL is translated to Spark SQL through a fail-closed subset validator.",
        "Triples are flat (s,p,o) in Delta/Postgres tables; there is no quad column.",
        "owlrl closure is in-memory and self-documented as '< ~50 000 triples'.",
        "Inferences are purged and rebuilt rather than incrementally maintained.",
        "The Neo4j backend's Cypher translation is scaffolded, not complete (v0.9.0).",
        "Licensed under the Databricks License: use is tied to Databricks Services.",
    ),
)

#: Neptune Database, for comparison. Full SPARQL 1.1 and quads, no OWL reasoner.
NEPTUNE = GraphTargetCapabilities(
    name="neptune",
    named_graphs=True,
    sparql_1_1=True,
    property_paths=True,
    aggregation=True,
    numeric_filters=True,
    # Neptune has no OWL reasoner at all, so entailment is ours to materialize
    # (reason.py). There is no ceiling because there is no engine to exceed.
    reasoning_triple_ceiling=None,
    scoped_teardown=True,
    notes=(
        "No OWL/RDFS reasoner: entailment must be materialized before load.",
        "VPC-only; reachable from inside the VPC or through a proxy.",
        "Neptune Analytics is openCypher-only and does not serve SPARQL.",
    ),
)

#: Neo4j / Aura. A property graph: expressive traversal, but not RDF.
NEO4J = GraphTargetCapabilities(
    name="neo4j",
    # Property graphs have no quad; a build is scoped with a label or property,
    # which is a convention rather than a store-level partition.
    named_graphs=False,
    sparql_1_1=False,
    property_paths=True,
    aggregation=True,
    numeric_filters=True,
    reasoning_triple_ceiling=None,
    scoped_teardown=True,
    notes=(
        "Cypher, not SPARQL: variable-length paths and aggregation are native.",
        "MERGE keys on the URI property, so a rebuilt node updates in place "
        "only if the URI is stable — otherwise builds accumulate.",
    ),
)

TARGETS: dict[str, GraphTargetCapabilities] = {
    t.name: t for t in (ONTOBRICKS, NEPTUNE, NEO4J)
}


def target_capabilities(name: str) -> GraphTargetCapabilities:
    """Look up a target, with a message that lists the real options."""
    try:
        return TARGETS[name]
    except KeyError:
        raise ValueError(
            f"unknown graph target '{name}'; available: {sorted(TARGETS)}"
        ) from None


# --------------------------------------------------------------------------- #
# R2RML Turtle — the handoff artifact
# --------------------------------------------------------------------------- #

R2RML_NS = "http://www.w3.org/ns/r2rml#"
XSD_NS = "http://www.w3.org/2001/XMLSchema#"

#: Logical type -> rr:datatype. UNKNOWN is deliberately absent: an untyped
#: literal is honest, whereas guessing xsd:string makes a date sort wrongly and
#: a number fail to aggregate.
_XSD_FOR_LOGICAL: dict[str, str] = {
    LogicalType.STRING.value: "xsd:string",
    LogicalType.INTEGER.value: "xsd:integer",
    LogicalType.DECIMAL.value: "xsd:decimal",
    LogicalType.BOOLEAN.value: "xsd:boolean",
    LogicalType.DATE.value: "xsd:date",
    LogicalType.TIMESTAMP.value: "xsd:dateTime",
}


def _ttl_string(value: str) -> str:
    """A Turtle string literal. Escapes before quoting, never after."""
    out = (
        str(value)
        .replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
    )
    return f'"{out}"'


def _ttl_iri(iri: str) -> str:
    """An IRI in angle brackets, refusing anything that would break the syntax.

    A mapping is an artifact another system parses, so an IRI containing a
    space or a bracket must fail here rather than produce a document that
    parses into something subtly different.
    """
    text = str(iri)
    if not text:
        raise R2RMLError("empty IRI cannot be serialized")
    bad = [ch for ch in text if ch in "<>\" {}|^`\\" or ord(ch) < 0x21]
    if bad:
        raise R2RMLError(
            f"IRI {text!r} contains character(s) {sorted(set(bad))!r} that are "
            f"not valid in a Turtle IRIREF"
        )
    return f"<{text}>"


def _map_name(base_uri: str, table: str) -> str:
    """A stable, unique TriplesMap IRI for a table.

    The fully-qualified table name is used verbatim: two tables of the same
    name in different schemas are different maps, and shortening to the bare
    name would collide them into one.
    """
    return f"{base_uri.rstrip('/#')}#TriplesMap_{table.replace('.', '_')}"


@dataclass
class R2RMLDocument:
    """Emitted Turtle plus what had to be left out, kept together.

    The omissions travel WITH the document on purpose. A caller that reads only
    `turtle` would hand OntoBricks a mapping that looks complete, and the
    missing predicates would show up later as absent edges in the graph rather
    than as an error.
    """

    turtle: str
    triples_maps: int = 0
    predicate_object_maps: int = 0
    ref_object_maps: int = 0
    omissions: list[dict[str, Any]] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.omissions

    def to_dict(self) -> dict[str, Any]:
        return {
            "triples_maps": self.triples_maps,
            "predicate_object_maps": self.predicate_object_maps,
            "ref_object_maps": self.ref_object_maps,
            "complete": self.complete,
            "omissions": list(self.omissions),
        }


def to_r2rml_turtle(
    published: PublishedMappingSet,
    *,
    base_uri: str = "http://graph-utility/mapping",
    subject_base: Optional[str] = None,
    strict: bool = True,
) -> R2RMLDocument:
    """Serialize a published mapping set as W3C R2RML Turtle.

    `mapping.to_r2rml()` already produces an R2RML-SHAPED dict, but it is not
    R2RML: the keys are ours, and its `refObjectMaps` carry no predicate, so
    the artifact cannot say WHICH object property a join represents. That is
    fine for our own planner, which resolves relationships separately, and
    useless to an external parser, which has only the document. This emitter
    walks the RELATIONSHIP mappings directly so every join keeps its predicate.

    A table whose DIRECT mappings have no published keyed CLASS cannot get a
    precise subject template — the same fail-closed rule as `to_r2rml()`. With
    `strict=True` that raises; otherwise the table is omitted and recorded.
    """
    sub_base = (subject_base or base_uri).rstrip("/#")
    doc_base = base_uri.rstrip("/#")

    directs: dict[str, list] = {}
    relationships: list = []
    for m in published.mappings:
        if m.kind == ProposalKind.DIRECT.value and m.target_table:
            directs.setdefault(m.target_table, []).append(m)
        elif m.kind == ProposalKind.RELATIONSHIP.value and m.join:
            relationships.append(m)

    omissions: list[dict[str, Any]] = []
    # Every table that has a keyed class gets a TriplesMap, even with no direct
    # mappings: a relationship may need it as a rr:parentTriplesMap target.
    keyed_tables: dict[str, Any] = {}
    for table in sorted(set(directs) | _relationship_tables(relationships)):
        cls = published.class_for_table(table)
        if cls is None or not cls.subject_columns:
            msg = (
                f"table '{table}' has no published keyed CLASS mapping, so no "
                f"precise subject template can be emitted (no fabricated "
                f"surrogate key)"
            )
            if strict:
                raise R2RMLError(msg)
            omissions.append({
                "table": table,
                "code": "no-published-class-key",
                "message": msg,
                "omitted_predicates": sorted(
                    m.ontology_uri for m in directs.get(table, [])
                ),
            })
            continue
        keyed_tables[table] = cls

    lines: list[str] = [
        f"@prefix rr: <{R2RML_NS}> .",
        f"@prefix xsd: <{XSD_NS}> .",
        "",
        "# Generated by graph-utility. Every mapping below was approved either by",
        "# a human or by the threshold policy on MEASURED evidence (verified key",
        f"# uniqueness, value overlap). Source: {published.source_id}",
        f"# mapping_version: {published.mapping_version}",
        f"# set_fingerprint: {published.set_fingerprint}",
        "",
    ]

    pom_count = 0
    rom_count = 0

    for table, cls in keyed_tables.items():
        name = _map_name(doc_base, table)
        template = "/".join("{" + c + "}" for c in cls.subject_columns)
        block = [
            f"{_ttl_iri(name)}",
            f"    rr:logicalTable [ rr:tableName {_ttl_string(table)} ] ;",
            "    rr:subjectMap [",
            f"        rr:template {_ttl_string(f'{sub_base}/{table}/{template}')} ;",
            f"        rr:class {_ttl_iri(cls.ontology_uri)}",
            "    ]",
        ]
        for m in sorted(directs.get(table, []), key=lambda x: x.ontology_uri):
            if not m.target_column:
                omissions.append({
                    "table": table,
                    "code": "no-target-column",
                    "message": (
                        f"direct mapping for '{m.ontology_uri}' has no target "
                        f"column and was omitted"
                    ),
                })
                continue
            datatype = _XSD_FOR_LOGICAL.get(m.logical_type)
            obj = [f"rr:column {_ttl_string(m.target_column)}"]
            if datatype:
                obj.append(f"rr:datatype {datatype}")
            block[-1] = block[-1] + " ;"
            block += [
                "    rr:predicateObjectMap [",
                f"        rr:predicate {_ttl_iri(m.ontology_uri)} ;",
                f"        rr:objectMap [ {' ; '.join(obj)} ]",
                "    ]",
            ]
            pom_count += 1

        # Relationships whose SUBJECT side is this table become ref object maps
        # on this TriplesMap, which is where R2RML puts them.
        for m in sorted(relationships, key=lambda x: (x.ontology_uri, x.join["right_table"])):
            join = m.join
            if join.get("left_table") != table:
                continue
            parent = join.get("right_table")
            if parent not in keyed_tables:
                omissions.append({
                    "table": table,
                    "code": "parent-not-keyed",
                    "message": (
                        f"relationship '{m.ontology_uri}' joins to '{parent}', "
                        f"which has no keyed class, so the edge was omitted"
                    ),
                })
                continue
            conds = list(
                zip(join.get("left_columns", ()), join.get("right_columns", ()))
            )
            if not conds:
                omissions.append({
                    "table": table,
                    "code": "no-join-condition",
                    "message": (
                        f"relationship '{m.ontology_uri}' has no join columns "
                        f"and was omitted"
                    ),
                })
                continue
            cond_ttl = " ; ".join(
                f"rr:joinCondition [ rr:child {_ttl_string(c)} ; "
                f"rr:parent {_ttl_string(p)} ]"
                for c, p in conds
            )
            block[-1] = block[-1] + " ;"
            block += [
                "    rr:predicateObjectMap [",
                f"        rr:predicate {_ttl_iri(m.ontology_uri)} ;",
                "        rr:objectMap [",
                f"            rr:parentTriplesMap {_ttl_iri(_map_name(doc_base, parent))} ;",
                f"            {cond_ttl}",
                "        ]",
                "    ]",
            ]
            rom_count += 1

        block[-1] = block[-1] + " ."
        lines.extend(block)
        lines.append("")

    return R2RMLDocument(
        turtle="\n".join(lines),
        triples_maps=len(keyed_tables),
        predicate_object_maps=pom_count,
        ref_object_maps=rom_count,
        omissions=omissions,
    )


def _relationship_tables(relationships: list) -> set[str]:
    """Tables a relationship needs a TriplesMap for, either side."""
    out: set[str] = set()
    for m in relationships:
        join = m.join or {}
        for key in ("left_table", "right_table"):
            if join.get(key):
                out.add(join[key])
    return out
