"""Offline tests for value-overlap profiling.

Most real datasets declare no foreign keys — the live `agentexpress_*` tables
have none — so relationships either go undiscovered or get guessed from column
names. Profiling is the third option: measure referential containment and let
the DATA justify the join.

The tests that matter most here are the ones where profiling must REFUSE:
partial containment, a non-unique parent key, and a sampled (non-exhaustive)
probe. A measurement that cannot support a conclusion must not be allowed to
look like one.

Run: python3 tests/test_overlap_offline.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility as gu
from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
from graph_utility.discovery import (
    ColumnMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata)

PASSED = 0
TESTS = 0
CT = "http://example.org/ontology/ct#"


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


# --------------------------------------------------------------------------- #
# A dataset with NO declared foreign keys — the common real case.
# --------------------------------------------------------------------------- #
def _adapter(order_rows=None, customer_rows=None, customer_keys=None):
    customer = TableMetadata(
        name="customer",
        columns=(ColumnMetadata("cust_code", LogicalType.STRING, nullable=False,
                                is_identifier_like=True),
                 ColumnMetadata("cust_name", LogicalType.STRING)),
        keys=customer_keys if customer_keys is not None
        else (KeyMetadata(KeyType.PRIMARY, ("cust_code",), name="pk_customer"),),
    )
    order = TableMetadata(
        name="order_line",
        columns=(ColumnMetadata("line_id", LogicalType.STRING, nullable=False,
                                is_identifier_like=True),
                 # NOT named cust_code, and NOT a declared FK.
                 ColumnMetadata("buyer_code", LogicalType.STRING,
                                is_identifier_like=True),
                 ColumnMetadata("qty", LogicalType.INTEGER)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("line_id",), name="pk_order_line"),),
    )
    return InMemoryDataAdapter("no-fks", [
        InMemoryTable(order, order_rows if order_rows is not None else [
            {"line_id": "L1", "buyer_code": "C1", "qty": 2},
            {"line_id": "L2", "buyer_code": "C2", "qty": 5},
            {"line_id": "L3", "buyer_code": "C1", "qty": 1},
        ]),
        InMemoryTable(customer, customer_rows if customer_rows is not None else [
            {"cust_code": "C1", "cust_name": "Acme"},
            {"cust_code": "C2", "cust_name": "Globex"},
        ]),
    ])


# --------------------------------------------------------------------------- #
# 1. The measurement
# --------------------------------------------------------------------------- #
@test
def test_full_containment_is_measured_and_supports_automation():
    a = _adapter()
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    check(m.left_distinct == 2, f"C1 and C2 are the distinct keys, got {m.left_distinct}")
    check(m.matched == 2, "both exist on the right")
    check(m.containment == 1.0, "containment must be exactly 1.0")
    check(m.right_is_unique, "cust_code is unique in the fixture")
    check(m.exhaustive, "the whole relation fits under the probe limit")
    check(m.supports_auto_approval,
          "full containment into a unique key is a measurement, so it may automate")


@test
def test_partial_containment_refuses_to_automate():
    """Orphans mean this is probably not the relationship you think it is."""
    a = _adapter(order_rows=[
        {"line_id": "L1", "buyer_code": "C1", "qty": 2},
        {"line_id": "L2", "buyer_code": "GHOST", "qty": 5},   # no such customer
    ])
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    check(m.containment == 0.5, f"half the keys match, got {m.containment}")
    check(not m.supports_auto_approval,
          "partial containment must NOT auto-approve, however high")
    check("50.0%" in m.describe(), f"the figure must be stated plainly: {m.describe()}")


@test
def test_non_unique_parent_refuses_to_automate():
    """Joining to a non-unique column fabricates edges by fan-out."""
    a = _adapter(customer_rows=[
        {"cust_code": "C1", "cust_name": "Acme"},
        {"cust_code": "C1", "cust_name": "Acme Again"},   # duplicate key
        {"cust_code": "C2", "cust_name": "Globex"},
    ])
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    check(m.containment == 1.0, "every left key is still present")
    check(not m.right_is_unique, "but the right side is not unique")
    check(not m.supports_auto_approval,
          "a non-unique parent key is not a foreign key; it must not automate")
    check("is NOT unique" in m.describe(), "and the description must say so")


@test
def test_sampled_probe_is_never_treated_as_proof():
    a = _adapter()
    m = gu.measure_join_overlap(
        a, "order_line", ("buyer_code",), "customer", ("cust_code",), probe_limit=1)
    check(not m.exhaustive, "a capped probe must report itself as sampled")
    check(not m.supports_auto_approval,
          "a sample cannot justify auto-approval, whatever it shows")
    check("SAMPLED" in m.describe(), "and must be labelled in the description")


@test
def test_nulls_are_not_references():
    a = _adapter(order_rows=[
        {"line_id": "L1", "buyer_code": "C1", "qty": 2},
        {"line_id": "L2", "buyer_code": None, "qty": 5},
    ])
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    check(m.left_distinct == 1, "a NULL key is not a reference and must not be counted")
    check(m.containment == 1.0, "so containment is over the real references only")


@test
def test_empty_left_side_is_not_full_containment():
    a = _adapter(order_rows=[])
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    check(m.left_distinct == 0, "nothing on the left")
    check(m.containment == 0.0, "0/0 must not be reported as 1.0")
    check(not m.supports_auto_approval,
          "an empty relation proves nothing and must not automate")


@test
def test_mismatched_arity_is_rejected():
    a = _adapter()
    try:
        gu.measure_join_overlap(a, "order_line", ("buyer_code", "qty"),
                                "customer", ("cust_code",))
        check(False, "unequal column lists must raise")
    except ValueError as e:
        check("equal" in str(e), "the error must explain why")


@test
def test_measurement_serialises_for_the_audit_trail():
    a = _adapter()
    m = gu.measure_join_overlap(a, "order_line", ("buyer_code",), "customer", ("cust_code",))
    d = m.to_dict()
    for key in ("containment", "right_is_unique", "exhaustive", "method",
                "supports_auto_approval", "left_distinct", "matched"):
        check(key in d, f"the record must carry {key}")
    check(d["method"] == "row-probe", "the fallback must name its method")


# --------------------------------------------------------------------------- #
# 2. Candidate selection
# --------------------------------------------------------------------------- #
@test
def test_candidates_require_a_declared_parent_key():
    d = _adapter(customer_keys=()).discover()
    check(gu.candidate_column_sets(d, "order_line", "customer") == [],
          "with no key on the parent there is nothing to profile")
    d2 = _adapter().discover()
    cands = gu.candidate_column_sets(d2, "order_line", "customer")
    check(cands, "with a parent PK there are candidates")
    for left_cols, right_cols in cands:
        check(right_cols == ("cust_code",),
              "the right side must always be the parent's declared key")
        check(len(left_cols) == len(right_cols), "arity must match")


@test
def test_candidates_only_consider_identifier_shaped_columns():
    d = _adapter().discover()
    cands = gu.candidate_column_sets(d, "order_line", "customer")
    left_names = {c[0][0] for c in cands}
    check("qty" not in left_names, "a measure column is not a join candidate")
    check("buyer_code" in left_names,
          "an identifier-shaped column is, even though its name shares only one "
          "token with the parent key so name matching could not justify it")


@test
def test_a_column_joined_to_itself_is_never_a_candidate():
    """Found in a live run: a self-referential ontology relationship.

    `spansRegion` has domain and range Site, so the probe became
    `site.site_id -> site.site_id` — vacuously 100% contained into a trivially
    unique key. It auto-approved and minted a reflexive edge for every row.
    A tautology must never reach the measurement stage.
    """
    self_ref = TableMetadata(
        name="employee",
        columns=(ColumnMetadata("employee_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("manager_id", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("employee_id",), name="pk_emp"),),
    )
    a = InMemoryDataAdapter("selfref", [InMemoryTable(self_ref, [
        {"employee_id": "E1", "manager_id": None},
        {"employee_id": "E2", "manager_id": "E1"},
    ])])
    cands = gu.candidate_column_sets(a.discover(), "employee", "employee")
    check(("employee_id",) not in [c[0] for c in cands],
          "a column joined to itself on the same table must be excluded")
    check(("manager_id",) in [c[0] for c in cands],
          "but a GENUINE self-reference on a different column is still probed")
    m = gu.measure_join_overlap(a, "employee", ("manager_id",), "employee",
                                ("employee_id",))
    check(m.supports_auto_approval,
          "and it measures correctly: E2's manager E1 exists, NULL is not a ref")


@test
def test_candidate_selection_is_still_name_shaped_a_known_limit():
    """Honest about the boundary: the CONCLUSION is measured, the SHORTLIST is not.

    `looks_like_identifier` matches names ending id|key|code|uuid|guid|number|
    no|nbr, so a foreign key called `buyer_ref` or `parent_fk` is never probed
    at all. Profiling removes the guess from the verdict, not from the search.
    """
    from graph_utility.discovery import looks_like_identifier
    check(looks_like_identifier("buyer_code", LogicalType.STRING),
          "a *_code column is shortlisted")
    check(not looks_like_identifier("buyer_ref", LogicalType.STRING),
          "but a *_ref column is NOT — it would never be measured")
    a = _adapter()
    # Rename the column to the unmatched shape and confirm it drops out.
    order = a._tables["order_line"]
    renamed = TableMetadata(
        name="order_line",
        columns=tuple(
            ColumnMetadata("buyer_ref" if c.name == "buyer_code" else c.name,
                           c.logical_type, nullable=c.nullable)
            for c in order.metadata.columns),
        keys=order.metadata.keys,
    )
    a2 = InMemoryDataAdapter("renamed", [
        InMemoryTable(renamed, [{"line_id": "L1", "buyer_ref": "C1", "qty": 2}]),
        a._tables["customer"],
    ])
    cands = gu.candidate_column_sets(a2.discover(), "order_line", "customer")
    check(all(c[0][0] != "buyer_ref" for c in cands),
          "confirming the limit, so it is a known gap rather than a surprise")


# --------------------------------------------------------------------------- #
# 3. Enrichment of real proposals
# --------------------------------------------------------------------------- #
def _relationship_schema():
    """An ontology relating Order Line to Customer, with no name overlap."""
    return {
        "classes": [
            {"class": CT + "OrderLine", "label": "Order Line"},
            {"class": CT + "Customer", "label": "Customer"},
        ],
        "properties": [
            {"property": CT + "custName", "label": "Cust Name",
             "domain": CT + "Customer", "range": "xsd:string",
             "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [
            {"property": CT + "placedBy", "label": "Placed By",
             "domain": CT + "OrderLine", "range": CT + "Customer"},
        ],
    }


@test
def test_a_relationship_with_no_declared_fk_starts_blocked():
    a = _adapter()
    proposals = gu.propose_mappings(a.discover(), _relationship_schema())
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is None, "there is no declared FK, so no join")
    check(any(i.code == "no-key-evidence" for i in rel.validation_issues),
          "and it must be blocked rather than guessed")
    check(rel.domain_table == "order_line",
          "the domain side must be carried as data for profiling to use")
    eligible, _ = gu.auto_approval_verdict(rel)
    check(not eligible, "blocked proposals cannot auto-approve")


@test
def test_profiling_unblocks_a_measured_join():
    a = _adapter()
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    measurements = gu.enrich_relationships_with_overlap(proposals, a, discovery)
    check(measurements, "a probe must have been taken")

    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is not None, "the measured join must be supplied")
    check(rel.join.origin == "profiled",
          "and marked as profiled, not declared — provenance must stay honest")
    check(rel.join.left_columns == ("buyer_code",), "with the measured columns")
    check(rel.join.right_columns == ("cust_code",), "pointing at the parent key")
    check(not any(i.code == "no-key-evidence" for i in rel.validation_issues),
          "the no-key block must be cleared, because there IS now key evidence")
    check(any(e.kind == "value-overlap" for e in rel.evidence),
          "the measurement must be recorded as evidence")
    check(any(e.kind == "key-metadata" for e in rel.evidence),
          "and count as key evidence for the policy")

    gu.auto_approve(proposals)
    check(gu.was_auto_approved(rel),
          "a fully measured join into a unique key may now auto-approve")
    check("auto-approved" in (rel.notes or ""), "with a written justification")


@test
def test_profiling_leaves_a_doubtful_join_blocked():
    a = _adapter(order_rows=[
        {"line_id": "L1", "buyer_code": "C1", "qty": 2},
        {"line_id": "L2", "buyer_code": "GHOST", "qty": 5},
    ])
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    gu.enrich_relationships_with_overlap(proposals, a, discovery)
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is None, "a partial match must NOT be promoted to a join")
    check(any(i.code == "no-key-evidence" for i in rel.validation_issues),
          "the original block must remain")
    check(any(i.code == "overlap-insufficient" for i in rel.validation_issues),
          "with the measurement recorded as a reason for review")
    check(any(e.kind == "value-overlap" for e in rel.evidence),
          "the human still gets to see the number")
    gu.auto_approve(proposals)
    check(not gu.was_auto_approved(rel), "and it must not auto-approve")


@test
def test_profiling_never_touches_a_declared_join_or_decided_proposal():
    from fixtures_clinical import clinical_trial_adapter
    a = clinical_trial_adapter()
    discovery = a.discover()
    schema = {
        "classes": [{"class": CT + "TrialSite", "label": "Trial Site"},
                    {"class": CT + "Trial", "label": "Trial"}],
        "properties": [],
        "relationships": [{"property": CT + "forTrial", "label": "Trial",
                           "domain": CT + "TrialSite", "range": CT + "Trial"}],
    }
    proposals = gu.propose_mappings(discovery, schema)
    rel = next(p for p in proposals if p.ontology_uri == CT + "forTrial")
    check(rel.join is not None and rel.join.origin == "discovered",
          "this fixture HAS a declared FK")
    before = rel.join
    gu.enrich_relationships_with_overlap(proposals, a, discovery)
    check(rel.join is before,
          "a declared join must never be replaced by a profiled one")


@test
def test_a_failing_probe_does_not_fail_the_build():
    class Broken(InMemoryDataAdapter):
        def execute(self, sql, parameters):
            raise RuntimeError("warehouse unavailable")

    base = _adapter()
    broken = Broken("no-fks", list(base._tables.values()))
    discovery = base.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    measurements = gu.enrich_relationships_with_overlap(proposals, broken, discovery)
    check(measurements == [], "no measurement succeeded")
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is None, "and nothing was invented")
    check(any(e.kind == "profile" and "failed" in e.detail for e in rel.evidence),
          "the failure must be recorded as evidence, not swallowed")


@test
def test_probe_budget_is_bounded():
    a = _adapter()
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    measurements = gu.enrich_relationships_with_overlap(
        proposals, a, discovery, max_probes=0)
    check(measurements == [], "with no probe budget nothing is measured")
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is None, "and nothing is concluded")


if __name__ == "__main__":
    print(f"\nALL OVERLAP OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
