"""Offline tests for the mapping-method comparison and the OntoBricks option.

Three things are being protected here.

1. THE COMPARISON MUST BE FAIR. Both arms run the same proposer and the same
   approval policy; only the measurement differs. If a future change lets the
   arms diverge some other way, the headline numbers stop meaning what they
   claim, so the ablation itself is asserted.

2. THE SCORING MUST NOT FLATTER EITHER ARM. A deferral is not a success and a
   confidently wrong mapping is not a near miss. `precision` of a cautious arm
   that approved nothing is None, not 0% — reporting 0% would make the safest
   possible behaviour look like the worst.

3. THE HANDOFF MUST BE REAL R2RML. An artifact another system parses has to be
   syntactically valid and has to carry the predicate on every join, which the
   older dict emitter did not.

Also covers the declared-join bug this comparison surfaced: `_candidate_join`
read only `table.keys` and ignored `DiscoveryResult.joins`, so an adapter that
declares its foreign keys only in `joins` lost them, and a relationship that
the catalog had already described was blocked with `no-key-evidence`.

Run: python3 tests/test_compare_offline.py
"""
from __future__ import annotations

import os
import sys
from dataclasses import replace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from fixtures_contractiq import (
    CONTRACTIQ_TRUTH,
    NS,
    contractiq_adapter,
    contractiq_ontology,
)
from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.discovery import (
    ColumnMetadata,
    JoinMetadata,
    KeyMetadata,
    KeyType,
    LogicalType,
    TableMetadata,
)
from graph_utility.compare import (
    ARM_MEASURED,
    ARM_METADATA,
    ArmResult,
    compare,
    score_arm,
)
from graph_utility.mapping import (
    ProposalKind,
    ProposalStatus,
    R2RMLError,
    auto_approve,
    propose_mappings,
    publish_mappings,
)
from graph_utility.ontobricks import (
    NEO4J,
    NEPTUNE,
    ONTOBRICKS,
    TARGETS,
    target_capabilities,
    to_r2rml_turtle,
)
from graph_utility.overlap import (
    enrich_classes_with_uniqueness,
    enrich_relationships_with_overlap,
)

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


def _comparison():
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    return compare(discovery, contractiq_ontology(), adapter, CONTRACTIQ_TRUTH)


def _published():
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    proposals = propose_mappings(discovery, contractiq_ontology())
    enrich_classes_with_uniqueness(proposals, adapter, discovery)
    enrich_relationships_with_overlap(proposals, adapter, discovery)
    auto_approve(proposals)
    return publish_mappings("contract-iq", proposals, strict=False)


# --------------------------------------------------------------------------- #
# The comparison
# --------------------------------------------------------------------------- #
@test
def both_arms_see_identical_inputs():
    """The ablation: same proposer, same policy, only measurement differs."""
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    ontology = contractiq_ontology()
    a = propose_mappings(discovery, ontology, id_prefix="x")
    b = propose_mappings(discovery, ontology, id_prefix="y")
    check(len(a) == len(b), "the proposer must be deterministic across arms")
    check(
        [(p.kind, p.ontology_uri, p.target_table, p.target_column) for p in a]
        == [(p.kind, p.ontology_uri, p.target_table, p.target_column) for p in b],
        "both arms must start from the same candidate set, or the comparison "
        "measures two different things",
    )


@test
def measurement_raises_recall_without_costing_precision():
    c = _comparison()
    check(c.metadata.precision == 1.0,
          f"metadata arm precision must be 1.0, got {c.metadata.precision}")
    check(c.measured.precision == 1.0,
          f"measured arm precision must be 1.0, got {c.measured.precision}")
    check(c.measured.recall > c.metadata.recall,
          f"measurement must raise recall ({c.measured.recall} vs "
          f"{c.metadata.recall})")
    check(c.measured.recall == 1.0,
          f"the measured arm must reach every truth term, got {c.measured.recall}")


