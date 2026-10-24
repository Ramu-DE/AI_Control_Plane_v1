"""Offline tests for the dataset-agnostic build: value entities, owl:hasKey,
and acronym-safe matching (docs/TAKEDA_BU_KG_DESIGN.md §8).

The fixture is the shape most enterprise data actually has and the clinical
fixtures do not: denormalised, with NO declared keys, and entities that exist
only as column values — a product is just `sku` on orders and on inventory, a
location is `origin` and `destination` on lanes.

What must hold:
  - a class with no table becomes entities minted from column values, and the
    same value on two tables is ONE entity;
  - edges to those entities come from the referencing row and never dangle;
  - when two columns could be the target, the relationship's own name picks
    one, or the proposal is blocked rather than guessed;
  - an ontology-declared key (owl:hasKey) on non-key-shaped columns is adopted
    only after the data confirms it identifies every row;
  - gxp-strict automates none of this inferred identity.

Run: python3 tests/test_dataset_agnostic_offline.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import graph_utility as gu
from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
from graph_utility.discovery import ColumnMetadata, LogicalType, TableMetadata
from graph_utility.mapping import ProposalKind, _strip_identifier_suffix, _tokens
from graph_utility.materialize import RDF_TYPE, mint_value_iri
from graph_utility.ontology_file import RdfFileOntologyClient

S = "http://example.org/scm#"
TTL = f"""
@prefix s:    <{S}> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

s:Order a owl:Class ; rdfs:label "Order" .
s:Product a owl:Class ; rdfs:label "Product" ; skos:altLabel "SKU" .
s:Location a owl:Class ; rdfs:label "Location" ; skos:altLabel "origin", "destination" .
s:Lane a owl:Class ; rdfs:label "Lane" .
s:Stock a owl:Class ; rdfs:label "Stock" ;
    owl:hasKey ( s:stockedProduct s:bin ) .

s:orderedProduct a owl:ObjectProperty ; rdfs:label "orderedProduct" ;
    rdfs:domain s:Order ; rdfs:range s:Product .
s:stockedProduct a owl:ObjectProperty ; rdfs:label "stockedProduct" ; skos:altLabel "sku" ;
    rdfs:domain s:Stock ; rdfs:range s:Product .
s:bin a owl:DatatypeProperty ; rdfs:label "bin" ; rdfs:domain s:Stock ; rdfs:range xsd:string .
s:fromLocation a owl:ObjectProperty ; rdfs:label "fromLocation" ; skos:altLabel "origin" ;
    rdfs:domain s:Lane ; rdfs:range s:Location .
s:toLocation a owl:ObjectProperty ; rdfs:label "toLocation" ; skos:altLabel "destination" ;
    rdfs:domain s:Lane ; rdfs:range s:Location .
s:via a owl:ObjectProperty ; rdfs:label "via" ;
    rdfs:domain s:Lane ; rdfs:range s:Location .
