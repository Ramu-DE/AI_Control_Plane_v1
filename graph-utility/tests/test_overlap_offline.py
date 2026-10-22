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
def test_a_foreign_key_with_an_unrecognised_name_is_now_probed():
    """The shortlist is no longer bound to `looks_like_identifier`.

    `_ID_SHAPE` matches names ending id|key|code|uuid|guid|number|no|nbr, so a
    foreign key called `buyer_ref` or `parent_fk` used to be invisible — it was
    never measured, so profiling could not help. Candidate selection now
    considers every type-compatible column and RANKS them, with name shape as a
    ranking signal rather than a filter.
    """
    from graph_utility.discovery import looks_like_identifier
    check(not looks_like_identifier("buyer_ref", LogicalType.STRING),
          "the name heuristic still does not recognise *_ref …")

    order = TableMetadata(
        name="order_line",
        columns=(ColumnMetadata("line_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("buyer_ref", LogicalType.STRING),
                 ColumnMetadata("qty", LogicalType.INTEGER)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("line_id",), name="pk_ol"),),
    )
    customer = _adapter()._tables["customer"]
    a = InMemoryDataAdapter("renamed", [
        InMemoryTable(order, [
            {"line_id": "L1", "buyer_ref": "C1", "qty": 2},
            {"line_id": "L2", "buyer_ref": "C2", "qty": 5},
        ]),
        customer,
    ])
    discovery = a.discover()
    cands = gu.candidate_column_sets(discovery, "order_line", "customer")
    left_names = [c[0][0] for c in cands]
    check("buyer_ref" in left_names,
          "… but it IS now probed, which is the whole point")
    check("qty" not in left_names,
          "a type-incompatible column is still excluded: an INTEGER cannot "
          "implement a STRING key")

    # And it resolves end to end.
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    gu.enrich_relationships_with_overlap(proposals, a, discovery)
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    check(rel.join is not None and rel.join.left_columns == ("buyer_ref",),
          "a measured join on an unrecognised-name FK must be supplied")


@test
def test_candidates_are_ranked_so_a_bounded_budget_is_spent_well():
    """Probe order was alphabetical, which spent the budget on the wrong columns.

    On a wide table `attr_1, attr_10, …` were probed long before the real
    foreign key, so widening the shortlist would have made things worse rather
    than better. Plausible candidates must come first.
    """
    cols = [ColumnMetadata("row_id", LogicalType.STRING, nullable=False)]
    cols += [ColumnMetadata(f"attr_{i}", LogicalType.STRING) for i in range(12)]
    cols.append(ColumnMetadata("cust_code", LogicalType.STRING))   # exact match
    cols.append(ColumnMetadata("buyer_ref", LogicalType.STRING))
    wide = TableMetadata(
        name="order_line", columns=tuple(cols),
        keys=(KeyMetadata(KeyType.PRIMARY, ("row_id",), name="pk"),))
    a = InMemoryDataAdapter("wide", [
        InMemoryTable(wide, [{c.name: "x" for c in cols}]),
        _adapter()._tables["customer"],
    ])
    order = [c[0][0] for c in
             gu.candidate_column_sets(a.discover(), "order_line", "customer")]
    check(order[0] == "cust_code",
          f"an exact name match must be probed first, got {order[:3]}")
    attrs = [i for i, n in enumerate(order) if n.startswith("attr_")]
    shaped = [i for i, n in enumerate(order) if n in ("row_id", "buyer_ref")]
    check(min(shaped) < min(attrs),
          f"identifier-shaped and similar names must precede generic "
          f"attributes, got {order[:6]}")