@test
def neither_arm_publishes_a_wrong_mapping():
    """The headline is about recall, NOT about preventing errors.

    Both arms are fail-closed, so on this fixture neither approves anything
    incorrect. Asserting it keeps the claim honest: if a change ever lets an
    arm approve a wrong mapping, this test says so instead of the report
    quietly shifting to a different story.
    """
    c = _comparison()
    check(not c.metadata.approved_wrong,
          f"metadata arm must defer rather than guess, got "
          f"{c.metadata.approved_wrong}")
    check(not c.measured.approved_wrong,
          f"measured arm approved something wrong: {c.measured.approved_wrong}")


@test
def the_gap_is_exactly_the_cases_that_need_data():
    c = _comparison()
    missed = {m["ontology_uri"] for m in c.metadata.missed}
    check(missed == {
        NS + "Site",                        # T1 undeclared but unique key
        NS + "ContractTherapeuticArea",     # T2 composite key
        NS + "deliveredAtSite",             # T3 ambiguous parent
        NS + "coversArea",                  # T2 junction edge
    }, f"metadata arm must miss exactly the data-dependent cases, got {missed}")
    traps = {m["trap"] for m in c.metadata.missed}
    check(traps == {"T1", "T2", "T3"},
          f"and only traps T1-T3, got {traps}")


@test
def measured_arm_finds_the_composite_key_not_the_single_column():
    """T2. A single-column key here would silently collapse rows."""
    c = _comparison()
    hit = [m for m in c.measured.approved_correct
           if m["ontology_uri"] == NS + "ContractTherapeuticArea"]
    check(len(hit) == 1, "the junction class must be approved exactly once")
    check("contract_id" in hit[0]["detail"] and "ta_code" in hit[0]["detail"],
          f"the subject key must be the composite, got {hit[0]['detail']}")
    check("uniqueness-verified" in hit[0]["evidence"],
          "and it must be justified by measurement, not by name shape")


@test
def measured_arm_picks_the_real_parent_over_the_decoy():
    """T3. `site` and `site_archive` are indistinguishable by name."""
    c = _comparison()
    hit = [m for m in c.measured.approved_correct
           if m["ontology_uri"] == NS + "deliveredAtSite"]
    check(len(hit) == 1, "the site relationship must be approved")
    check("site_archive" not in hit[0]["detail"],
          f"the decoy table must not win, got {hit[0]['detail']}")
    check("value-overlap" in hit[0]["evidence"],
          "and containment must be the reason it was chosen")


@test
def declared_cases_succeed_in_both_arms():
    """T4/T5 are controls: a baseline that can never win is not a baseline."""
    c = _comparison()
    for arm_name, res in (("metadata", c.metadata), ("measured", c.measured)):
        traps = {m["trap"] for m in res.approved_correct}
        check("T4" in traps and "T5" in traps,
              f"{arm_name} arm must get the declared and plain-name cases, "
              f"got {traps}")


@test
def measurement_does_not_re_probe_a_declared_join():
    """A probe spent rediscovering a declared FK is a wasted query."""
    c = _comparison()
    probes = c.measured.measurements["profile_queries"]
    check(probes > 0, "the measured arm must actually measure something")
    # One probe per undeclared case, not per relationship in the ontology.
    check(probes < 15,
          f"declared evidence must short-circuit profiling, took {probes} probes")


# --------------------------------------------------------------------------- #
# Scoring honesty
# --------------------------------------------------------------------------- #
@test
def an_arm_that_approves_nothing_has_undefined_precision():
    res = ArmResult(arm="empty")
    check(res.precision is None,
          "0/0 is not 0% precision; reporting 0 would punish caution")
    check(res.recall is None, "and recall is equally undefined")


@test
def deferrals_are_not_credited_as_answers():
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    proposals = propose_mappings(discovery, contractiq_ontology())
    # Nothing approved at all.
    res = score_arm("none-approved", proposals, CONTRACTIQ_TRUTH)
    check(res.approved == 0, "no proposal was approved")
    check(not res.approved_correct,
          "a PROPOSED mapping must never count as the machine's answer")
    check(len(res.missed) == len(CONTRACTIQ_TRUTH),
          "every truth term must be reported as missed")