s:units a owl:DatatypeProperty ; rdfs:label "units" ; rdfs:domain s:Order ; rdfs:range xsd:integer .
"""

PASSED = 0
TESTS = 0


def check(cond, msg):
    global PASSED
    assert cond, "FAIL: " + msg
    PASSED += 1


def test(fn):
    global TESTS
    TESTS += 1
    fn()
    print(f"  ok  {fn.__name__}")
    return fn


def _schema(ttl: str = TTL) -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".ttl", delete=False) as f:
        f.write(ttl)
        path = f.name
    client = RdfFileOntologyClient(GraphSource(
        graph_source_id="t", bu="t", display_name="t",
        ontology=OntologySource(type="rdf-file", file_path=path, file_format="turtle", namespace=S),
        backend=BackendSource(type="warehouse", registry_table="r"), llm_endpoint="none"))
    return {"classes": client.list_classes(), "properties": client.list_properties(),
            "relationships": client.list_relationships()}


def _col(name, lt=LogicalType.STRING, nullable=True):
    return ColumnMetadata(name, lt, nullable=nullable)


def _adapter(stock_rows=None) -> InMemoryDataAdapter:
    """No declared keys anywhere — identity must be measured or declared."""
    orders = TableMetadata(name="orders", columns=(
        _col("order_id", nullable=False), _col("sku"), _col("units", LogicalType.INTEGER)))
    lanes = TableMetadata(name="lanes", columns=(
        _col("lane_id", nullable=False), _col("origin"), _col("destination")))
    stock = TableMetadata(name="stock", columns=(_col("sku"), _col("bin")))
    return InMemoryDataAdapter(source_id="scm", tables=[
        InMemoryTable(orders, [
            {"order_id": "O1", "sku": "P-1", "units": 5},
            {"order_id": "O2", "sku": "P-1", "units": 3},
            {"order_id": "O3", "sku": "P-2", "units": 1},
        ]),
        InMemoryTable(lanes, [
            {"lane_id": "L1", "origin": "ATL", "destination": "SFO"},
            {"lane_id": "L2", "origin": "SFO", "destination": "NRT"},
        ]),
        InMemoryTable(stock, stock_rows if stock_rows is not None else [
            {"sku": "P-1", "bin": "A"}, {"sku": "P-1", "bin": "B"}, {"sku": "P-3", "bin": "A"},
        ]),
    ])


def _proposals(adapter=None, schema=None):
    adapter = adapter or _adapter()
    discovery = adapter.discover()
    props = gu.propose_mappings(discovery, schema or _schema())
    gu.enrich_classes_with_uniqueness(props, adapter, discovery)
    return props, adapter


def _build(profile="standard", adapter=None):
    props, adapter = _proposals(adapter)
    gu.auto_approve(props, policy=gu.approval_policy(profile))
    published = gu.publish_mappings("scm", props, strict=False)
    triples, result = gu.materialize_graph(published, adapter, build_id="t", strict=True,
                                           base_uri="http://r/")
    return props, triples, result


def _of(props, kind, label):
    return [p for p in props if p.kind == kind and p.ontology_label == label]


# --------------------------------------------------------------------------- #
@test
def test_acronyms_are_not_split_into_letters():
    check(_tokens("SKU") == {"sku"}, "SKU stays one token")
    check(_tokens("SKUCode") == {"sku", "code"}, "acronym then word")
    check(_tokens("siteName") == {"site", "name"}, "camelCase still splits")
    check(gu.name_similarity("SKU", "sku") == 1.0, "acronym synonym meets its column")


@test
def test_identifier_suffix_is_stripped_only_when_something_remains():
    check(_strip_identifier_suffix("warehouse_code") == "warehouse", "suffix stripped")
    check(_strip_identifier_suffix("id") == "id", "a bare id is left alone")
    check(_strip_identifier_suffix("origin") == "origin", "no suffix, unchanged")


@test
def test_a_class_with_no_table_is_proposed_from_column_values():
    props, _ = _proposals()
    product = _of(props, ProposalKind.VALUE_CLASS, "Product")
    check({(p.target_table, p.target_column) for p in product} == {("orders", "sku"), ("stock", "sku")},
          f"Product from both sku columns: {[(p.target_table, p.target_column) for p in product]}")
    check(not _of(props, ProposalKind.VALUE_CLASS, "Order"), "a class with a table is never a value entity")
    check(all(any(i.code == "inferred-identity" for i in p.validation_issues) for p in product),
          "value identity is flagged for review")


@test
def test_same_value_on_two_tables_is_one_entity():
    _, triples, result = _build()
    products = {s for (s, p, o) in triples if p == RDF_TYPE and o[1] == S + "Product"}
    check(products == {mint_value_iri("http://r/", S + "Product", v) for v in ("P-1", "P-2", "P-3")},
          f"one Product per distinct sku across tables: {sorted(products)}")
    check(result.sound and not result.has_conflation, "repeats are not conflation")


@test
def test_edges_to_value_entities_come_from_the_row_and_never_dangle():
    _, triples, result = _build()
    ordered = {(s, o[1]) for (s, p, o) in triples if p == S + "orderedProduct"}
    check(len(ordered) == 3, f"one edge per order: {ordered}")
    check(("http://r/orders/O3", mint_value_iri("http://r/", S + "Product", "P-2")) in ordered,
          "O3 -> P-2")
    check(result.dangling_edges == 0, "no edge points at an undefined entity")


@test
def test_two_candidate_columns_are_disambiguated_by_the_relationship_name():
    props, _ = _proposals()
    by_label = {p.ontology_label: p for p in props if p.kind == ProposalKind.RELATIONSHIP}
    check(by_label["fromLocation"].join.left_columns == ("origin",), "fromLocation -> origin")
    check(by_label["toLocation"].join.left_columns == ("destination",), "toLocation -> destination")
    via = by_label["via"]
    check(via.join is None and any(i.code == "value-reference-ambiguous" for i in via.validation_issues),
          "a relationship whose name picks neither column is blocked, not guessed")


@test
def test_haskey_on_non_key_shaped_columns_is_adopted_after_measurement():
    props, _ = _proposals()
    stock = next(p for p in _of(props, ProposalKind.CLASS, "Stock") if p.target_table == "stock")
    check(stock.key_candidate == ("sku", "bin"), f"hasKey resolved in declared order: {stock.key_candidate}")
    check(stock.subject_columns == ("sku", "bin"), "measured unique, so adopted")
    check(any(e.kind == "uniqueness-verified" and "owl:hasKey" in e.detail for e in stock.evidence),
          "the evidence says the key came from the ontology and was confirmed")


@test
def test_haskey_the_data_contradicts_is_not_adopted():
    dup = [{"sku": "P-1", "bin": "A"}, {"sku": "P-1", "bin": "A"}]
    props, _ = _proposals(_adapter(stock_rows=dup))
    stock = next(p for p in _of(props, ProposalKind.CLASS, "Stock") if p.target_table == "stock")
    check(stock.subject_columns == (), "a declared key that is not unique is never used")
    check(any(i.code == "haskey-not-unique" for i in stock.validation_issues), "and the reason is recorded")


@test
def test_gxp_strict_automates_no_inferred_identity():
    props, triples, _ = _build("gxp-strict")
    approved = {p.id for p in props if p.status == gu.ProposalStatus.APPROVED}
    for p in props:
        inferred = p.kind == ProposalKind.VALUE_CLASS or (p.join is not None and p.join.value_class)
        if inferred:
            check(p.id not in approved, f"gxp-strict must not automate {p.kind.value} {p.ontology_label}")
    check(not any(p == S + "orderedProduct" for (_, p, _) in triples), "so no value edges are built")


@test
def test_value_relationship_without_its_entities_is_refused_by_the_gate():
    props, adapter = _proposals()
    gu.auto_approve(props, policy=gu.approval_policy("standard"))
    for p in props:  # a reviewer rejects the Product value entities but not the edge
        if p.kind == ProposalKind.VALUE_CLASS and p.ontology_label == "Product":
            p.status = gu.ProposalStatus.REJECTED
    published = gu.publish_mappings("scm", props, strict=False)
    try:
        gu.materialize_graph(published, adapter, build_id="t", strict=True, base_uri="http://r/")
    except gu.MaterializationError as e:
        check("never typed" in str(e), f"dangling-edge gate names the problem: {e}")
    else:
        check(False, "edges to untyped value entities must refuse a strict build")


@test
def test_csv_directory_infers_types_declares_nothing_and_builds_the_same_graph():
    from graph_utility.csv_adapter import CsvDirectoryAdapter, infer_type

    check(infer_type(["1", "20", ""]) == LogicalType.INTEGER, "integers, empty is NULL")
    check(infer_type(["1.5", "2"]) == LogicalType.DECIMAL, "mixed int/decimal is DECIMAL")
    check(infer_type(["2026-11-02"]) == LogicalType.DATE, "ISO date")
    check(infer_type(["P-1", "7"]) == LogicalType.STRING, "anything else is STRING")
    d = tempfile.mkdtemp()
    for name, src in (("orders", _adapter()._tables["orders"]), ("lanes", _adapter()._tables["lanes"]),
                      ("stock", _adapter()._tables["stock"])):
        cols = [c.name for c in src.metadata.columns]
        with open(os.path.join(d, f"{name}.csv"), "w") as fh:
            fh.write(",".join(cols) + "\n")
            for r in src.rows:
                fh.write(",".join("" if r[c] is None else str(r[c]) for c in cols) + "\n")
    csv_adapter = CsvDirectoryAdapter.from_directory(d)
    disc = csv_adapter.discover()
    check(all(not t.keys for t in disc.tables) and not disc.joins, "a CSV declares no keys or joins")
    check(disc.table("orders").column("units").logical_type == LogicalType.INTEGER, "units inferred INTEGER")
    _, from_memory, _ = _build()
    _, from_csv, _ = _build(adapter=csv_adapter)
    check(from_csv == from_memory, "same ontology + same data via CSV = the same graph")


if __name__ == "__main__":
    print(f"\nALL DATASET-AGNOSTIC OFFLINE TESTS PASSED ({PASSED} assertions, {TESTS} tests)")
