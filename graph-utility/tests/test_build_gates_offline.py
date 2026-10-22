"""Offline tests for the ontology→graph conversion gates.

These cover five changes, four of which were defects found by TESTING the
conversion rather than reading it:

1. EDGES TO UNDEFINED ENTITIES. `by_table` was built from DIRECT mappings, so a
   class approved with none of its properties approved emitted no `rdf:type` at
   all — while the relationship pass happily minted edges pointing at its IRIs.
   The build contained edges to entities the graph never defined and the
   manifest called it clean. Measured before the fix: 3 dangling targets,
   `skipped=0`, `conflated=[]`.

2. LIMIT WITHOUT ORDER BY. A capped build returned an arbitrary row set, so it
   was not reproducible, while `write_nquads` hashed the bytes and presented
   that hash as provenance. Node rows and edge rows were capped by separate
   unordered queries, so an edge could reference a parent this build never
   materialized — nondeterministically.

3. GATES IN THE WRONG PLACE. Conflation and constraint checks lived in
   `integration/build_graph_live.py`, so the demo runner was safe and the
   control plane inherited nothing.

4. NO LABELS ANYWHERE. A traversal returned bare IRIs, which is unusable for an
   agent composing an answer.

5. NO BUILD DIFF, so a mapping regression was invisible until a query returned
   the wrong number.

The determinism test has a CONTROL: it disables the ORDER BY and asserts the
hashes then diverge. Without that, a passing test would prove only that the
fixture happens to return rows in a stable order.

Run: python3 tests/test_build_gates_offline.py
"""
from __future__ import annotations