@test
def a_confidently_wrong_mapping_scores_worse_than_a_deferral():
    """Scoring is against truth, never against the arm's own confidence."""
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    proposals = propose_mappings(discovery, contractiq_ontology())
    target = next(p for p in proposals
                  if p.kind == ProposalKind.DIRECT
                  and p.ontology_uri == NS + "siteName")
    target.target_column = "site_id"          # the classic wrong answer
    target.confidence = 0.99                  # asserted loudly
    target.status = ProposalStatus.APPROVED
    res = score_arm("tampered", proposals, CONTRACTIQ_TRUTH)
    check(len(res.approved_wrong) == 1,
          f"the wrong mapping must be counted wrong, got {res.approved_wrong}")
    check(res.precision == 0.0,
          f"and precision must reflect it, got {res.precision}")
    check("site_id" in res.approved_wrong[0]["detail"],
          "the report must say what it actually answered")


@test
def by_trap_is_order_independent():
    """It reports counts, because a single label depended on dict order."""
    c = _comparison()
    traps = c.by_trap()
    for trap, arms in traps.items():
        for arm, counts in arms.items():
            check(set(counts) == {"correct", "wrong", "missed"},
                  f"{trap}/{arm} must report all three buckets, got {counts}")
    t4 = traps["T4"]["metadata"]
    check(t4["correct"] == 4 and t4["missed"] == 0,
          f"T4 is a control and must be fully correct, got {t4}")


@test
def an_unknown_truth_kind_raises_rather_than_passing():
    adapter = contractiq_adapter()
    discovery = adapter.discover()
    proposals = propose_mappings(discovery, contractiq_ontology())
    p = next(x for x in proposals if x.ontology_uri == NS + "status")
    p.status = ProposalStatus.APPROVED
    try:
        score_arm("bad-truth", proposals, {NS + "status": {"kind": "nonsense"}})
    except ValueError as e:
        check("nonsense" in str(e), f"the message must name the bad kind: {e}")
        return
    check(False, "a malformed ground truth must not score as a silent pass")


# --------------------------------------------------------------------------- #
# The declared-join bug the comparison surfaced
# --------------------------------------------------------------------------- #
def _two_table_adapter(joins):
    left = InMemoryTable(
        metadata=TableMetadata(
            name="contract",
            columns=(ColumnMetadata("contract_id", LogicalType.STRING, nullable=False),
                     ColumnMetadata("supplier_id", LogicalType.STRING)),
            keys=(KeyMetadata(KeyType.PRIMARY, ("contract_id",)),),
        ),
        rows=[{"contract_id": "C-1", "supplier_id": "S-1"}],
    )
    right = InMemoryTable(
        metadata=TableMetadata(
            name="supplier",
            columns=(ColumnMetadata("supplier_id", LogicalType.STRING, nullable=False),),
            keys=(KeyMetadata(KeyType.PRIMARY, ("supplier_id",)),),
        ),
        rows=[{"supplier_id": "S-1"}],
    )
    return InMemoryDataAdapter(source_id="t", tables=[left, right], joins=joins)


def _rel_ontology():
    return {
        "classes": [{"class": NS + "Contract", "label": "Contract"},
                    {"class": NS + "Supplier", "label": "Supplier"}],
        "properties": [],
        "relationships": [{"property": NS + "hasSupplier", "label": "Supplier",
                           "domain": NS + "Contract", "range": NS + "Supplier"}],
    }


@test
def a_join_declared_only_in_discovery_joins_is_honoured():
    """The bug: `joins` was part of the contract and simply never read."""
    adapter = _two_table_adapter([
        JoinMetadata("contract", ("supplier_id",), "supplier", ("supplier_id",),
                     cardinality="many-to-one", origin="declared", name="fk1"),
    ])
    discovery = adapter.discover()
    rel = next(p for p in propose_mappings(discovery, _rel_ontology())
               if p.kind == ProposalKind.RELATIONSHIP)
    check(rel.join is not None,
          "a declared join must produce a candidate join, not no-key-evidence")
    check(rel.join.left_columns == ("supplier_id",)
          and rel.join.right_columns == ("supplier_id",),
          f"with the declared columns, got {rel.join}")
    codes = {i.code for i in rel.validation_issues}
    check("no-key-evidence" not in codes,
          f"and must not be blocked, got issues {codes}")


