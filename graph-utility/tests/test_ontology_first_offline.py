"""Offline tests for the ONTOLOGY-FIRST path: supplied ontology -> real graph.

This is the direction the project was missing. Previously an ontology could only
be read from a live Neptune endpoint, and nothing anywhere turned an approved
mapping into a graph. These tests exercise the whole chain with no network:

    clinical_ontology.ttl  (a supplied artifact, mentions no table or column)
        -> RdfFileOntologyClient         read classes/properties/relationships
        -> propose_mappings              candidates, with ontology domain used
        -> auto_approve                  threshold policy, evidence-gated
        -> publish_mappings              the existing hard gate
        -> materialize_to_nquads         REAL triples, in a per-build named graph

The dataset is the clinical-trials fixture: a composite primary key, a
many-to-many junction table, and no universal join key. Nothing in the ontology
names any part of it, which is what makes this a test of dataset-agnosticism
rather than of a coincidence.

Run: python3 tests/test_ontology_first_offline.py
"""
from __future__ import annotations

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility as gu
from graph_utility.descriptor import GraphSource, OntologySource, BackendSource
from fixtures_clinical import clinical_trial_adapter

ONTOLOGY_TTL = os.path.join(os.path.dirname(__file__), "fixtures", "clinical_ontology.ttl")
CT = "http://example.org/ontology/ct#"

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
# Helpers
# --------------------------------------------------------------------------- #
def _source(**ont_overrides) -> GraphSource:
    ont = {
        "type": "rdf-file",
        "file_path": ONTOLOGY_TTL,
        "namespace": CT,
    }
    ont.update(ont_overrides)
    return GraphSource(
        graph_source_id="clinical-trials",
        bu="rnd",
        display_name="Clinical Trials (ontology-first)",
        ontology=OntologySource(**ont),
        backend=BackendSource(type="databricks-uc", catalog="c", schema="s",
                              registry_table="c.s.reg", universal_join_key="trial_id"),
        llm_endpoint="dummy-endpoint",
    )


def _client() -> gu.RdfFileOntologyClient:
    return gu.RdfFileOntologyClient(_source())


def _schema() -> dict:
    c = _client()
    return {
        "classes": c.list_classes(),
        "properties": c.list_properties(),
        "relationships": c.list_relationships(),
    }


def _pipeline():
    """Run the full ontology-first chain, returning every intermediate."""
    adapter = clinical_trial_adapter()
    discovery = adapter.discover()
    schema = _schema()
    proposals = gu.propose_mappings(discovery, schema)
    auto = gu.auto_approve(proposals)
    published = gu.publish_mappings("clinical-trials", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, adapter, build_id="kgb-test01",
        base_uri="http://example.org/resource/", strict=False,
    )
    return adapter, discovery, schema, proposals, auto, published, lines, result


# --------------------------------------------------------------------------- #
# 1. The ontology reader
# --------------------------------------------------------------------------- #
@test
def test_reads_classes_from_a_supplied_turtle_file():
    classes = _client().list_classes()
    uris = [c["class"] for c in classes]
    for expected in ("Trial", "Investigator", "Site", "TrialSite"):
        check(CT + expected in uris, f"class {expected} must be read from the file")
    # rdfs:Class is accepted as well as owl:Class.
    check(CT + "Sponsor" in uris, "an rdfs:Class must be read, not only owl:Class")
    # Labels and comments come through.
    trial = next(c for c in classes if c["class"] == CT + "Trial")
    check(trial["label"] == "Trial", "rdfs:label must be read")
    check("interventional" in (trial["comment"] or ""), "rdfs:comment must be read")


@test
def test_meta_vocabulary_is_never_a_candidate():
    classes = [c["class"] for c in _client().list_classes()]
    check(not any("foaf" in c for c in classes),
          "foaf:Person is meta vocabulary and must be excluded")
    check(not any(c.startswith("http://www.w3.org/") for c in classes),
          "no W3C meta term may be offered as a mappable class")


