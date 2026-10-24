"""Offline tests for vocabulary-aware matching, per-tenant approval profiles and
the Neo4j property-graph plan (docs/TAKEDA_BU_KG_DESIGN.md, items 2-4).

The fixture is a BU dataset written in BU vocabulary rather than the
ontology's: `subjects` / `subj_name` for the ontology's Patient / patientName,
and plural table names. Before this change every one of those deferred to a
human. The invariant under test does not move: nothing auto-approves without
measured evidence, and a GxP profile automates only on the term's own name.

Run: python3 tests/test_takeda_profiles_offline.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility as gu
from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
from graph_utility.discovery import (
    ColumnMetadata, JoinMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata,
)
from graph_utility.mapping import _singular, term_match
from graph_utility.neo4j_load import drop_build_cypher, plan_property_graph, rel_type
from graph_utility.ontology_file import RdfFileOntologyClient

EX = "http://example.org/takeda/core#"
TTL = f"""
@prefix ex:   <{EX}> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .

ex:Patient a owl:Class ; rdfs:label "Patient" ; skos:altLabel "Subject" .
ex:Supplier a owl:Class ; rdfs:label "Supplier" .
ex:Contract a owl:Class ; rdfs:label "Contract" .

ex:patientName a owl:DatatypeProperty ; rdfs:label "patientName" ;
    skos:altLabel "subj_name" ; rdfs:domain ex:Patient ; rdfs:range xsd:string .
ex:supplierName a owl:DatatypeProperty ; rdfs:label "supplierName" ;
    rdfs:domain ex:Supplier ; rdfs:range xsd:string .
ex:withSupplier a owl:ObjectProperty ; rdfs:label "withSupplier" ;
    rdfs:domain ex:Contract ; rdfs:range ex:Supplier .
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


def _schema() -> dict:
    with tempfile.NamedTemporaryFile("w", suffix=".ttl", delete=False) as f:
        f.write(TTL)
        path = f.name
    client = RdfFileOntologyClient(GraphSource(
        graph_source_id="t", bu="t", display_name="t",
        ontology=OntologySource(type="rdf-file", file_path=path, file_format="turtle", namespace=EX),
        backend=BackendSource(type="warehouse", registry_table="r"), llm_endpoint="none"))
    return {
        "classes": client.list_classes(),
        "properties": client.list_properties(),
        "relationships": client.list_relationships(),
    }