# --------------------------------------------------------------------------- #
# 3. Enrichment of real proposals
# --------------------------------------------------------------------------- #
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
def test_ambiguity_blocks_automation():
    """Several columns fully contained means the choice is a GUESS.

    A low-cardinality attribute can reach 100% containment by coincidence —
    `region_code` happening to hold values that are also customer codes. With a
    widened shortlist that is not a remote possibility, so when more than one
    column qualifies, picking the best-ranked one would dress a guess up as a
    measurement. A reviewer must choose.
    """
    order = TableMetadata(
        name="order_line",
        columns=(ColumnMetadata("line_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("buyer_code", LogicalType.STRING),
                 # NOT a foreign key — an attribute whose values coincide.
                 ColumnMetadata("region_code", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("line_id",), name="pk_ol"),),
    )
    a = InMemoryDataAdapter("ambiguous", [
        InMemoryTable(order, [
            {"line_id": "L1", "buyer_code": "C1", "region_code": "C2"},
            {"line_id": "L2", "buyer_code": "C2", "region_code": "C1"},
        ]),
        _adapter()._tables["customer"],
    ])
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    gu.enrich_relationships_with_overlap(proposals, a, discovery)
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")

    check(rel.join is None,
          "with two equally-contained columns, NO join may be chosen")
    issue = next((i for i in rel.validation_issues
                  if i.code == "overlap-ambiguous"), None)
    check(issue is not None, "the ambiguity must be reported")
    check("buyer_code" in issue.message and "region_code" in issue.message,
          f"and both candidates named so a human can choose: {issue.message}")
    check(sum(1 for e in rel.evidence if e.kind == "value-overlap") == 2,
          "both measurements must be kept as evidence")
    gu.auto_approve(proposals)
    check(not gu.was_auto_approved(rel), "and it must not auto-approve")


@test
def test_probe_budget_is_per_proposal_and_exhaustion_is_loud():
    """A global budget let one wide table silently starve every later proposal.

    Worse, starvation was indistinguishable from "measured and rejected": both
    produced no join and no issue. They call for different actions, so running
    out of budget must say so.
    """
    a = _adapter()
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _relationship_schema())
    # A budget of 1 cannot cover the candidate list for this pair.
    gu.enrich_relationships_with_overlap(proposals, a, discovery, max_probes=1)
    rel = next(p for p in proposals if p.ontology_uri == CT + "placedBy")
    codes = {i.code for i in rel.validation_issues}
    if rel.join is None:
        check("overlap-probe-budget" in codes,
              f"exhaustion must be recorded, got {codes}")
        msg = next(i.message for i in rel.validation_issues
                   if i.code == "overlap-probe-budget")
        check("budget" in msg and "candidate" in msg,
              f"and must say how far it got: {msg}")
    else:
        # The ranking put the real key first, so one probe was enough — which
        # is the ranking working, not the budget failing.
        check(rel.join.left_columns == ("buyer_code",),
              "if one probe sufficed it must be because ranking found the key")


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


# --------------------------------------------------------------------------- #
# 4. Subject identity from measurement
# --------------------------------------------------------------------------- #
def _keyless(rows=None, extra_cols=(), keys=()):
    """A table with NO declared primary key — the common real case."""
    cols = (ColumnMetadata("cust_code", LogicalType.STRING, nullable=False),
            ColumnMetadata("cust_name", LogicalType.STRING)) + tuple(extra_cols)
    meta = TableMetadata(name="customer", columns=cols, keys=tuple(keys))
    return InMemoryDataAdapter("keyless", [InMemoryTable(meta, rows if rows is not None else [
        {"cust_code": "C1", "cust_name": "Acme"},
        {"cust_code": "C2", "cust_name": "Globex"},
    ])])


def _class_schema():
    return {"classes": [{"class": CT + "Customer", "label": "Customer"}],
            "properties": [{"property": CT + "custName", "label": "Cust Name",
                            "domain": CT + "Customer", "range": "xsd:string",
                            "ptype": "owl:DatatypeProperty"}],
            "relationships": []}


@test
def test_a_declared_unique_constraint_is_accepted_as_a_subject_key():
    """A UNIQUE constraint identifies a row, so blocking it was pointless.

    `primary_key()` only answers about PRIMARY, which is correct for its own
    callers; `subject_key()` is the question the class gate actually needs.
    """
    from graph_utility.discovery import KeyMetadata as KM
    a = _keyless(keys=(KM(KeyType.UNIQUE, ("cust_code",), name="uq_cust"),))
    table = a.discover().table("customer")
    check(table.primary_key() is None, "there is no PRIMARY key")
    check(table.subject_key() is not None, "but there IS a usable subject key")
    proposals = gu.propose_mappings(a.discover(), _class_schema())
    cls = next(p for p in proposals
               if p.kind == gu.ProposalKind.CLASS and p.target_table == "customer")
    check(cls.subject_columns == ("cust_code",), "and it is used, with no probing")
    check(not any(i.code == "no-subject-key" for i in cls.validation_issues),
          "so the class must not be blocked")