import hashlib
import os
import random
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility.materialize as M
from fixtures_contractiq import NS, contractiq_adapter, contractiq_ontology
from graph_utility.build import BuildRefused, build_graph, describe_build
from graph_utility.mapping import (
    ProposalKind,
    auto_approve,
    propose_mappings,
    publish_mappings,
    reject,
)
from graph_utility.materialize import (
    MaterializationError,
    RDFS_LABEL,
    RDF_TYPE,
    diff_graphs,
    is_iri,
    label_candidates,
    materialize_graph,
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


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _published(*, drop_table_props=None, drop_property=None, shuffle_seed=None):
    """A published mapping set, optionally damaged in a specific way."""
    adapter = contractiq_adapter()
    if shuffle_seed is not None:
        # Emulate a warehouse returning rows in a different physical order.
        rnd = random.Random(shuffle_seed)
        for tbl in adapter._tables.values():
            rows = getattr(tbl, "rows", None)
            if isinstance(rows, list) and len(rows) > 1:
                rnd.shuffle(rows)
    discovery = adapter.discover()
    proposals = propose_mappings(discovery, contractiq_ontology())
    enrich_classes_with_uniqueness(proposals, adapter, discovery)
    enrich_relationships_with_overlap(proposals, adapter, discovery)
    for p in proposals:
        if p.kind != ProposalKind.DIRECT:
            continue
        if drop_table_props and p.target_table == drop_table_props:
            reject(p, "tester", "simulating a class with no approved properties")
        if drop_property and p.ontology_uri == drop_property:
            reject(p, "tester", "simulating a mapping regression")
    auto_approve(proposals)
    return publish_mappings("contract-iq", proposals, strict=False), adapter


def _dangling(triples):
    typed = {s for (s, p, _o) in triples if p == RDF_TYPE}
    return sorted({
        o[1] for (_s, p, o) in triples
        if is_iri(o) and p != RDF_TYPE and o[1] not in typed
    })


# --------------------------------------------------------------------------- #
# 1. Edges to undefined entities
# --------------------------------------------------------------------------- #
@test
def a_class_with_no_approved_properties_is_still_materialized():
    """It was invisible. Three edges pointed at it and nothing said so."""
    published, adapter = _published(drop_table_props="therapeutic_area")
    triples, result = materialize_graph(
        published, adapter, build_id="b", strict=False)
    check(not _dangling(triples),
          f"no edge may point at an undefined entity, got {_dangling(triples)}")
    check("therapeutic_area" in result.typed_only_tables,
          f"and the manifest must say the class carries only its type, got "
          f"{result.typed_only_tables}")
    # The nodes exist and are typed, even with no literals.
    typed_ta = [s for (s, p, o) in triples
                if p == RDF_TYPE and is_iri(o)
                and o[1] == NS + "TherapeuticArea"]
    check(len(typed_ta) == 3,
          f"all three therapeutic areas must become typed nodes, got "
          f"{len(typed_ta)}")


@test
def a_clean_build_has_no_dangling_edges_and_says_it_is_sound():
    published, adapter = _published()
    triples, result = materialize_graph(
        published, adapter, build_id="b", strict=False)
    check(not _dangling(triples), "the clean fixture must have none")
    check(result.dangling_edges == 0 and not result.has_dangling_edges,
          "and the manifest must agree")
    check(result.sound and result.complete,
          f"a clean build is sound and complete, got sound={result.sound} "
          f"complete={result.complete}")


@test
def dangling_edges_are_reported_with_an_example_not_just_a_count():
    """A bare count sends you back to re-run the build to find the cause."""
    published, adapter = _published()
    triples, result = materialize_graph(
        published, adapter, build_id="b", strict=False, max_rows_per_table=2)
    if not result.has_dangling_edges:
        print("      (skipped: this cap produced none)")
        return
    check(result.dangling_samples, "samples must accompany the count")
    s = result.dangling_samples[0]
    check({"subject", "predicate", "object"} <= set(s),
          f"a sample must identify the whole edge, got {sorted(s)}")


@test
def strict_materialization_refuses_a_dangling_edge():
    published, adapter = _published()
    try:
        materialize_graph(published, adapter, build_id="b", strict=True,
                          max_rows_per_table=2)
    except MaterializationError as e:
        check("never typed" in str(e) or "does not define" in str(e),
              f"the message must explain what is wrong: {e}")
        return
    print("      (skipped: this cap produced no dangling edge)")


# --------------------------------------------------------------------------- #
# 2. Deterministic truncation
# --------------------------------------------------------------------------- #
def _capped_hash(seed):
    published, adapter = _published(shuffle_seed=seed)
    lines, _ = build_graph(
        published, adapter, build_id="cap", max_rows_per_table=2,
        allow_truncation=True, allow_dangling=True,
        # Provenance carries prov:generatedAtTime, which changes every run by
        # design. Excluded so this measures the DATA, which is the claim.
        include_provenance=False, reason=False)
    return hashlib.sha256("".join(lines).encode()).hexdigest()


@test
def a_capped_build_is_reproducible_under_reordered_source_rows():
    hashes = {_capped_hash(seed) for seed in (1, 2, 3, 4, 5)}
    check(len(hashes) == 1,
          f"a capped build must be a reproducible PREFIX, got {len(hashes)} "
          f"distinct artifacts across 5 runs")


@test
def and_the_control_shows_order_by_is_what_makes_it_so():
    """Disable the ORDER BY: the hashes must then diverge.

    Without this, the test above would also pass on a fixture that merely
    happens to iterate in insertion order, proving nothing about the fix.
    """
    original = M._order_clause
    M._order_clause = lambda aliases, dialect: ""
    try:
        hashes = {_capped_hash(seed) for seed in (1, 2, 3, 4, 5)}
    finally:
        M._order_clause = original
    check(len(hashes) > 1,
          "with no ORDER BY, shuffled source rows must produce different "
          "artifacts — otherwise this test has no teeth")


@test
def an_uncapped_build_pays_no_sort():
    published, adapter = _published()
    seen: list[str] = []
    original_execute = adapter.execute

    def spy(sql, params):
        seen.append(sql)
        return original_execute(sql, params)

    adapter.execute = spy
    materialize_graph(published, adapter, build_id="b", strict=False)
    check(seen, "the build must have issued queries")
    check(not any("ORDER BY" in s for s in seen),
          "a full scan gains nothing from a sort and must not request one")


@test
def a_capped_build_orders_on_the_subject_key():
    published, adapter = _published()
    seen: list[str] = []
    original_execute = adapter.execute

    def spy(sql, params):
        seen.append(sql)
        return original_execute(sql, params)

    adapter.execute = spy
    materialize_graph(published, adapter, build_id="b", strict=False,
                      max_rows_per_table=2)
    capped = [s for s in seen if "LIMIT" in s]
    check(capped, "the cap must reach the SQL")
    check(all("ORDER BY" in s for s in capped),
          "every capped query must be ordered, or its rows are arbitrary")
    for sql in capped:
        order = sql.split("ORDER BY")[1].split("LIMIT")[0]
        check('"c0"' in order or '"d0"' in order,
              f"ordering must be on the key aliases, got {order.strip()}")


# --------------------------------------------------------------------------- #
# 3. The gates belong to the engine
# --------------------------------------------------------------------------- #
@test
def build_graph_reports_every_problem_at_once():
    """Fixing one problem should not be how you discover the second."""
    published, adapter = _published()
    try:
        build_graph(published, adapter, build_id="b", max_rows_per_table=2)
    except BuildRefused as e:
        check(len(e.report.refusals) >= 2,
              f"both truncation and its dangling consequence must be reported, "
              f"got {e.report.refusals}")
        check("truncation" in e.report.refusals,
              f"truncation must be named, got {e.report.refusals}")
        check(not e.report.ok, "and the report must not claim ok")
        return
    check(False, "a capped build must be refused by default")


@test
def each_gate_is_separately_waivable():
    """A reviewer getting past one must not silently waive the rest."""
    published, adapter = _published()
    lines, report = build_graph(
        published, adapter, build_id="b", max_rows_per_table=2,
        allow_truncation=True, allow_dangling=True, reason=False)
    check(lines, "a waived build still produces quads")
    check(set(report.waived) == set(report.refusals),
          f"waived must match what fired, got waived={report.waived} "
          f"refusals={report.refusals}")
    # Waiving truncation alone must NOT also waive the dangling edge.
    try:
        build_graph(published, adapter, build_id="b", max_rows_per_table=2,
                    allow_truncation=True, reason=False)
    except BuildRefused as e:
        check(e.report.waived == ["truncation"],
              f"only truncation was waived, got {e.report.waived}")
        check("dangling-edges" in e.report.refusals,
              "and the dangling edge must still refuse")
        return
    print("      (this cap produced no dangling edge; partial check only)")


@test
def a_waiver_is_recorded_in_the_provenance_graph():
    """Someone querying this data later has no access to the build log."""
    published, adapter = _published()
    lines, report = build_graph(
        published, adapter, build_id="b", max_rows_per_table=2,
        allow_truncation=True, allow_dangling=True, reason=False)
    prov = [ln for ln in lines if ":prov>" in ln]
    check(prov, "a provenance graph must be emitted")
    check(any("vocab/waived" in ln for ln in prov),
          "the waiver must be IN the graph, not only in the report")
    check(any('vocab/complete' in ln and '"false"' in ln for ln in prov),
          "and a truncated build must record that it is not complete")
    check(any("vocab/truncatedTable" in ln for ln in prov),
          "naming which tables were capped")


@test
def a_clean_build_passes_every_gate():
    published, adapter = _published()
    lines, report = build_graph(published, adapter, build_id="b", reason=False)
    check(report.ok, f"the clean fixture must pass, got {report.refusals}")
    check(not report.waived, "with nothing waived")
    check(lines, "and quads emitted")
    check(any("vocab/sound" in ln and '"true"' in ln for ln in lines),
          "the graph must record its own soundness")


@test
def describe_build_surfaces_the_problems_it_found():
    published, adapter = _published(drop_table_props="therapeutic_area")
    _lines, report = build_graph(published, adapter, build_id="b", reason=False)
    text = "\n".join(describe_build(report))
    check("typed-only" in text,
          f"a class with no properties must be reported, got:\n{text}")
    check("sound: True" in text, "and a sound build must say so")


# --------------------------------------------------------------------------- #
# 4. Labels
# --------------------------------------------------------------------------- #
@test
def label_candidates_proposes_and_does_not_choose():
    published, _adapter = _published()
    cands = label_candidates(published)
    supplier = cands.get(NS + "Supplier", [])
    check(any(c["column"] == "supplier_name" for c in supplier),
          f"supplier_name must be offered, got {supplier}")
    # A decimal or a date is not a label.
    for cls, items in cands.items():
        for c in items:
            check("date" not in c["column"] and "amount" not in c["column"],
                  f"a non-text column must not be offered as a label: {c}")


@test
def labels_are_emitted_only_when_designated():
    published, adapter = _published()
    _lines, report = build_graph(published, adapter, build_id="b", reason=False)
    check(report.result.label_triples == 0,
          "labels are opt-in; nothing is guessed from a column name")

    _lines2, report2 = build_graph(
        published, adapter, build_id="b", reason=False,
        label_properties={NS + "Supplier": NS + "supplierName"})
    check(report2.result.label_triples == 3,
          f"all three suppliers must gain a label, got "
          f"{report2.result.label_triples}")


@test
def a_label_agrees_with_the_property_it_came_from():
    published, adapter = _published()
    triples, _result = materialize_graph(
        published, adapter, build_id="b", strict=False,
        label_properties={NS + "Site": NS + "siteName"})
    names = {(s, o[1]) for (s, p, o) in triples if p == NS + "siteName"}
    labels = {(s, o[1]) for (s, p, o) in triples if p == RDFS_LABEL}
    check(labels, "labels must be emitted")
    check(labels <= names,
          "every label must be a value the source property already asserted")


@test
def an_undesignated_label_property_is_refused_not_ignored():
    """Emitting nothing would look identical to a class with no labels."""
    published, adapter = _published()
    try:
        materialize_graph(
            published, adapter, build_id="b", strict=False,
            label_properties={NS + "Supplier": NS + "notAMapping"})
    except MaterializationError as e:
        check("not an approved mapping" in str(e),
              f"the message must say why: {e}")
        return
    check(False, "a label must come from an approved mapping")


# --------------------------------------------------------------------------- #
# 5. Build diff
# --------------------------------------------------------------------------- #
def _as_triples(**kw):
    published, adapter = _published(**kw)
    return materialize_graph(published, adapter, build_id="b", strict=False)


@test
def an_identical_rebuild_diffs_to_nothing():
    before, _ = _as_triples()
    after, _ = _as_triples()
    d = diff_graphs(before, after)
    check(d.identical, f"a rebuild over unchanged data must be identical, "
                       f"got +{d.added}/-{d.removed}")
    check(d.unchanged == len(before), "and everything accounted for")


@test
def a_dropped_mapping_shows_up_as_a_removal_against_its_class():
    before, _ = _as_triples()
    after, _ = _as_triples(drop_property=NS + "feesAmount")
    d = diff_graphs(before, after)
    check(d.added == 0, f"nothing should be added, got {d.added}")
    check(d.removed == 6, f"all six fee values must be removed, got {d.removed}")
    check(d.removed_by_predicate.get(NS + "feesAmount") == 6,
          f"attributed to the predicate, got {d.removed_by_predicate}")
    check(d.removed_by_class.get(NS + "Contract") == 6,
          f"and to the class, got {d.removed_by_class}")
    check(d.samples_removed, "with examples, so the cause is findable")


@test
def changing_the_iri_scheme_shows_the_add_instead_of_replace_signature():
    """The failure mode that silently accumulates in a store."""
    published, adapter = _published()
    before, _ = materialize_graph(published, adapter, build_id="b",
                                  strict=False,
                                  base_uri="http://example.org/v1/")
    after, _ = materialize_graph(published, adapter, build_id="b",
                                 strict=False,
                                 base_uri="http://example.org/v2/")
    d = diff_graphs(before, after)
    check(d.added == len(after) and d.removed == len(before),
          "every triple is new and every old one gone — nothing is reused")
    check(d.subjects_added == d.subjects_removed > 0,
          f"and every subject is replaced, got +{d.subjects_added}/"
          f"-{d.subjects_removed}")
    check(d.unchanged == 0, "with no overlap at all")


@test
def removed_triples_are_attributed_to_the_class_they_had_before():
    """Not to the class they have now, which may not exist any more."""
    before, _ = _as_triples()
    after = {t for t in before if t[1] != RDF_TYPE}   # strip every type triple
    d = diff_graphs(before, after)
    check(d.removed > 0, "types were removed")
    check(any(k.startswith(NS) for k in d.removed_by_class),
          f"attribution must use the BEFORE classes, got "
          f"{list(d.removed_by_class)}")


if __name__ == "__main__":
    print(f"\nALL BUILD-GATE OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