@test
def test_object_and_datatype_properties_are_distinguished():
    props = _client().list_properties()
    by_uri = {p["property"]: p for p in props}
    check("object" not in by_uri[CT + "trialTitle"]["ptype"].lower(),
          "trialTitle is a datatype property")
    check("object" in by_uri[CT + "forTrial"]["ptype"].lower(),
          "forTrial is an object property; the proposer keys off this")
    # Relationships are object properties only.
    rels = {r["property"] for r in _client().list_relationships()}
    check(CT + "forTrial" in rels, "forTrial must be a relationship candidate")
    check(CT + "trialTitle" not in rels, "a datatype property is not a relationship")


@test
def test_plain_rdf_property_is_classified_by_its_range():
    c = _client()
    props = {p["property"]: p for p in c.list_properties()}
    rec = props[CT + "recordedAt"]
    check("datatype" in rec["ptype"].lower(),
          "an rdf:Property with an XSD range is a datatype property")
    check(CT + "recordedAt" not in {r["property"] for r in c.list_relationships()},
          "it must not be promoted to a relationship")


@test
def test_blank_node_domain_is_reported_not_guessed():
    c = _client()
    rels = c.list_relationships()
    spans = [r for r in rels if r["property"] == CT + "spansRegion"]
    check(len(spans) == 1, "the union-domain relationship is still listed")
    check(spans[0]["domain"] is None,
          "an owl:unionOf domain must be left unset, never collapsed to one class")
    check(any("blank node" in w for w in c.warnings),
          "the unresolvable domain must be reported in warnings")


@test
def test_missing_file_and_bad_format_fail_loudly():
    try:
        gu.RdfFileOntologyClient(_source(file_path="/nonexistent/x.ttl")).list_classes()
        check(False, "a missing ontology file must raise")
    except gu.OntologyFileError as e:
        check("not found" in str(e), "the error must say the file is missing")
    try:
        gu.infer_format(__import__("pathlib").Path("ontology.bogus"))
        check(False, "an unknown extension must raise")
    except gu.OntologyFileError as e:
        check("file_format" in str(e), "the error must name the fix")


@test
def test_absent_named_graph_fails_rather_than_widening_scope():
    # Scoping to a graph that is not in the document must not silently fall back
    # to reading the whole file.
    try:
        gu.RdfFileOntologyClient(
            _source(graph_uri="http://example.org/graph/does-not-exist")
        ).list_classes()
        check(False, "an absent named graph must raise")
    except gu.OntologyFileError as e:
        check("empty or absent" in str(e), "the error must explain the scope problem")


@test
def test_factory_routes_by_descriptor_type():
    check(isinstance(gu.make_ontology_client(_source()), gu.RdfFileOntologyClient),
          "rdf-file must route to the file client")
    # rdfox is config-only: it must say so instead of failing as a Neptune error.
    rdfox = GraphSource(
        graph_source_id="x", bu="b", display_name="RDFox source",
        ontology=OntologySource(type="rdfox", rdfox_url="https://r",
                                rdfox_datastore="d", namespace=CT),
        backend=BackendSource(type="databricks-uc", catalog="c", schema="s",
                              registry_table="t", universal_join_key="k"),
        llm_endpoint="e",
    )
    try:
        gu.make_ontology_client(rdfox)
        check(False, "rdfox must not silently construct a client")
    except NotImplementedError as e:
        check("RDFOX_assessment" in str(e), "the error must point at the assessment doc")


@test
def test_descriptor_requires_a_path_for_rdf_file():
    bad = _source()
    bad.ontology.file_path = None
    errs = bad.validate()
    check(any("file_path" in e for e in errs),
          "an rdf-file source without a path must be invalid")


# --------------------------------------------------------------------------- #
# 2. Ontology structure constrains the mapping
# --------------------------------------------------------------------------- #
@test
def test_ontology_domain_restricts_where_a_property_may_map():
    _, _, _, proposals, _, _, _, _ = _pipeline()
    # siteName's domain is Site. A candidate onto `trial` must be flagged.
    offsite = [p for p in proposals
               if p.ontology_uri == CT + "siteName" and p.target_table != "site"]
    for p in offsite:
        check(any(i.code == "domain-mismatch" for i in p.validation_issues),
              f"{p.ontology_label} -> {p.target_table} must carry domain-mismatch")
    onsite = [p for p in proposals
              if p.ontology_uri == CT + "siteName" and p.target_table == "site"
              and p.target_column == "site_name"]
    check(len(onsite) == 1, "the correct siteName -> site.site_name candidate exists")
    check(any(e.kind == "domain-consistent" for e in onsite[0].evidence),
          "the in-domain candidate must carry domain-consistent evidence")


