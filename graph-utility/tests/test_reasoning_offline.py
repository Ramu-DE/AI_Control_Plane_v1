"""Offline tests for entailment and constraint validation.

Neptune has no OWL reasoner, so the ontology's axioms previously did no work.
These tests cover the rules that close that gap, and — just as importantly —
the things the reasoner must REFUSE to do:

  - no literal ever becomes a subject (an rdfs:range on a datatype property)
  - no owl:sameAs / equality closure
  - inferred triples are returned SEPARATELY from asserted ones
  - the fixpoint is capped, and a capped closure reports complete == False
  - constraining axioms (disjointWith, FunctionalProperty) produce FINDINGS,
    never triples

Run: python3 tests/test_reasoning_offline.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility as gu
from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
from fixtures_clinical import clinical_trial_adapter

ONTOLOGY_TTL = os.path.join(os.path.dirname(__file__), "fixtures", "clinical_ontology.ttl")
CT = "http://example.org/ontology/ct#"
TYPE = gu.RDF_TYPE

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


def _source() -> GraphSource:
    return GraphSource(
        graph_source_id="clinical-trials", bu="rnd",
        display_name="Clinical Trials (ontology-first)",
        ontology=OntologySource(type="rdf-file", file_path=ONTOLOGY_TTL, namespace=CT),
        backend=BackendSource(type="databricks-uc", catalog="c", schema="s",
                              registry_table="c.s.reg", universal_join_key="trial_id"),
        llm_endpoint="dummy",
    )


def _client():
    return gu.make_ontology_client(_source())


def _axioms() -> dict:
    return _client().list_axioms()


def iri(u):
    return gu.obj_iri(u)


# --------------------------------------------------------------------------- #
# 1. Reading axioms
# --------------------------------------------------------------------------- #
@test
def test_axioms_are_read_from_the_ontology():
    ax = _axioms()
    check((CT + "Trial", CT + "Study") in ax["sub_class_of"],
          "subClassOf must be read")
    check((CT + "siteName", CT + "name") in ax["sub_property_of"],
          "subPropertyOf must be read")
    check((CT + "hosts", CT + "atSite") in ax["inverse_of"]
          or (CT + "atSite", CT + "hosts") in ax["inverse_of"],
          "inverseOf must be read")
    check(CT + "partOfRegion" in ax["transitive"], "TransitiveProperty must be read")
    check(CT + "enrolledCount" in ax["functional"], "FunctionalProperty must be read")
    check(tuple(sorted((CT + "Trial", CT + "Site"))) in
          [tuple(p) for p in ax["disjoint_with"]], "disjointWith must be read")
    check((CT + "siteName", CT + "Site") in ax["domain"], "rdfs:domain must be read")


@test
def test_meta_vocabulary_is_not_redefined_by_axioms():
    ax = _axioms()
    for pair in ax["sub_class_of"] + ax["sub_property_of"]:
        check(not pair[0].startswith("http://www.w3.org/"),
              f"a W3C term must never be an axiom SUBJECT: {pair}")


# --------------------------------------------------------------------------- #
# 2. Generating rules
# --------------------------------------------------------------------------- #
@test
def test_subclass_entailment():
    asserted = {(f"{CT}x1", TYPE, iri(CT + "Trial"))}
    inferred, report = gu.entail(asserted, _axioms())
    check((f"{CT}x1", TYPE, iri(CT + "Study")) in inferred,
          "an instance of Trial must be inferred to be a Study")
    check(report.complete, "this closure is small and must finish")
    check(report.by_rule.get("rdfs9-subClassOf", 0) >= 1, "the rule must be credited")


@test
def test_subproperty_entailment():
    asserted = {(f"{CT}s1", CT + "siteName", gu.obj_literal('"North"'))}
    inferred, _ = gu.entail(asserted, _axioms())
    check((f"{CT}s1", CT + "name", gu.obj_literal('"North"')) in inferred,
          "siteName must imply the broader name property")


@test
def test_inverse_entailment():
    asserted = {(f"{CT}ts1", CT + "atSite", iri(f"{CT}site1"))}
    inferred, _ = gu.entail(asserted, _axioms())
    check((f"{CT}site1", CT + "hosts", iri(f"{CT}ts1")) in inferred,
          "the inverse edge must be inferred in the other direction")


@test
def test_domain_and_range_entailment():
    # domain: using siteName types the SUBJECT as a Site.
    asserted = {(f"{CT}s9", CT + "siteName", gu.obj_literal('"Clinic"'))}
    inferred, _ = gu.entail(asserted, _axioms())
    check((f"{CT}s9", TYPE, iri(CT + "Site")) in inferred,
          "rdfs:domain must type the subject")
    # range: atSite points at a Site, so the OBJECT is typed.
    asserted = {(f"{CT}ts9", CT + "atSite", iri(f"{CT}s10"))}
    inferred, _ = gu.entail(asserted, _axioms())
    check((f"{CT}s10", TYPE, iri(CT + "Site")) in inferred,
          "rdfs:range must type the object when it is a resource")


@test
def test_a_literal_is_never_made_a_subject():
    """rdfs:range on a datatype property must not produce malformed RDF.

    `ct:siteName rdfs:range xsd:string` plus `<s> ct:siteName "North"` would
    naively yield `"North" a xsd:string` — a literal in the subject position,
    which is not legal RDF. It must be skipped and counted.
    """
    asserted = {(f"{CT}s1", CT + "siteName", gu.obj_literal('"North"'))}
    inferred, report = gu.entail(asserted, _axioms())
    for s, p, o in inferred:
        check(not s.startswith('"'), f"a literal reached the subject position: {s}")
    check(report.skipped_literal_range >= 1,
          "the skip must be counted, not silently dropped")


@test
def test_transitive_closure():
    ax = _axioms()
    asserted = {
        (f"{CT}a", CT + "partOfRegion", iri(f"{CT}b")),
        (f"{CT}b", CT + "partOfRegion", iri(f"{CT}c")),
        (f"{CT}c", CT + "partOfRegion", iri(f"{CT}d")),
    }
    inferred, report = gu.entail(asserted, ax)
    for pair in (("a", "c"), ("a", "d"), ("b", "d")):
        check((f"{CT}{pair[0]}", CT + "partOfRegion", iri(f"{CT}{pair[1]}")) in inferred,
              f"transitive closure must include {pair}")
    check(report.complete, "a 3-hop chain must close within the iteration cap")


@test
def test_rules_compose_across_iterations():
    """An inferred triple must be able to trigger another rule.

    atSite -> (inverse) hosts, and separately Trial -> Study. Here the chain is
    domain/range producing a type, which subClassOf then lifts: a one-pass
    reasoner would miss the second step.
    """
    asserted = {(f"{CT}t1", TYPE, iri(CT + "Trial"))}
    inferred, report = gu.entail(asserted, _axioms())
    check((f"{CT}t1", TYPE, iri(CT + "Study")) in inferred, "first step")
    # trialTitle has domain Trial; using it should type then lift to Study.
    asserted2 = {(f"{CT}t2", CT + "trialTitle", gu.obj_literal('"X"'))}
    inferred2, _ = gu.entail(asserted2, _axioms())
    check((f"{CT}t2", TYPE, iri(CT + "Trial")) in inferred2, "domain typed it")
    check((f"{CT}t2", TYPE, iri(CT + "Study")) in inferred2,
          "and subClassOf lifted the inferred type — rules must compose")


@test
def test_inferred_never_includes_what_was_asserted():
    asserted = {
        (f"{CT}t1", TYPE, iri(CT + "Trial")),
        (f"{CT}t1", TYPE, iri(CT + "Study")),   # already stated
    }
    inferred, _ = gu.entail(asserted, _axioms())
    for t in inferred:
        check(t not in asserted,
              "an asserted triple must never be returned as inferred")
    check((f"{CT}t1", TYPE, iri(CT + "Study")) not in inferred,
          "the already-asserted superclass type must not be duplicated")


@test
def test_no_equality_closure():
    """owl:sameAs is deliberately unsupported; it must not be acted on.

    Merging identities is dangerous here because subject IRIs are minted from
    keys: one bad mapping would silently fuse two real entities.
    """
    ax = _axioms()
    asserted = {
        (f"{CT}a", "http://www.w3.org/2002/07/owl#sameAs", iri(f"{CT}b")),
        (f"{CT}a", CT + "siteName", gu.obj_literal('"One"')),
    }
    inferred, _ = gu.entail(asserted, ax)
    check(not any(s == f"{CT}b" and p == CT + "siteName" for s, p, o in inferred),
          "properties must NOT be copied across a sameAs link")


# --------------------------------------------------------------------------- #
# 3. Bounds
# --------------------------------------------------------------------------- #
@test
def test_fixpoint_caps_are_reported_not_hidden():
    ax = _axioms()
    # A long chain needs more passes than we allow, so the closure is partial.
    chain = {(f"{CT}n{i}", CT + "partOfRegion", iri(f"{CT}n{i+1}"))
             for i in range(40)}
    _, report = gu.entail(chain, ax, max_iterations=2)
    check(report.hit_iteration_cap, "the iteration cap must be recorded")
    check(not report.complete, "a capped closure must NOT claim to be complete")
    # The inferred cap is likewise explicit.
    inferred, report2 = gu.entail(chain, ax, max_inferred=5)
    check(report2.hit_inferred_cap, "the inferred cap must be recorded")
    check(len(inferred) <= 5, "the cap must actually bound the output")
    check(not report2.complete, "and the result must not claim completeness")


@test
def test_empty_inputs_are_safe():
    inferred, report = gu.entail(set(), _axioms())
    check(inferred == set(), "no data means nothing inferred")
    check(report.complete, "and that is a complete result")
    inferred2, _ = gu.entail({(f"{CT}x", TYPE, iri(CT + "Trial"))}, {})
    check(inferred2 == set(), "no axioms means nothing inferred")


@test
def test_entailment_is_deterministic():
    asserted = {
        (f"{CT}t1", TYPE, iri(CT + "Trial")),
        (f"{CT}ts1", CT + "atSite", iri(f"{CT}s1")),
    }
    a, _ = gu.entail(asserted, _axioms())
    b, _ = gu.entail(asserted, _axioms())
    check(a == b, "the same inputs must infer the same triples")
    graph = "urn:kg:build:x:inferred"
    check(gu.serialize_quads(a, graph) == gu.serialize_quads(b, graph),
          "and serialize identically")


# --------------------------------------------------------------------------- #
# 4. Constraining axioms -> findings, not triples
# --------------------------------------------------------------------------- #
@test
def test_disjoint_classes_are_reported_as_a_violation():
    ax = _axioms()
    bad = {
        (f"{CT}thing1", TYPE, iri(CT + "Trial")),
        (f"{CT}thing1", TYPE, iri(CT + "Site")),
    }
    inferred, _ = gu.entail(bad, ax)
    # Entailment must NOT try to resolve the contradiction.
    check(not any(p == TYPE and o[1] == CT + "Site" for s, p, o in inferred
                  if s == f"{CT}thing1"),
          "a disjointness breach is not something to reason over")
    violations = gu.validate_constraints(bad, ax, inferred=inferred)
    codes = {v.code for v in violations}
    check("disjoint-classes" in codes, "the breach must be reported")
    v = next(v for v in violations if v.code == "disjoint-classes")
    check(v.subject == f"{CT}thing1", "the violation must name the subject")
    check("disjoint" in v.message, "and explain itself")


@test
def test_disjointness_is_caught_only_after_entailment():
    """The usual real case: the conflicting types are not both asserted.

    `<x> a ct:Trial` is asserted; `a ct:Site` arrives from rdfs:domain on a
    wrongly-mapped siteName. Validation must see the inferred type, which is
    why it takes the inferred set as well.
    """
    ax = _axioms()
    asserted = {
        (f"{CT}x", TYPE, iri(CT + "Trial")),
        (f"{CT}x", CT + "siteName", gu.obj_literal('"Oops"')),   # mis-mapped
    }
    without = gu.validate_constraints(asserted, ax)
    check(not any(v.code == "disjoint-classes" for v in without),
          "asserted triples alone do not reveal it")
    inferred, _ = gu.entail(asserted, ax)
    with_inferred = gu.validate_constraints(asserted, ax, inferred=inferred)
    check(any(v.code == "disjoint-classes" for v in with_inferred),
          "entailment is what exposes the mapping error")


@test
def test_functional_property_violation_is_reported():
    # The realistic cause: two columns mapped to one functional property.
    ax = _axioms()
    bad = {
        (f"{CT}ts1", CT + "enrolledCount", gu.obj_literal('"40"')),
        (f"{CT}ts1", CT + "enrolledCount", gu.obj_literal('"35"')),
    }
    violations = gu.validate_constraints(bad, ax)
    check(any(v.code == "functional-property-violated" for v in violations),
          "two values for a functional property must be reported")
    ok = {(f"{CT}ts2", CT + "enrolledCount", gu.obj_literal('"40"'))}
    check(not gu.validate_constraints(ok, ax),
          "a single value must produce no finding")


@test
def test_validation_output_is_sorted_and_serialisable():
    ax = _axioms()
    bad = {
        (f"{CT}b", TYPE, iri(CT + "Trial")), (f"{CT}b", TYPE, iri(CT + "Site")),
        (f"{CT}a", TYPE, iri(CT + "Trial")), (f"{CT}a", TYPE, iri(CT + "Site")),
    }
    violations = gu.validate_constraints(bad, ax)
    subjects = [v.subject for v in violations if v.code == "disjoint-classes"]
    check(subjects == sorted(subjects), "findings must be deterministically ordered")
    for v in violations:
        d = v.to_dict()
        check(set(d) == {"code", "subject", "message", "severity"},
              "a finding must serialise for a report")


# --------------------------------------------------------------------------- #
# 5. Through the real pipeline
# --------------------------------------------------------------------------- #
def _built():
    adapter = clinical_trial_adapter()
    schema_client = _client()
    schema = {
        "classes": schema_client.list_classes(),
        "properties": schema_client.list_properties(),
        "relationships": schema_client.list_relationships(),
    }
    proposals = gu.propose_mappings(adapter.discover(), schema)
    gu.auto_approve(proposals)
    for p in proposals:
        if p.kind == gu.ProposalKind.RELATIONSHIP and p.is_approvable \
                and p.status == gu.ProposalStatus.PROPOSED:
            gu.approve(p, "tester", "relationship reviewed in reasoning test")
    published = gu.publish_mappings("clinical-trials", proposals, strict=False)
    triples, result = gu.materialize_graph(
        published, adapter, build_id="reason01",
        base_uri="http://example.org/resource/", strict=False)
    return triples, result, _axioms()


@test
def test_entailment_adds_real_knowledge_to_a_built_graph():
    triples, result, ax = _built()
    inferred, report = gu.entail(triples, ax)
    check(report.complete, "the demo closure must finish")
    check(inferred, "entailment must add something to a real built graph")

    # Counts are derived from the asserted data, not hardcoded, so the test
    # states the RULE rather than the fixture's current row count.
    asserted_trials = {s for s, p, o in triples if p == TYPE and o[1] == CT + "Trial"}
    asserted_named = {s for s, p, o in triples
                      if p in (CT + "siteName", CT + "investigatorName")}
    asserted_at_site = [(s, o[1]) for s, p, o in triples if p == CT + "atSite"]
    check(asserted_trials and asserted_named and asserted_at_site,
          "the fixture must actually exercise all three rules")

    # Trial instances become Studies — a class with no table behind it.
    studies = {s for s, p, o in inferred if p == TYPE and o[1] == CT + "Study"}
    check(studies == asserted_trials,
          f"every asserted Trial must become a Study: {len(studies)} vs "
          f"{len(asserted_trials)}")
    check(not any(p == TYPE and o[1] == CT + "Study" for s, p, o in triples),
          "no Study type was asserted, so this is genuinely new knowledge")

    # siteName/investigatorName roll up into the broader ct:name.
    names = {s for s, p, o in inferred if p == CT + "name"}
    check(names == asserted_named,
          f"every named resource must gain ct:name: {len(names)} vs {len(asserted_named)}")

    # The inverse of atSite exists only by inference.
    hosts = [(s, o[1]) for s, p, o in inferred if p == CT + "hosts"]
    check(len(hosts) == len(asserted_at_site),
          f"each atSite edge must yield one hosts edge: {len(hosts)} vs "
          f"{len(asserted_at_site)}")
    check({(o, s) for s, o in hosts} == set(asserted_at_site),
          "and each inverse must be exactly the reverse of an asserted edge")
    for s, o in hosts:
        check("/site/" in s and "/trial_site/" in o,
              f"the inverse must point site -> trial_site, got {s} -> {o}")


@test
def test_a_correct_mapping_produces_no_violations():
    triples, _, ax = _built()
    inferred, _ = gu.entail(triples, ax)
    violations = gu.validate_constraints(triples, ax, inferred=inferred)
    check(violations == [],
          f"a correct mapping must breach no constraint, got {[v.code for v in violations]}")


@test
def test_inferred_triples_go_to_their_own_named_graph():
    triples, result, ax = _built()
    inferred, _ = gu.entail(triples, ax)
    data_lines = gu.serialize_quads(triples, result.graph_uri)
    inferred_lines = gu.serialize_quads(inferred, f"{result.graph_uri}:inferred")
    check(all(ln.endswith(f"<{result.graph_uri}> .") for ln in data_lines),
          "asserted quads carry the data graph")
    check(all(ln.endswith(f"<{result.graph_uri}:inferred> .") for ln in inferred_lines),
          "inferred quads carry the :inferred graph, so the two never mix")
    check(not set(data_lines) & set(inferred_lines),
          "no line may appear in both graphs")


if __name__ == "__main__":
    print(f"\nALL REASONING OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