@test
def test_a_keyless_table_is_blocked_until_uniqueness_is_measured():
    a = _keyless()
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _class_schema())
    cls = next(p for p in proposals
               if p.kind == gu.ProposalKind.CLASS and p.target_table == "customer")
    check(cls.subject_columns == (), "no declared key means no subject columns")
    check(any(i.code == "no-subject-key" and i.severity == "error"
              for i in cls.validation_issues),
          "and the class is BLOCKED — not even a human can approve it")

    proofs = gu.enrich_classes_with_uniqueness(proposals, a, discovery)
    check(proofs, "a uniqueness probe must have been taken")
    check(cls.subject_columns == ("cust_code",),
          f"the measured key must be adopted, got {cls.subject_columns}")
    check(not any(i.code == "no-subject-key" for i in cls.validation_issues),
          "the block must be cleared, because identity is now evidenced")
    check(any(e.kind == "uniqueness-verified" for e in cls.evidence),
          "with a distinct evidence kind, so measured is never mistaken for declared")
    gu.auto_approve(proposals)
    check(gu.was_auto_approved(cls), "and the class may now auto-approve")
    check("measured unique" in (cls.notes or ""),
          f"the justification must say it was MEASURED: {cls.notes}")


@test
def test_a_non_unique_column_never_becomes_identity():
    a = _keyless(rows=[
        {"cust_code": "C1", "cust_name": "Acme"},
        {"cust_code": "C1", "cust_name": "Acme Again"},   # duplicate
    ])
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _class_schema())
    cls = next(p for p in proposals if p.kind == gu.ProposalKind.CLASS)
    gu.enrich_classes_with_uniqueness(proposals, a, discovery)
    check(cls.subject_columns == (), "a non-unique column must not be adopted")
    check(any(i.code == "no-subject-key" for i in cls.validation_issues),
          "so the class stays blocked")
    check(any(i.code == "uniqueness-unproven" for i in cls.validation_issues),
          "with the measurement recorded for the reviewer")
    gu.auto_approve(proposals)
    check(not gu.was_auto_approved(cls), "and it must not auto-approve")
    # `cust_name` IS unique here (Acme / Acme Again), which is exactly the trap:
    # uniqueness alone would have keyed the graph on a display name.
    issue = next(i for i in cls.validation_issues if i.code == "uniqueness-unproven")
    check("non-key-shaped" in issue.message,
          f"the reviewer must be told a unique non-key column exists: {issue.message}")
    check(any(e.kind == "profile" and "cust_name" in e.detail for e in cls.evidence),
          "and shown the measurement, without it being adopted")


@test
def test_a_nullable_column_never_becomes_identity():
    """Non-nullness matters as much as uniqueness.

    materialize.py skips a row whose key is NULL or empty, so a nullable key
    would silently drop entities rather than identify them.
    """
    a = _keyless(rows=[
        {"cust_code": "C1", "cust_name": "Acme"},
        {"cust_code": None, "cust_name": "Ghost"},
    ])
    proof = gu.verify_uniqueness(a, "customer", ("cust_code",))
    check(proof.is_unique, "the non-null values ARE distinct")
    check(not proof.is_non_null, "but the column has a null")
    check(not proof.proves_identity, "so it cannot prove identity")
    # Empty string counts as missing too, matching materialize.py.
    b = _keyless(rows=[{"cust_code": "C1", "cust_name": "A"},
                       {"cust_code": "", "cust_name": "B"}])
    check(not gu.verify_uniqueness(b, "customer", ("cust_code",)).is_non_null,
          "an empty string is a missing key, exactly as materialisation treats it")


@test
def test_a_trivially_small_table_proves_nothing():
    a = _keyless(rows=[{"cust_code": "C1", "cust_name": "Acme"}])
    proof = gu.verify_uniqueness(a, "customer", ("cust_code",))
    check(proof.is_unique and proof.is_non_null, "one row is trivially unique")
    check(not proof.proves_identity,
          f"but fewer than {gu.MIN_ROWS_FOR_UNIQUENESS_PROOF} rows proves nothing")


@test
def test_a_sampled_uniqueness_probe_is_not_proof():
    a = _keyless()
    proof = gu.verify_uniqueness(a, "customer", ("cust_code",), probe_limit=1)
    check(not proof.exhaustive, "a capped probe must report itself as sampled")
    check(not proof.proves_identity, "and a sample cannot prove identity")
    check("SAMPLED" in proof.describe(), "labelled plainly")