@test
def test_partial_name_match_plus_type_match_never_auto_approves():
    # The trap: siteName ~ site_id shares one of two tokens, and both columns
    # are strings, so "name similarity + type compatibility" would approve a
    # mapping of a site's NAME onto its ID.
    _, _, _, proposals, _, _, _, _ = _pipeline()
    trap = [p for p in proposals
            if p.ontology_uri == CT + "siteName" and p.target_column == "site_id"]
    check(len(trap) >= 1, "the partial-match candidate is still proposed for review")
    for p in trap:
        # Confidence alone would clear the bar: 0.33 name + 0.25 type = 0.58.
        check(p.confidence >= gu.AUTO_APPROVE_MIN_CONFIDENCE,
              "this candidate is exactly the dangerous case: it clears the "
              "confidence floor on a one-token name overlap")
        check(any(e.kind == "type-compatibility" for e in p.evidence),
              "and it has type-compatibility, because both columns are strings")
        eligible, reason = gu.auto_approval_verdict(p)
        check(not eligible, "a partial name match must never auto-approve")
        check("partial" in reason or "domain" in reason, f"reason should explain: {reason}")
        check(p.status == gu.ProposalStatus.PROPOSED,
              "it must be left undecided for a human")
    # ...while the correct mapping, which IS an exact match, does auto-approve.
    good = next(p for p in proposals
                if p.ontology_uri == CT + "siteName" and p.target_column == "site_name"
                and p.target_table == "site")
    check(gu.was_auto_approved(good),
          "the exact, in-domain, type-matching candidate should auto-approve")


@test
def test_auto_approve_threshold_is_above_the_name_similarity_cap():
    # This is an arithmetic guarantee, not merely a policy one: a name-only
    # proposal is capped below the bar, so it cannot clear it.
    check(gu.AUTO_APPROVE_MIN_CONFIDENCE > gu.NAME_SIMILARITY_MAX_CONFIDENCE,
          "the auto-approve floor must exceed the name-similarity ceiling")


@test
def test_machine_decisions_stay_distinguishable_from_human_ones():
    _, _, _, proposals, auto, _, _, _ = _pipeline()
    approved = [p for p in proposals if p.id in auto.approved]
    check(approved, "the policy must approve something on this dataset")
    for p in approved:
        check(gu.was_auto_approved(p), f"{p.id} must be marked as a machine decision")
        check(p.approver.startswith("auto:"), "approver must carry the auto: prefix")
        check(p.notes and "auto-approved:" in p.notes,
              "a machine decision must still record a written justification")
    check(auto.deferred, "a real dataset leaves genuine candidates for a human")
    for d in auto.deferred:
        check(d["reason"], f"every deferral needs a reason: {d}")


@test
def test_blocking_issues_still_fail_closed_for_the_machine():
    _, _, _, proposals, _, _, _, _ = _pipeline()
    blocked = [p for p in proposals if p.has_blocking_issue]
    check(blocked, "the clinical ontology does produce blocked candidates")
    for p in blocked:
        eligible, reason = gu.auto_approval_verdict(p)
        check(not eligible, f"{p.id} has blocking issues and must not auto-approve")
        check("blocking" in reason, "the reason must name the blocking issues")


# --------------------------------------------------------------------------- #
# 3. Materialisation — real triples
# --------------------------------------------------------------------------- #
@test
def test_end_to_end_produces_a_graph_from_the_ontology():
    _, _, _, _, auto, published, lines, result = _pipeline()
    check(published.mappings, "the auto-approved set must publish")
    check(lines, "materialisation must emit quads")
    check(result.class_instances > 0, "instances must be typed")
    check(result.literal_triples > 0, "literal triples must be emitted")
    # Every line is a well-formed N-Quad in the build's named graph.
    for ln in lines:
        check(ln.endswith(" ."), f"N-Quads line must end with ' .': {ln[:60]}")
        check(ln.startswith("<"), "subject must be an IRI")
    check(result.graph_uri == "urn:kg:build:kgb-test01",
          "each build must own a named graph")


