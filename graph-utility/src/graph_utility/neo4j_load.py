"""Load a governed build into Neo4j as a property graph.

WHY THIS EXISTS. A build ends as N-Quads for Neptune, and no Neptune cluster
exists, so every graph this module produced was a file nobody could query. The
platform's agents query Neo4j. This turns a build into a property graph there
without weakening anything the build guaranteed.

WHY IT READS N-QUADS rather than the build's in-memory triples: the artifact is
the thing that was gated, hashed and recorded in provenance. Loading exactly
that artifact means the graph in Neo4j is the graph that passed the gates, and
a saved build can be loaded later without re-running it.

THE MAPPING, RDF -> property graph:

  <s> rdf:type <C>          node label `C` (local name) + :KGEntity
  <s> <p> "literal"         node property `p`; several values -> a sorted list
  <s> <p> <o>               relationship `P` (UPPER_SNAKE of the local name)
  graph <...:inferred>      same, but the label goes in `inferred_labels` too,
                            and relationships carry `inferred: true`
  graph <...:prov>          not loaded as data; summarised on a :KGBuild node

Every node and relationship carries `kg_build`, `kg_source` and `tenant`. Nodes
MERGE on (iri, kg_build), so two builds sit side by side exactly as two named
graphs do, and a build is removable by its id (`drop_build_cypher`, which this
module never runs).

WHAT IT REFUSES rather than guesses:
  - a label, property or relationship name that is not a plain identifier is
    skipped and counted — names are inlined in Cypher, so they are never
    escaped, only validated;
  - an edge to a subject the build never typed is skipped and counted (the
    build's dangling-edge gate should already have refused it);
  - a property name that collides with a stamp (`iri`, `kg_build`, ...) is
    prefixed `p_`, never allowed to overwrite the stamp.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Optional

RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED_PROPS = frozenset({
    "iri", "kg_build", "kg_source", "tenant", "inferred_labels", "inferred_props",
})
BASE_LABEL = "KGEntity"
BUILD_LABEL = "KGBuild"


def _local(uri: str) -> str:
    if "#" in uri:
        return uri.rsplit("#", 1)[1]
    return uri.rstrip("/").rsplit("/", 1)[-1]


def rel_type(predicate_uri: str) -> str:
    """`ledBy` -> `LED_BY`, `trial_site` -> `TRIAL_SITE`."""
    local = _local(predicate_uri)
    snake = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", local)
    return re.sub(r"[^A-Za-z0-9_]", "_", snake).upper()


def build_id_from_graph(graph_uri: str) -> str:
    """`urn:kg:build:kgb-1a2b` -> `kgb-1a2b`."""
    return graph_uri.rsplit(":", 1)[-1]


def _neo4j_value(value: Any) -> Any:
    """A literal as a value Neo4j can store. Decimals become floats (Neo4j has
    no decimal type); timezone-naive datetimes are kept naive."""
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (bool, int, float, str, date, datetime)):
        return value
    return str(value)


@dataclass
class NodePlan:
    iri: str
    labels: set[str] = field(default_factory=set)
    inferred_labels: set[str] = field(default_factory=set)
    props: dict[str, list[Any]] = field(default_factory=dict)
    inferred_props: set[str] = field(default_factory=set)

    def property_map(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for key, values in self.props.items():
            uniq = sorted(set(values), key=lambda v: (type(v).__name__, str(v)))
            if len(uniq) == 1:
                out[key] = uniq[0]
            elif len({type(v) for v in uniq}) == 1:
                out[key] = uniq  # Neo4j lists must be homogeneous
            else:
                out[key] = [str(v) for v in uniq]
        return out


@dataclass
class PropertyGraphPlan:
    graph_uri: str
    build_id: str
    nodes: dict[str, NodePlan] = field(default_factory=dict)
    #: (subject iri, REL_TYPE, object iri, inferred)
    rels: list[tuple[str, str, str, bool]] = field(default_factory=list)
    prov_quads: int = 0
    skipped_names: list[str] = field(default_factory=list)
    skipped_dangling: int = 0
    other_graph_quads: int = 0

    @property
    def node_count(self) -> int:
        return len(self.nodes)

    def summary(self) -> dict[str, Any]:
        labels: dict[str, int] = {}
        for n in self.nodes.values():
            for lab in n.labels | n.inferred_labels:
                labels[lab] = labels.get(lab, 0) + 1
        types: dict[str, int] = {}
        for _, t, _, _ in self.rels:
            types[t] = types.get(t, 0) + 1
        return {
            "build_id": self.build_id,
            "nodes": self.node_count,
            "relationships": len(self.rels),
            "inferred_relationships": sum(1 for r in self.rels if r[3]),
            "labels": dict(sorted(labels.items())),
            "relationship_types": dict(sorted(types.items())),
            "skipped_names": sorted(set(self.skipped_names)),
            "skipped_dangling": self.skipped_dangling,
            "prov_quads": self.prov_quads,
            "other_graph_quads": self.other_graph_quads,
        }


def plan_property_graph(nquads: Iterable[str], graph_uri: Optional[str] = None) -> PropertyGraphPlan:
    """Parse a build's N-Quads into a property-graph plan. Pure (no I/O).

    `graph_uri` is the build's data graph; when omitted it is taken from the
    first `urn:kg:build:` graph that is not `:inferred` / `:prov`.
    """
    from rdflib import Dataset, Literal, URIRef

    ds = Dataset()
    ds.parse(data="\n".join(nquads), format="nquads")

    graphs = sorted(str(g.identifier) for g in ds.graphs())
    if graph_uri is None:
        candidates = [
            g for g in graphs
            if g.startswith("urn:kg:build:") and not g.endswith((":inferred", ":prov"))
        ]
        if len(candidates) != 1:
            raise ValueError(f"expected exactly one build data graph, found {candidates}")
        graph_uri = candidates[0]
    inferred_uri, prov_uri = f"{graph_uri}:inferred", f"{graph_uri}:prov"

    plan = PropertyGraphPlan(graph_uri=graph_uri, build_id=build_id_from_graph(graph_uri))
    edges: list[tuple[str, str, str, bool]] = []

    def node(iri: str) -> NodePlan:
        return plan.nodes.setdefault(iri, NodePlan(iri=iri))

    for s, p, o, g in ds.quads((None, None, None, None)):
        gname = str(g.identifier if hasattr(g, "identifier") else g)
        if gname == prov_uri:
            plan.prov_quads += 1
            continue
        if gname not in (graph_uri, inferred_uri):
            plan.other_graph_quads += 1
            continue
        if not isinstance(s, URIRef):
            continue  # a build never mints blank-node subjects; ignore if present
        inferred = gname == inferred_uri
        subj, pred = str(s), str(p)

        if pred == RDF_TYPE and isinstance(o, URIRef):
            label = _local(str(o))
            if not _IDENT.match(label):
                plan.skipped_names.append(f"label:{label}")
                continue
            target = node(subj)
            (target.inferred_labels if inferred else target.labels).add(label)
            continue

        if isinstance(o, Literal):
            key = _local(pred)
            if not _IDENT.match(key):
                plan.skipped_names.append(f"property:{key}")
                continue
            if key in RESERVED_PROPS:
                key = f"p_{key}"
            target = node(subj)
            target.props.setdefault(key, []).append(_neo4j_value(o.toPython()))
            if inferred:
                target.inferred_props.add(key)
            continue

        if isinstance(o, URIRef):
            rtype = rel_type(pred)
            if not _IDENT.match(rtype):
                plan.skipped_names.append(f"relationship:{rtype}")
                continue
            edges.append((subj, rtype, str(o), inferred))

    # A node exists only if the build TYPED it (asserted or inferred). An edge
    # to anything else would create an entity the graph never defined.
    typed = {iri for iri, n in plan.nodes.items() if n.labels or n.inferred_labels}
    for iri in [i for i in plan.nodes if i not in typed]:
        del plan.nodes[iri]
    for s, t, o, inf in sorted(set(edges)):
        if s in typed and o in typed:
            plan.rels.append((s, t, o, inf))
        else:
            plan.skipped_dangling += 1
    return plan


def drop_build_cypher(build_id: str) -> str:
    """The teardown for one build. Returned, never executed by this module."""
    return (
        f"MATCH (n:{BASE_LABEL} {{kg_build: '{build_id}'}}) DETACH DELETE n; "
        f"MATCH (b:{BUILD_LABEL} {{build_id: '{build_id}'}}) DELETE b"
    )


@dataclass
class LoadReport:
    build_id: str
    database: str
    nodes_written: int
    relationships_written: int
    nodes_in_db: int
    relationships_in_db: int

    @property
    def verified(self) -> bool:
        return (self.nodes_in_db, self.relationships_in_db) == (
            self.nodes_written, self.relationships_written)

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__, "verified": self.verified}


def write_property_graph(
    plan: PropertyGraphPlan,
    *,
    uri: str,
    username: str,
    password: str,
    database: str,
    graph_source_id: str,
    tenant_id: str,
    build_meta: Optional[dict[str, Any]] = None,
    batch_size: int = 500,
) -> LoadReport:
    """Write a plan with MERGE-only, parameterised Cypher, then verify counts.

    Labels and relationship types are inlined (Cypher cannot parameterise
    them) and were validated as plain identifiers in `plan_property_graph`.
    """
    from neo4j import GraphDatabase

    for name in (graph_source_id, tenant_id):
        if not name:
            raise ValueError("graph_source_id and tenant_id are required to stamp a build")

    stamp = {"build": plan.build_id, "source": graph_source_id, "tenant": tenant_id}
    driver = GraphDatabase.driver(uri, auth=(username, password))
    try:
        with driver.session(database=database) as session:
            session.run(
                f"CREATE INDEX kg_entity_iri_build IF NOT EXISTS "
                f"FOR (n:{BASE_LABEL}) ON (n.iri, n.kg_build)"
            ).consume()

            groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
            for n in plan.nodes.values():
                labels = tuple(sorted(n.labels | n.inferred_labels))
                groups.setdefault(labels, []).append({
                    "iri": n.iri,
                    "props": n.property_map(),
                    "inferred_labels": sorted(n.inferred_labels - n.labels),
                    "inferred_props": sorted(n.inferred_props),
                })
            for labels, rows in groups.items():
                label_clause = "".join(f":`{lab}`" for lab in labels)
                cypher = (
                    f"UNWIND $rows AS row "
                    f"MERGE (n:{BASE_LABEL} {{iri: row.iri, kg_build: $build}}) "
                    f"SET n += row.props, n.kg_source = $source, n.tenant = $tenant, "
                    f"n.inferred_labels = row.inferred_labels, n.inferred_props = row.inferred_props "
                    f"SET n{label_clause}"
                )
                for i in range(0, len(rows), batch_size):
                    session.run(cypher, rows=rows[i:i + batch_size], **stamp).consume()

            by_type: dict[str, list[dict[str, Any]]] = {}
            for s, t, o, inf in plan.rels:
                by_type.setdefault(t, []).append({"s": s, "o": o, "inferred": inf})
            for rtype, rows in by_type.items():
                cypher = (
                    f"UNWIND $rows AS row "
                    f"MATCH (a:{BASE_LABEL} {{iri: row.s, kg_build: $build}}) "
                    f"MATCH (b:{BASE_LABEL} {{iri: row.o, kg_build: $build}}) "
                    f"MERGE (a)-[r:`{rtype}` {{kg_build: $build}}]->(b) "
                    f"SET r.kg_source = $source, r.tenant = $tenant, r.inferred = row.inferred"
                )
                for i in range(0, len(rows), batch_size):
                    session.run(cypher, rows=rows[i:i + batch_size], **stamp).consume()

            meta = {k: v for k, v in (build_meta or {}).items() if isinstance(v, (str, int, float, bool))}
            session.run(
                f"MERGE (b:{BUILD_LABEL} {{build_id: $build}}) "
                f"SET b += $meta, b.kg_source = $source, b.tenant = $tenant, "
                f"b.nodes = $nodes, b.relationships = $rels, b.loaded_at = $at",
                meta=meta, nodes=plan.node_count, rels=len(plan.rels),
                at=datetime.now(timezone.utc).isoformat(), **stamp,
            ).consume()

            counted = session.run(
                f"MATCH (n:{BASE_LABEL} {{kg_build: $build}}) WITH count(n) AS nodes "
                f"OPTIONAL MATCH (:{BASE_LABEL})-[r {{kg_build: $build}}]->(:{BASE_LABEL}) "
                f"RETURN nodes, count(r) AS rels",
                build=plan.build_id,
            ).single()
    finally:
        driver.close()

    return LoadReport(
        build_id=plan.build_id,
        database=database,
        nodes_written=plan.node_count,
        relationships_written=len(plan.rels),
        nodes_in_db=int(counted["nodes"]),
        relationships_in_db=int(counted["rels"]),
    )