def _adapter() -> InMemoryDataAdapter:
    subjects = TableMetadata(
        name="subjects",
        columns=(ColumnMetadata("subj_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("subj_name", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("subj_id",), name="pk_subj"),),
    )
    suppliers = TableMetadata(
        name="suppliers",
        columns=(ColumnMetadata("supplier_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("supplier_name", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("supplier_id",), name="pk_sup"),),
    )
    contracts = TableMetadata(
        name="contracts",
        columns=(ColumnMetadata("contract_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("supplier_id", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("contract_id",), name="pk_con"),),
    )
    return InMemoryDataAdapter(
        source_id="bu-dataset",
        tables=[
            InMemoryTable(subjects, [{"subj_id": "P1", "subj_name": "Alpha"},
                                     {"subj_id": "P2", "subj_name": "Beta"}]),
            InMemoryTable(suppliers, [{"supplier_id": "S1", "supplier_name": "Acme"}]),
            InMemoryTable(contracts, [{"contract_id": "C1", "supplier_id": "S1"},
                                      {"contract_id": "C2", "supplier_id": "S1"}]),
        ],
        joins=[JoinMetadata("contracts", ("supplier_id",), "suppliers", ("supplier_id",),
                            origin="declared", name="fk_con_sup")],
    )


def _proposals():
    return gu.propose_mappings(_adapter().discover(), _schema())


def _find(proposals, label, table, column=None):
    return next(p for p in proposals
                if p.ontology_label == label and p.target_table == table
                and (column is None or p.target_column == column))


# --------------------------------------------------------------------------- #
# Normalisation and synonyms
# --------------------------------------------------------------------------- #
@test
def test_plurals_fold_symmetrically():
    for plural, singular in [("suppliers", "supplier"), ("studies", "study"),
                             ("batches", "batch"), ("boxes", "box")]:
        check(_singular(plural) == singular, f"{plural} -> {singular}")
    for word in ["status", "class", "analysis", "ids", "ae"]:
        check(_singular(word) == word, f"'{word}' must be left alone")
    check(gu.name_similarity("Supplier", "suppliers") == 1.0, "Supplier must meet suppliers")
    check(gu.name_similarity("siteName", "site_id") < 1.0, "siteName/site_id stays partial")


@test
def test_term_match_reports_how_it_matched():
    check(term_match(["Supplier"], [], "suppliers")[:2] == (1.0, "name"), "own name")
    check(term_match(["Patient"], ["Subject"], "subjects")[:2] == (1.0, "label"), "synonym")
    sim, via, _ = term_match(["Patient"], ["Subject"], "subject_visits")
    check(via is None and 0 < sim < 1, "a partial synonym overlap is not exact")


@test
def test_ontology_reader_returns_skos_synonyms():
    schema = _schema()
    patient = next(c for c in schema["classes"] if c["class"] == EX + "Patient")
    check(patient["synonyms"] == ["Subject"], f"altLabel read: {patient}")
    prop = next(p for p in schema["properties"] if p["property"] == EX + "patientName")
    check(prop["synonyms"] == ["subj_name"], "property altLabel read")


@test
def test_synonym_and_plural_matches_carry_distinct_evidence():
    props = _proposals()
    kinds = lambda p: {e.kind for e in p.evidence}
    check("label-exact" in kinds(_find(props, "Patient", "subjects")), "class via synonym")
    check("name-exact" not in kinds(_find(props, "Patient", "subjects")), "not claimed as own-name")
    check("name-exact" in kinds(_find(props, "Supplier", "suppliers")), "class via plural is own-name")
    check("label-exact" in kinds(_find(props, "patientName", "subjects", "subj_name")),
          "property via synonym")
    check("name-exact" in kinds(_find(props, "supplierName", "suppliers", "supplier_name")),
          "property via own name")


# --------------------------------------------------------------------------- #
# Profiles
# --------------------------------------------------------------------------- #
def _approved(profile):
    props = _proposals()
    result = gu.auto_approve(props, policy=gu.approval_policy(profile))
    approved = {(p.ontology_label, p.target_table, p.target_column) for p in props
                if p.id in set(result.approved)}
    return approved, result


@test
def test_standard_profile_automates_synonym_matches_with_hard_evidence():
    approved, _ = _approved("standard")
    for want in [("Patient", "subjects", None), ("patientName", "subjects", "subj_name"),
                 ("Supplier", "suppliers", None), ("supplierName", "suppliers", "supplier_name"),
                 ("Contract", "contracts", None), ("withSupplier", "suppliers", None)]:
        check(want in approved, f"standard should approve {want}; got {sorted(approved, key=str)}")


@test
def test_gxp_profile_defers_synonym_matches_and_says_why():
    approved, result = _approved("gxp-strict")
    check(("Patient", "subjects", None) not in approved, "GxP must not automate a synonym")
    check(("patientName", "subjects", "subj_name") not in approved, "nor a synonym property")
    check(("Supplier", "suppliers", None) in approved, "own-name matches still automate")
    reasons = " ".join(d["reason"] for d in result.deferred)
    check("ontology synonym" in reasons, f"deferral must name the reason: {reasons[:300]}")
    check(gu.approval_policy("gxp-strict").require_human_publish, "GxP publication needs a human")


@test
def test_no_profile_approves_name_only_evidence():
    for profile in gu.APPROVAL_PROFILES:
        props = _proposals()
        for p in props:
            p.evidence = [e for e in p.evidence if e.kind not in gu.HARD_EVIDENCE_KINDS]
        result = gu.auto_approve(props, policy=gu.approval_policy(profile))
        check(not result.approved, f"{profile} approved without measured evidence")


@test
def test_unknown_profile_fails_loudly():
    try:
        gu.approval_policy("lenient")
    except ValueError as e:
        check("unknown approval profile" in str(e), "message names the problem")
    else:
        check(False, "an unknown profile must not fall back silently")


@test
def test_descriptor_carries_tenant_and_validates_profile():
    base = dict(graph_source_id="rnd-clinical", bu="R&D", display_name="R&D clinical",
                ontology=OntologySource(type="rdf-file", file_path="x.ttl", namespace=EX),
                backend=BackendSource(type="warehouse", registry_table="r"),
                llm_endpoint="none")
    good = GraphSource(**base, tenant_id="fn-rnd", approval_profile="gxp-strict")
    check(not good.validate(), f"valid descriptor: {good.validate()}")
    round_trip = GraphSource.from_dict(good.to_dict())
    check(round_trip.tenant_id == "fn-rnd" and round_trip.approval_profile == "gxp-strict",
          "tenant and profile survive serialisation")
    bad = GraphSource(**base, approval_profile="yolo")
    check(any("approval_profile" in e for e in bad.validate()), "bad profile rejected")


# --------------------------------------------------------------------------- #
# Neo4j plan
# --------------------------------------------------------------------------- #
def _nquads():
    props = _proposals()
    gu.auto_approve(props, policy=gu.approval_policy("standard"))
    published = gu.publish_mappings("bu-dataset", props, strict=False)
    lines, _ = gu.materialize_to_nquads(published, _adapter(), build_id="t1",
                                        base_uri="http://example.org/r/", strict=False)
    return lines


@test
def test_plan_turns_types_literals_and_edges_into_a_property_graph():
    plan = plan_property_graph(_nquads())
    s = plan.summary()
    check(plan.build_id == "t1", "build id from the named graph")
    check(s["labels"] == {"Contract": 2, "Patient": 2, "Supplier": 1}, f"labels: {s['labels']}")
    check(s["relationship_types"] == {"WITH_SUPPLIER": 2}, f"edges: {s['relationship_types']}")
    check(s["skipped_dangling"] == 0 and not s["skipped_names"], "nothing skipped")
    check(s["prov_quads"] > 0, "provenance is summarised, not loaded as data")
    patient = next(n for n in plan.nodes.values() if "Patient" in n.labels and n.iri.endswith("P1"))
    check(patient.property_map().get("patientName") == "Alpha", "literal became a property")


@test
def test_plan_refuses_edges_to_untyped_subjects_and_protects_stamps():
    g = "urn:kg:build:t2"
    lines = [
        f'<http://x/a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <{EX}Patient> <{g}> .',
        f'<http://x/a> <{EX}knows> <http://x/ghost> <{g}> .',
        f'<http://x/a> <{EX}iri> "spoof" <{g}> .',
        f'<http://x/a> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <{EX}Bad-Label> <{g}> .',
    ]
    plan = plan_property_graph(lines)
    check(plan.skipped_dangling == 1, "edge to an untyped subject is refused")
    node = plan.nodes["http://x/a"]
    check("iri" not in node.props and node.props.get("p_iri") == ["spoof"], "stamp collision prefixed")
    check("label:Bad-Label" in plan.skipped_names, "non-identifier label skipped, not escaped")


@test
def test_rel_type_and_teardown_are_deterministic():
    check(rel_type(EX + "ledBy") == "LED_BY", "camel -> UPPER_SNAKE")
    check(rel_type(EX + "trial_site") == "TRIAL_SITE", "snake kept")
    check("DETACH DELETE" in drop_build_cypher("kgb-1") and "kgb-1" in drop_build_cypher("kgb-1"),
          "teardown is scoped to one build")


if __name__ == "__main__":
    print(f"\nALL TAKEDA PROFILE OFFLINE TESTS PASSED ({PASSED} assertions, {TESTS} tests)")