@test
def test_subject_iris_are_minted_from_discovered_keys_only():
    _, _, _, _, _, published, lines, _ = _pipeline()
    trial_cls = published.class_for_table("trial")
    check(trial_cls is not None, "the trial class must be published")
    check(tuple(trial_cls.subject_columns) == ("trial_id",),
          "the subject key must be the DISCOVERED primary key")
    expected = gu.mint_subject_iri("http://example.org/resource/", "trial", ["T1"])
    check(any(ln.startswith(f"<{expected}>") for ln in lines),
          f"expected a subject IRI built from the real key: {expected}")
    # No surrogate key anywhere.
    check(not any("__pk__" in ln for ln in lines), "no fabricated surrogate key")


@test
def test_composite_key_subject_uses_every_key_column():
    _, _, _, _, _, published, lines, _ = _pipeline()
    ts = published.class_for_table("trial_site")
    if ts is None:
        return  # junction class not auto-approved on this fixture; nothing to assert
    check(len(ts.subject_columns) == 2,
          "the junction table's PK is composite and must stay composite")
    iri = gu.mint_subject_iri("http://example.org/resource/", "trial_site", ["T1", "S1"])
    check(any(iri in ln for ln in lines),
          "a composite subject IRI must include both key values in order")


@test
def test_typed_literals_are_correct_and_canonical():
    lt = gu.LogicalType
    check(gu.typed_literal(120, lt.INTEGER).endswith('^^<http://www.w3.org/2001/XMLSchema#integer>'),
          "integers must be typed xsd:integer")
    check(gu.typed_literal("x", lt.STRING) == '"x"',
          "strings are plain literals in RDF 1.1")
    check(gu.typed_literal(True, lt.BOOLEAN).startswith('"true"'),
          "python True must render as the xsd lexical 'true'")
    # xsd:dateTime requires the T separator; warehouses return a space.
    out = gu.typed_literal("2024-01-02 03:04:05", lt.TIMESTAMP)
    check('"2024-01-02T03:04:05"' in out, f"timestamp must be canonicalised: {out}")
    check("dateTime" in out, "and typed xsd:dateTime")
    # Exponent form is not valid xsd:decimal, so the datatype must follow suit.
    check("double" in gu.typed_literal("1e-05", lt.DECIMAL),
          "exponent notation must be typed xsd:double, not xsd:decimal")
    check("decimal" in gu.typed_literal("1.5", lt.DECIMAL),
          "plain decimal notation stays xsd:decimal")


@test
def test_literal_escaping_is_n_quads_safe():
    out = gu.typed_literal('he said "hi"\nnext\\path\there', gu.LogicalType.STRING)
    check('\\"hi\\"' in out, "quotes must be escaped")
    check("\\n" in out and "\n" not in out[1:-1], "newlines must be escaped")
    check("\\\\path" in out, "backslashes must be escaped")
    check("\\t" in out, "tabs must be escaped")
    # A control character becomes a \\u escape rather than a raw byte.
    check("\\u0007" in gu.escape_literal("\x07"), "control chars must be \\uXXXX")


@test
def test_iri_segments_are_percent_encoded():
    iri = gu.mint_subject_iri("http://x/", "t", ["a b/c", 'q"uote'])
    for bad in (" ", '"', "<", ">", "{", "}", "|", "\\", "^", "`"):
        check(bad not in iri, f"IRI must not contain {bad!r}: {iri}")
    # The separator stays unambiguous: a slash INSIDE a value is encoded, so it
    # cannot be mistaken for the boundary between two key columns.
    check("%2F" in iri, f"a slash in a key value must be percent-encoded: {iri}")
    check(gu.iri_segment("a/b") == "a%2Fb", "segment encoding must escape slashes")
    # Two different composite keys must never collide into one IRI.
    left = gu.mint_subject_iri("http://x/", "t", ["a/b", "c"])
    right = gu.mint_subject_iri("http://x/", "t", ["a", "b/c"])
    check(left != right, "composite key segments must stay distinguishable")