@test
def a_reversed_declared_join_is_oriented_to_the_relationship():
    """Swapping the columns matters: otherwise the join reads backwards."""
    adapter = _two_table_adapter([
        # Declared supplier -> contract; the ontology asks contract -> supplier.
        JoinMetadata("supplier", ("supplier_id",), "contract", ("supplier_id",),
                     cardinality="many-to-one", origin="declared", name="fk2"),
    ])
    discovery = adapter.discover()
    rel = next(p for p in propose_mappings(discovery, _rel_ontology())
               if p.kind == ProposalKind.RELATIONSHIP)
    check(rel.join is not None, "the reversed declaration must still resolve")
    check(rel.join.left_table == "contract" and rel.join.right_table == "supplier",
          f"oriented to the ontology, got {rel.join.left_table} -> "
          f"{rel.join.right_table}")


@test
def no_declared_join_still_means_no_key_evidence():
    """The fix must not become a way to invent a join."""
    adapter = _two_table_adapter([])
    discovery = adapter.discover()
    rel = next(p for p in propose_mappings(discovery, _rel_ontology())
               if p.kind == ProposalKind.RELATIONSHIP)
    check(rel.join is None, "with nothing declared there is no candidate join")
    check("no-key-evidence" in {i.code for i in rel.validation_issues},
          "and the proposal must stay blocked")


# --------------------------------------------------------------------------- #
# Graph target capabilities
# --------------------------------------------------------------------------- #
@test
def capabilities_record_what_each_target_cannot_do():
    needs = ["property_paths", "aggregation", "numeric_filters", "named_graphs"]
    check(ONTOBRICKS.unsupported_for(needs) == needs,
          "OntoBricks serves none of the expressive-query needs")
    check(NEPTUNE.unsupported_for(needs) == [],
          "Neptune serves all of them")
    check(NEO4J.unsupported_for(["property_paths", "aggregation"]) == [],
          "Neo4j traverses and aggregates natively")
    check(NEO4J.unsupported_for(["named_graphs"]) == ["named_graphs"],
          "but a property graph has no quad")


@test
def only_ontobricks_has_a_reasoning_ceiling():
    check(ONTOBRICKS.reasoning_triple_ceiling == 50_000,
          "owlrl is in-memory and self-documents the limit")
    check(NEPTUNE.reasoning_triple_ceiling is None,
          "Neptune has no reasoner to exceed — entailment is materialised first")


@test
def an_unknown_capability_raises_instead_of_passing():
    try:
        ONTOBRICKS.unsupported_for(["sparql_11"])      # typo for sparql_1_1
    except ValueError as e:
        check("sparql_11" in str(e), f"the message must name the typo: {e}")
        check("sparql_1_1" in str(e), "and list the real field names")
        return
    check(False, "a mistyped capability must not silently report 'supported'")


@test
def an_unknown_target_lists_the_real_options():
    check(set(TARGETS) == {"ontobricks", "neptune", "neo4j"},
          f"targets must be the three real options, got {sorted(TARGETS)}")
    try:
        target_capabilities("tigergraph")
    except ValueError as e:
        check("ontobricks" in str(e), f"the message must list options: {e}")
        return
    check(False, "an unknown target must raise")


# --------------------------------------------------------------------------- #
# The R2RML handoff
# --------------------------------------------------------------------------- #
@test
def turtle_carries_a_predicate_on_every_join():
    """The gap in the dict emitter: refObjectMaps had no predicate at all."""
    doc = to_r2rml_turtle(_published(), strict=False)
    check(doc.ref_object_maps == 3,
          f"all three relationships must emit a ref object map, got "
          f"{doc.ref_object_maps}")
    check(doc.turtle.count("rr:parentTriplesMap") == doc.ref_object_maps,
          "each with a parent triples map")
    # Every parentTriplesMap must sit inside a block that names a predicate.
    for chunk in doc.turtle.split("rr:predicateObjectMap")[1:]:
        if "rr:parentTriplesMap" in chunk:
            check("rr:predicate " in chunk,
                  "a join without its predicate cannot say which edge it is")