@test
def test_a_measure_column_is_never_identity_even_if_unique():
    from graph_utility.overlap import _identity_candidates
    a = _keyless(extra_cols=(ColumnMetadata("balance", LogicalType.DECIMAL),))
    table = a.discover().table("customer")
    cands = _identity_candidates(table)
    names = [n for n, _adopt in cands]
    check("balance" not in names,
          "a DECIMAL amount is not identity, however unique it happens to be")
    check("cust_code" in names, "but the code is a candidate")
    check(cands[0] == ("cust_code", True),
          f"identifier-shaped names come first and are adoptable, got {cands[0]}")
    adopt = dict(cands)
    check(adopt.get("cust_name") is False,
          "a display name is probed but must NOT be adoptable as identity")


@test
def test_a_composite_key_is_discovered_in_canonical_column_order():
    """A junction table's identity is normally the PAIR of foreign keys.

    Without composite probing, a constraint-free junction can never be keyed
    and every edge through it is lost — which is most of the graph.

    The column ORDER matters as much as the columns: the subject IRI embeds it,
    so `T1/S1` and `S1/T1` are different entities. Measured keys therefore use
    TABLE COLUMN ORDER, which is how a primary key is normally declared, so a
    table that later gains the constraint mints the SAME IRIs rather than a
    parallel set of nodes.
    """
    junction = TableMetadata(
        name="trial_site",
        columns=(ColumnMetadata("trial_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("enrolled_count", LogicalType.INTEGER)),
        keys=(),            # no declared constraints at all
    )
    a = InMemoryDataAdapter("junction", [InMemoryTable(junction, [
        {"trial_id": "T1", "site_id": "S1", "enrolled_count": 40},
        {"trial_id": "T1", "site_id": "S2", "enrolled_count": 35},
        {"trial_id": "T2", "site_id": "S1", "enrolled_count": 200},
    ])])
    discovery = a.discover()
    schema = {"classes": [{"class": CT + "TrialSite", "label": "Trial Site"}],
              "properties": [{"property": CT + "enrolledCount",
                              "label": "Enrolled Count",
                              "domain": CT + "TrialSite", "range": "xsd:integer",
                              "ptype": "owl:DatatypeProperty"}],
              "relationships": []}
    proposals = gu.propose_mappings(discovery, schema)
    cls = next(p for p in proposals if p.kind == gu.ProposalKind.CLASS)
    check(any(i.code == "no-subject-key" for i in cls.validation_issues),
          "no single column identifies a row, so it starts blocked")

    gu.enrich_classes_with_uniqueness(proposals, a, discovery)
    check(cls.subject_columns == ("trial_id", "site_id"),
          f"the composite key must be found in TABLE column order, got "
          f"{cls.subject_columns}")
    check(not any(i.code == "no-subject-key" for i in cls.validation_issues),
          "and the block cleared")

    gu.auto_approve(proposals)
    published = gu.publish_mappings("junction", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, a, build_id="comp01",
        base_uri="http://example.org/resource/", strict=False)
    check(result.class_instances == 3, "all three junction rows become subjects")
    check(not result.has_conflation, "a correct composite key must not conflate")
    expected = gu.mint_subject_iri(
        "http://example.org/resource/", "trial_site", ["T1", "S1"])
    check(any(ln.startswith(f"<{expected}>") for ln in lines),
          f"and the IRI must match what a DECLARED PK would mint: {expected}")


@test
def test_a_proven_key_materialises_a_graph_from_a_constraint_free_table():
    a = _keyless()
    discovery = a.discover()
    proposals = gu.propose_mappings(discovery, _class_schema())
    gu.enrich_classes_with_uniqueness(proposals, a, discovery)
    gu.auto_approve(proposals)
    published = gu.publish_mappings("keyless", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, a, build_id="keyless01",
        base_uri="http://example.org/resource/", strict=False)
    check(result.class_instances == 2,
          f"both rows must become subjects, got {result.class_instances}")
    check(not result.has_conflation, "and a proven key must not conflate")
    expected = gu.mint_subject_iri("http://example.org/resource/", "customer", ["C1"])
    check(any(ln.startswith(f"<{expected}>") for ln in lines),
          "the subject IRI must be keyed on the measured column")


if __name__ == "__main__":
    print(f"\nALL OVERLAP OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