@test
def test_null_keys_and_null_values_are_never_fabricated():
    # A row with a NULL subject key cannot have an IRI, and a NULL value cannot
    # have a literal. Both must be skipped and counted, not invented.
    from graph_utility.discovery import (
        ColumnMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata)
    from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable

    meta = TableMetadata(
        name="site",
        columns=(ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("site_name", LogicalType.STRING),
                 ColumnMetadata("country", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("site_id",), name="pk"),),
    )
    adapter = InMemoryDataAdapter("x", [InMemoryTable(meta, [
        {"site_id": "S1", "site_name": "North", "country": "US"},
        {"site_id": None, "site_name": "Ghost", "country": "US"},   # no identity
        {"site_id": "S3", "site_name": None, "country": "BR"},      # unknown name
    ])])
    discovery = adapter.discover()
    proposals = gu.propose_mappings(discovery, _schema())
    gu.auto_approve(proposals)
    published = gu.publish_mappings("x", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, adapter, build_id="b2",
        base_uri="http://example.org/resource/", strict=False)

    check(result.rows_skipped_null_key == 1,
          f"the keyless row must be skipped, got {result.rows_skipped_null_key}")
    check(not any("Ghost" in ln for ln in lines),
          "a row with no identity must contribute NOTHING, not a partial subject")
    check(result.null_values_skipped >= 1, "the NULL name must be counted as skipped")
    s3 = gu.mint_subject_iri("http://example.org/resource/", "site", ["S3"])
    check(any(ln.startswith(f"<{s3}>") for ln in lines), "S3 still gets its own subject")
    check(not any(ln.startswith(f"<{s3}>") and "siteName" in ln for ln in lines),
          "but NO siteName triple: absence is how RDF says 'unknown'")


@test
def test_hostile_values_round_trip_through_a_real_rdf_parser():
    """The serializer is hand-written, so prove it against an independent parser.

    Quotes, newlines, backslashes, tabs, non-ASCII and IRI-illegal characters in
    KEY values are all things a real warehouse will hand us. If any of them
    escape wrongly the artifact is either rejected by Neptune or, worse, loaded
    with silently altered values.
    """
    from graph_utility.discovery import (
        ColumnMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata)
    from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable
    try:
        from rdflib import Dataset, URIRef
    except ImportError:
        return

    nasty_name = 'He said "hello"\nthen\\left\tfast — café ☕'
    nasty_key = 'id with space/slash"quote'
    meta = TableMetadata(
        name="site",
        columns=(ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("site_name", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("site_id",), name="pk"),),
    )
    adapter = InMemoryDataAdapter("hostile", [InMemoryTable(meta, [
        {"site_id": nasty_key, "site_name": nasty_name},
    ])])
    proposals = gu.propose_mappings(adapter.discover(), _schema())
    gu.auto_approve(proposals)
    published = gu.publish_mappings("hostile", proposals, strict=False)
    lines, _ = gu.materialize_to_nquads(
        published, adapter, build_id="hostile01",
        base_uri="http://example.org/resource/", strict=False)

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "g.nq")
        gu.write_nquads(lines, path)
        ds = Dataset()
        ds.parse(source=path, format="nquads")   # raises if malformed
        values = [str(o) for _, p, o, _ in ds.quads((None, None, None, None))
                  if str(p) == CT + "siteName"]
        check(len(values) == 1, "the literal must survive the round trip exactly once")
        check(values[0] == nasty_name,
              "the value must come back byte-identical, not mangled")
        subjects = {str(s) for s, _, _, _ in ds.quads((None, None, None, None))}
        expected = gu.mint_subject_iri(
            "http://example.org/resource/", "site", [nasty_key])
        check(expected in subjects,
              "the subject IRI must round-trip despite illegal chars in the key")