@test
def the_t3_resolution_survives_into_the_artifact():
    doc = to_r2rml_turtle(_published(), strict=False)
    check("TriplesMap_site>" in doc.turtle or "TriplesMap_site " in doc.turtle,
          "the real site map must be referenced")
    # The decoy must not appear as a join parent anywhere.
    for chunk in doc.turtle.split("rr:parentTriplesMap")[1:]:
        head = chunk.split("\n")[0]
        check("site_archive" not in head,
              f"the decoy must never become a join parent, got {head}")


@test
def turtle_is_well_formed_rdf():
    """Parsed with a real parser when one is available, not eyeballed."""
    doc = to_r2rml_turtle(_published(), strict=False)
    try:
        import rdflib
    except ImportError:
        print("      (skipped: rdflib not installed)")
        return
    g = rdflib.Graph()
    g.parse(data=doc.turtle, format="turtle")
    RR = rdflib.Namespace("http://www.w3.org/ns/r2rml#")
    maps = set(g.subjects(RR.logicalTable, None))
    check(len(maps) == doc.triples_maps,
          f"parsed {len(maps)} triples maps, emitted {doc.triples_maps}")
    check(len(list(g.triples((None, RR.joinCondition, None)))) == doc.ref_object_maps,
          "every ref object map must carry a join condition")


@test
def a_table_without_a_keyed_class_fails_closed():
    """No fabricated surrogate key, in Turtle as in the dict emitter."""
    published = _published()
    # Drop the class mapping and keep its direct mappings.
    victim = next(m for m in published.mappings
                  if m.kind == ProposalKind.CLASS.value
                  and m.target_table == "contract")
    published.mappings.remove(victim)
    try:
        to_r2rml_turtle(published, strict=True)
    except R2RMLError as e:
        check("contract" in str(e), f"the message must name the table: {e}")
    else:
        check(False, "strict mode must refuse an unkeyed table")

    lenient = to_r2rml_turtle(published, strict=False)
    check(not lenient.complete, "and lenient mode must report incompleteness")
    check(any(o["code"] == "no-published-class-key" for o in lenient.omissions),
          f"with the reason recorded, got {lenient.omissions}")
    check("TriplesMap_contract>" not in lenient.turtle,
          "the unkeyed table must be omitted, not emitted half-mapped")


@test
def an_unserializable_iri_is_refused():
    """A mapping another system parses must not be silently corrupted."""
    published = _published()
    idx = next(i for i, m in enumerate(published.mappings)
               if m.kind == ProposalKind.DIRECT.value)
    # PublishedMapping is frozen, which is the right call for an artifact —
    # replace instead of mutating.
    published.mappings[idx] = replace(
        published.mappings[idx],
        ontology_uri="http://example.org/ont#has space")
    try:
        to_r2rml_turtle(published, strict=False)
    except R2RMLError as e:
        check("space" in str(e) or "IRIREF" in str(e),
              f"the message must explain the problem: {e}")
        return
    check(False, "an IRI with a space must not be emitted")


@test
def literals_are_escaped_not_quoted_blindly():
    published = _published()
    idx = next(i for i, m in enumerate(published.mappings)
               if m.kind == ProposalKind.DIRECT.value)
    published.mappings[idx] = replace(
        published.mappings[idx], target_column='we"ird\\col')
    doc = to_r2rml_turtle(published, strict=False)
    check('we\\"ird\\\\col' in doc.turtle,
          "quotes and backslashes must be escaped in that order")
    try:
        import rdflib
    except ImportError:
        return
    rdflib.Graph().parse(data=doc.turtle, format="turtle")  # must not raise


@test
def two_same_named_tables_in_different_schemas_do_not_collide():
    """The map IRI uses the qualified name, so they stay distinct."""
    from graph_utility.ontobricks import _map_name
    a = _map_name("http://b", "cat_a.sch.contract")
    b = _map_name("http://b", "cat_b.sch.contract")
    check(a != b, f"qualified names must produce distinct maps: {a} vs {b}")


if __name__ == "__main__":
    print(f"\nALL COMPARE OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