@test
def test_duplicate_subject_keys_are_detected_not_silently_conflated():
    """Two rows sharing a subject key must be REPORTED, not quietly merged.

    This is not hypothetical. Unity Catalog primary keys are informational and
    unenforced, so a DECLARED key does not rule it out. When it happens the
    rows' values merge onto one subject, and the graph then asserts that a
    single site has two different names — false, rather than incomplete. The
    manifest must say so, and must not report two instances where one node
    exists.
    """
    from graph_utility.discovery import (
        ColumnMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata)
    from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable

    meta = TableMetadata(
        name="site",
        columns=(ColumnMetadata("site_id", LogicalType.STRING, nullable=False),
                 ColumnMetadata("site_name", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("site_id",), name="pk"),),
    )
    adapter = InMemoryDataAdapter("dupes", [InMemoryTable(meta, [
        {"site_id": "S1", "site_name": "North Clinic"},
        {"site_id": "S1", "site_name": "A Different Clinic"},   # same key!
    ])])
    proposals = gu.propose_mappings(adapter.discover(), _schema())
    gu.auto_approve(proposals)
    published = gu.publish_mappings("dupes", proposals, strict=False)
    lines, result = gu.materialize_graph(
        published, adapter, build_id="dupe01",
        base_uri="http://example.org/resource/", strict=False)

    check(result.rows_with_duplicate_key == 1,
          f"the repeat must be counted, got {result.rows_with_duplicate_key}")
    check(result.has_conflation, "and surfaced as conflation")
    check("site" in result.conflated_tables, "naming the table, so it can be fixed")
    check(result.class_instances == 1,
          f"ONE node exists, so one instance must be reported, not 2 — got "
          f"{result.class_instances}")
    # The damage itself is still visible in the graph: both names on one subject.
    subject = gu.mint_subject_iri("http://example.org/resource/", "site", ["S1"])
    names = [o for s, p, o in lines
             if s == subject and p == CT + "siteName"]
    check(len(names) == 2,
          "both values land on the single subject — that is the false assertion "
          "the counter exists to warn about")
    # A clean table must not be flagged.
    _, _, _, _, _, _, _, clean = _pipeline()
    check(not clean.has_conflation, "a unique-keyed build must report no conflation")


@test
def test_relationships_become_edges_between_minted_subjects():
    _, _, _, _, _, published, lines, result = _pipeline()
    rels = [m for m in published.mappings
            if m.kind == gu.ProposalKind.RELATIONSHIP.value]
    if not rels:
        return  # nothing auto-approved; covered by the explicit-approval test
    check(result.relationship_triples > 0, "edges must be emitted")
    edge_lines = [ln for ln in lines if any(r.ontology_uri in ln for r in rels)]
    for ln in edge_lines:
        # object must be an IRI, not a literal
        obj = ln.split("> ", 2)[2]
        check(obj.startswith("<"), f"a relationship object must be an IRI: {ln}")


@test
def test_relationship_edges_are_exact_on_the_junction_fixture():
    """Explicitly approve the junction relationships and count the edges.

    trial_site has 3 rows, each with an FK to trial, so forTrial must produce
    exactly 3 edges — no fan-out, no duplicates, no dropped rows.
    """
    adapter = clinical_trial_adapter()
    discovery = adapter.discover()
    proposals = gu.propose_mappings(discovery, _schema())
    for p in proposals:
        if p.kind == gu.ProposalKind.CLASS and p.is_approvable and \
                p.target_table in ("trial", "trial_site") and \
                any(e.kind == "name-exact" for e in p.evidence):
            gu.approve(p, "tester", "class approved for edge test")
        if p.kind == gu.ProposalKind.RELATIONSHIP and p.is_approvable and \
                p.ontology_uri == CT + "forTrial":
            gu.approve(p, "tester", "relationship approved for edge test")
    published = gu.publish_mappings("clinical-trials", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, adapter, build_id="b3",
        base_uri="http://example.org/resource/", strict=False)
    for_trial = [ln for ln in lines if CT + "forTrial" in ln]
    check(len(for_trial) == 3,
          f"expected exactly 3 forTrial edges (one per junction row), got {len(for_trial)}")
    check(len(set(for_trial)) == 3, "edges must be de-duplicated, not repeated")


@test
def test_strict_mode_refuses_a_table_with_no_published_class_key():
    adapter = clinical_trial_adapter()
    discovery = adapter.discover()
    proposals = gu.propose_mappings(discovery, _schema())
    # Approve ONLY a datatype property, deliberately leaving its class out.
    target = next(p for p in proposals
                  if p.kind == gu.ProposalKind.DIRECT
                  and p.ontology_uri == CT + "trialTitle"
                  and p.target_table == "trial" and p.is_approvable)
    gu.approve(target, "tester", "direct without its class, on purpose")
    published = gu.publish_mappings("clinical-trials", proposals, strict=False)
    try:
        gu.materialize_to_nquads(published, adapter, build_id="b4", strict=True)
        check(False, "strict mode must refuse to mint a subject it cannot key")
    except gu.MaterializationError as e:
        check("no published keyed CLASS" in str(e), "the error must name the cause")
    # Lenient mode omits the table and records why.
    lines, result = gu.materialize_to_nquads(
        published, adapter, build_id="b4", strict=False)
    check(result.skipped and result.skipped[0]["code"] == "no-published-class-key",
          "lenient mode must record the omission explicitly")
    check(not lines or all("trialTitle" not in ln for ln in lines),
          "the unkeyed table must contribute no triples")


@test
def test_truncation_is_reported_and_never_presented_as_complete():
    adapter = clinical_trial_adapter()
    discovery = adapter.discover()
    proposals = gu.propose_mappings(discovery, _schema())
    gu.auto_approve(proposals)
    published = gu.publish_mappings("clinical-trials", proposals, strict=False)
    _, full = gu.materialize_to_nquads(
        published, adapter, build_id="b5", strict=False)
    check(full.complete, "an uncapped build over this fixture is complete")
    _, capped = gu.materialize_to_nquads(
        published, adapter, build_id="b6", strict=False, max_rows_per_table=1)
    check(capped.truncated, "hitting the cap must be recorded")
    check(not capped.complete, "a truncated build must NOT report itself complete")


@test
def test_output_is_deterministic_and_build_scoped():
    adapter = clinical_trial_adapter()
    discovery = adapter.discover()
    props_a = gu.propose_mappings(discovery, _schema())
    gu.auto_approve(props_a)
    pub_a = gu.publish_mappings("clinical-trials", props_a, strict=False)
    lines_a, _ = gu.materialize_to_nquads(
        pub_a, adapter, build_id="same", base_uri="http://example.org/resource/",
        strict=False, include_provenance=False)

    adapter2 = clinical_trial_adapter()
    props_b = gu.propose_mappings(adapter2.discover(), _schema())
    gu.auto_approve(props_b)
    pub_b = gu.publish_mappings("clinical-trials", props_b, strict=False)
    lines_b, _ = gu.materialize_to_nquads(
        pub_b, adapter2, build_id="same", base_uri="http://example.org/resource/",
        strict=False, include_provenance=False)
    check(lines_a == lines_b, "the same inputs must give a byte-identical artifact")

    # A different build id puts the SAME data in a different graph, so two
    # builds can coexist instead of merging into each other.
    lines_c, res_c = gu.materialize_to_nquads(
        pub_a, adapter, build_id="other", base_uri="http://example.org/resource/",
        strict=False, include_provenance=False)
    check(all("urn:kg:build:other" in ln for ln in lines_c),
          "every quad must carry its own build's graph")
    check(res_c.graph_uri != "urn:kg:build:same", "graphs must differ per build")


@test
def test_provenance_lands_in_a_separate_graph():
    _, _, _, _, _, published, lines, result = _pipeline()
    prov = [ln for ln in lines if "urn:kg:build:kgb-test01:prov" in ln]
    check(len(prov) == result.provenance_quads > 0, "provenance quads must be emitted")
    check(any(published.set_fingerprint in ln for ln in prov),
          "provenance must tie the graph to the published mapping set")
    data = [ln for ln in lines if ln.endswith("<urn:kg:build:kgb-test01> .")]
    check(data, "data quads must exist")
    check(not any("prov#" in ln for ln in data),
          "provenance must not pollute the data graph")


@test
def test_drop_graph_removes_every_graph_the_build_owns():
    sparql = gu.drop_graph_sparql("urn:kg:build:x1")
    for suffix in ("", ":inferred", ":prov"):
        check(f"DROP GRAPH <urn:kg:build:x1{suffix}>" in sparql,
              f"the {suffix or 'data'} graph must be dropped, or orphans accumulate")
    from graph_utility.materialize import build_graphs
    check(len(build_graphs("g")) == 3, "a build owns exactly three graphs")


@test
def test_artifact_is_written_with_a_content_hash():
    _, _, _, _, _, _, lines, _ = _pipeline()
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "build.nq")
        meta = gu.write_nquads(lines, path)
        check(meta["lines"] == len(lines), "every line must be written")
        check(len(meta["sha256"]) == 64, "the artifact must carry a content hash")
        with open(path, "rb") as fh:
            body = fh.read()
        check(body.endswith(b"\n"), "N-Quads files are newline-terminated")
        check(meta["bytes"] == len(body), "the reported size must be the real size")


# --------------------------------------------------------------------------- #
# 4. Dataset-agnosticism
# --------------------------------------------------------------------------- #
@test
def test_identifier_quoting_is_per_dialect_and_validated():
    """Quoting is not cosmetic: Databricks parses "x" as a STRING LITERAL.

    Verified against a live SQL warehouse — `SELECT t0."site_id" ...` fails with
    PARSE_SYNTAX_ERROR there, while backticks succeed. So the dialect has to be
    an input, and a malformed identifier must be refused rather than quoted.
    """
    from graph_utility.materialize import (
        ANSI_DIALECT, DATABRICKS_DIALECT, _select_sql)

    check(ANSI_DIALECT.ident("site_id") == '"site_id"', "ANSI uses double quotes")
    check(DATABRICKS_DIALECT.ident("site_id") == "`site_id`",
          "Databricks uses backticks")
    sql = _select_sql("site", ["site_id"], dialect=DATABRICKS_DIALECT)
    check('"' not in sql, f"no double quotes may reach Databricks SQL: {sql}")
    check("`site`" in sql and "`site_id`" in sql, f"identifiers must be quoted: {sql}")

    # Anything that could reshape the statement is refused outright, including
    # a name carrying the quote character itself — escaping it would carry an
    # upstream problem into the query instead of surfacing it.
    for bad in ('drop"; --', "a\nb", "1_leading_digit", "", "sel ect;", "we`ird"):
        try:
            ANSI_DIALECT.ident(bad)
            check(False, f"unsafe identifier must be refused: {bad!r}")
        except gu.MaterializationError:
            check(True, "unsafe identifier refused")


@test
def test_nothing_in_the_ontology_names_the_dataset():
    with open(ONTOLOGY_TTL, "r", encoding="utf-8") as fh:
        text = fh.read().lower()
    # The ontology is the INPUT; it must not know the physical schema.
    for physical in ("trial_id", "site_id", "investigator_id", "enrolled_count",
                     "trial_site", "enrollment_target", "databricks", "catalog"):
        check(physical not in text,
              f"the ontology must not mention the physical name '{physical}'")


@test
def test_the_same_code_maps_a_structurally_different_dataset():
    """Swap the dataset, keep the code: a different schema must still build.

    Different table names, a different key convention (`*_code`, not `*_id`),
    and a different shape. The ontology terms are matched by the same rules, and
    whatever cannot be justified is deferred rather than guessed.
    """
    from graph_utility.discovery import (
        ColumnMetadata, KeyMetadata, KeyType, LogicalType, TableMetadata)
    from graph_utility.data_adapter import InMemoryDataAdapter, InMemoryTable

    site = TableMetadata(
        name="site",
        columns=(ColumnMetadata("site_code", LogicalType.STRING, nullable=False),
                 ColumnMetadata("site_name", LogicalType.STRING),
                 ColumnMetadata("country", LogicalType.STRING)),
        keys=(KeyMetadata(KeyType.PRIMARY, ("site_code",), name="pk_site"),),
    )
    adapter = InMemoryDataAdapter("other-dataset", [InMemoryTable(site, [
        {"site_code": "X9", "site_name": "Harbour Clinic", "country": "PT"},
    ])])
    proposals = gu.propose_mappings(adapter.discover(), _schema())
    gu.auto_approve(proposals)
    published = gu.publish_mappings("other-dataset", proposals, strict=False)
    lines, result = gu.materialize_to_nquads(
        published, adapter, build_id="other-ds",
        base_uri="http://example.org/resource/", strict=False)
    check(result.class_instances == 1, "the one row must be typed as a Site")
    # The key is `site_code`, which no rule hardcoded.
    check(any("X9" in ln for ln in lines),
          "the subject must be keyed on the discovered PK, whatever it is called")
    check(any(CT + "siteName" in ln and "Harbour Clinic" in ln for ln in lines),
          "the ontology property must map onto the differently-keyed table")


if __name__ == "__main__":
    print(f"\nALL ONTOLOGY-FIRST OFFLINE TESTS PASSED "
          f"({PASSED} assertions, {TESTS} tests)")
