"""Offline, stdlib-only tests for the PRECISION-FIRST path.

Covers (no network, no Spark, no live providers):
  - discovery metadata + bounded masked profiling
  - mapping proposals (name-similarity never auto-approves)
  - relationship/join proposals (no universal join key)
  - approval gate + publish gate (unapproved never publishes)
  - R2RML-compatible artifact + provenance
  - semantic planner: fail-closed on unmapped & ambiguous concepts
  - operator/type/fanout validation
  - compiler: quoted identifiers + NAMED params (injection safe), clamped limits
  - joins across tables with a composite FK (many-to-many fixture)
  - retrieval normalization, federation, dedupe, RRF
  - proof that NO ContractIQ assumptions leak into the clinical fixture

Run: python3 tests/test_precision_offline.py
"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

import graph_utility as gu
from fixtures_clinical import (
    clinical_trial_adapter,
    clinical_trial_ontology,
    abstract_retriever,
    abstract_field_mapping,
    abstract_records,
    CONTRACTIQ_COLUMNS,
    CONTRACTIQ_TABLES,
)


PASSED = 0


def check(cond, msg):
    global PASSED
    assert cond, "FAIL: " + msg
    PASSED += 1


# --------------------------------------------------------------------------- #
def _approve_directs(props, cols, tables):
    for p in props:
        if (p.kind == gu.ProposalKind.DIRECT and p.target_column in cols
                and p.target_table in tables and p.is_approvable):
            gu.approve(p, "tester", "reviewed in offline test")


def _approve_class(props, table):
    """Approve the best (highest-confidence approvable) CLASS proposal whose
    target_table matches `table`, so R2RML can mint a keyed subject template."""
    cands = [p for p in props if p.kind == gu.ProposalKind.CLASS
             and p.target_table == table and p.is_approvable]
    if cands:
        best = max(cands, key=lambda p: p.confidence)
        gu.approve(best, "tester", "class reviewed in offline test")
        return best
    return None


def _publish_decided(source_id, props):
    """Publish the completed decisions selected for this test's review scope."""
    decided = [p for p in props if p.status != gu.ProposalStatus.PROPOSED]
    return gu.publish_mappings(source_id, decided)


# --------------------------------------------------------------------------- #
def test_discovery_and_profiling():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    names = {t.name for t in disc.tables}
    check(names == {"trial", "investigator", "site", "trial_site"},
          f"discovered tables wrong: {names}")

    ts = disc.table("trial_site")
    pk = ts.primary_key()
    check(pk is not None and pk.columns == ("trial_id", "site_id"),
          "composite PK not discovered on trial_site")
    fks = [k for k in ts.keys if k.key_type == gu.KeyType.FOREIGN]
    check(len(fks) == 3, f"expected 3 FKs on trial_site, got {len(fks)}")

    # profiling is bounded + masked
    prof = disc.profile("trial_site")
    check(prof.row_estimate == 3, "row estimate wrong")
    ec = prof.profile("enrolled_count")
    check(len(ec.masked_samples) <= gu.MAX_SAMPLE_VALUES, "sample cap exceeded")
    for s in ec.masked_samples:
        check(s.startswith("<") and s.endswith(">"), f"raw value leaked: {s}")
    # a numeric value must not appear verbatim
    check("40" not in "".join(ec.masked_samples), "raw numeric leaked into profile")

    # mask_value never returns raw content
    check(gu.mask_value("Dr Reyes") == gu.mask_value("Dr Reyes"), "mask not deterministic")
    check("Reyes" not in gu.mask_value("Dr Reyes"), "mask leaked raw text")


def test_proposals_name_similarity_never_approves():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    check(all(p.status == gu.ProposalStatus.PROPOSED for p in props),
          "proposals must start as PROPOSED")

    # Every purely name-similarity proposal carries a warning and low confidence.
    name_only = [p for p in props
                 if any(e.kind == "name-similarity" for e in p.evidence)
                 and not any(e.kind == "type-compatibility" for e in p.evidence)]
    check(name_only, "expected some name-only proposals")
    for p in name_only:
        check(p.confidence < 0.9, "name-only proposal must not reach high confidence")
        check(any(i.code == "name-similarity-only" for i in p.validation_issues),
              "name-only proposal missing review warning")

    # IDs, versions, fingerprints present
    for p in props:
        check(p.id and p.mapping_version and p.proposal_fingerprint and p.source_fingerprint,
              "proposal missing id/version/fingerprints")


def test_relationship_join_no_universal_key():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    ns = "http://example.org/ontology/ct#"
    onto = {
        "classes": [{"class": ns + "Site", "label": "Site"},
                    {"class": ns + "TrialSite", "label": "Trial Site"}],
        "properties": [
            {"property": ns + "siteName", "label": "Site Name", "domain": ns + "Site",
             "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "enrolledCount", "label": "Enrolled Count",
             "domain": ns + "TrialSite", "range": "xsd:integer", "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [
            {"property": ns + "atSite", "label": "at site",
             "domain": ns + "TrialSite", "range": ns + "Site"},
        ],
    }
    props = gu.propose_mappings(disc, onto)
    rels = [p for p in props if p.kind == gu.ProposalKind.RELATIONSHIP]
    check(rels, "no relationship proposal produced")
    rel = rels[0]
    check(rel.join is not None, "relationship join not derived from keys")
    # join came from the composite FK (site_id), NOT a universal key.
    check(rel.join.left_columns == ("site_id",) and rel.join.origin == "discovered",
          f"join not derived from discovered FK: {rel.join.to_dict()}")
    check("contract_key" not in json.dumps(rel.join.to_dict()),
          "universal join key leaked into clinical join")


def test_approval_and_publish_gate():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())

    # Nothing decided yet -> strict publication fails closed.
    try:
        gu.publish_mappings("clinical-trials", props)
        check(False, "undecided proposals must block strict publication")
    except gu.UnapprovedPublishError:
        check(True, "")

    # Approve two direct mappings and explicitly reject one other candidate.
    _approve_directs(props, {"trial_title", "phase"}, {"trial"})
    rejected = next(p for p in props if p.status == gu.ProposalStatus.PROPOSED)
    gu.reject(rejected, "tester", "not part of this published semantic view")
    pub = _publish_decided("clinical-trials", props)
    check(all(m.proposal_id != rejected.id for m in pub.mappings),
          "rejected proposal must be excluded from publication")
    check(len(pub.mappings) == 2, f"expected 2 published, got {len(pub.mappings)}")
    check(all(m.approver == "tester" for m in pub.mappings), "provenance approver missing")
    check(pub.set_fingerprint and pub.source_fingerprint, "published set missing fingerprints")

    # A completed review containing only rejected mappings cannot publish an
    # empty runtime registry.
    only_rejected = gu.MappingProposal(
        id="reject-only", kind=gu.ProposalKind.DIRECT,
        ontology_uri="urn:test:r", ontology_label="Rejected",
        ontology_type="datatype-property", target_table="trial",
        target_column="phase", logical_type=gu.LogicalType.STRING)
    gu.reject(only_rejected, "tester", "intentionally excluded")
    try:
        gu.publish_mappings("clinical-trials", [only_rejected])
        check(False, "all-rejected review must not publish an empty set")
    except gu.UnapprovedPublishError:
        check(True, "")

    # A blocking (type-mismatch) proposal cannot be approved.
    blocked = None
    for p in props:
        if p.has_blocking_issue:
            blocked = p
            break
    if blocked:
        try:
            gu.approve(blocked, "tester", "attempting to approve a blocking proposal")
            check(False, "approving a blocking proposal must fail closed")
        except ValueError:
            check(True, "")

    # Force a status=APPROVED but with a blocking issue -> publish must refuse.
    hack = gu.MappingProposal(
        id="x1", kind=gu.ProposalKind.DIRECT, ontology_uri="u", ontology_label="X",
        ontology_type="datatype-property", target_table="trial", target_column="phase",
        validation_issues=[gu.ValidationIssue("boom", "bad", "error")],
        status=gu.ProposalStatus.APPROVED)
    try:
        gu.publish_mappings("clinical-trials", [hack])
        check(False, "publish must refuse an approved-but-invalid proposal")
    except gu.UnapprovedPublishError:
        check(True, "")


def test_r2rml_artifact_and_provenance():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    _approve_directs(props, {"trial_title", "phase"}, {"trial"})
    # A keyed CLASS mapping for 'trial' must be published so direct mappings can
    # emit a precise, surrogate-free subject template.
    cls = _approve_class(props, "trial")
    check(cls is not None and cls.subject_columns == ("trial_id",),
          "trial class proposal missing discovered subject key")
    pub = _publish_decided("clinical-trials", props)
    # The published class preserves class URI + subject columns.
    pub_cls = pub.class_for_table("trial")
    check(pub_cls is not None and pub_cls.ontology_uri == cls.ontology_uri
          and tuple(pub_cls.subject_columns) == ("trial_id",),
          "published class did not preserve URI/subject columns")
    r2rml = gu.to_r2rml(pub)
    check(r2rml["@type"] == "r2rml:MappingDocument", "not an R2RML doc")
    check(r2rml["triplesMaps"], "no triples maps")
    tm = next(t for t in r2rml["triplesMaps"] if t["logicalTable"]["tableName"] == "trial")
    check(tm["logicalTable"]["tableName"] == "trial", "logical table wrong")
    # No fabricated __pk__ surrogate; subject template uses the discovered key
    # and carries the class URI.
    check("__pk__" not in json.dumps(r2rml), "fake __pk__ surrogate leaked into R2RML")
    check("{trial_id}" in tm["subjectMap"]["template"], "subject template not keyed on discovered PK")
    check(tm["subjectMap"]["class"] == cls.ontology_uri, "subject map class URI not preserved")
    check(tm["subjectMap"]["subjectColumns"] == ["trial_id"], "subject columns not carried")
    pom = tm["predicateObjectMaps"][0]
    check("provenance" in pom and pom["provenance"]["approver"] == "tester",
          "provenance missing from R2RML pom")
    # The object map carries the discovered logical type (type authority).
    check("logicalType" in pom["objectMap"], "object map missing logical type")
    check(r2rml["provenance"]["set_fingerprint"] == pub.set_fingerprint,
          "set fingerprint not propagated to artifact")

    # Fail-closed: a direct mapping for a table with NO published keyed class
    # must not masquerade as precise.
    disc2 = clinical_trial_adapter().discover()
    props2 = gu.propose_mappings(disc2, clinical_trial_ontology())
    _approve_directs(props2, {"site_name"}, {"site"})   # approve direct, NOT the class
    pub2 = _publish_decided("clinical-trials", props2)
    try:
        gu.to_r2rml(pub2)
        check(False, "to_r2rml must fail closed without a published keyed class")
    except gu.R2RMLError:
        check(True, "")
    # Non-strict mode omits the table and records an explicit error instead.
    doc2 = gu.to_r2rml(pub2, strict=False)
    check(any(e["table"] == "site" and e["code"] == "no-published-class-key"
              for e in doc2.get("errors", [])),
          "non-strict r2rml did not record an explicit omission error")
    check(all(t["logicalTable"]["tableName"] != "site" for t in doc2["triplesMaps"]),
          "unkeyed table wrongly emitted a triples map")


def test_planner_fail_closed_unmapped_and_ambiguous():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    _approve_directs(props, {"phase"}, {"trial"})
    pub = _publish_decided("clinical-trials", props)
    planner = gu.SemanticPlanner(pub)

    # unmapped
    try:
        planner.plan(["Totally Unknown Concept"])
        check(False, "planner must fail closed on unmapped concept")
    except gu.UnmappedConceptError:
        check(True, "")

    # ambiguity: craft two approved published mappings for the same label, diff cols
    amb = gu.PublishedMappingSet(
        source_id="s", mapping_version="1.0", source_fingerprint="f", set_fingerprint="g",
        mappings=[
            gu.PublishedMapping("u", "Dup", "direct", "trial", "trial_title", None, 0.9,
                                "a", "fp1", "t", None),
            gu.PublishedMapping("u", "Dup", "direct", "site", "site_name", None, 0.9,
                                "b", "fp2", "t", None),
        ])
    try:
        gu.SemanticPlanner(amb).plan(["Dup"])
        check(False, "planner must fail closed on ambiguity")
    except gu.AmbiguousConceptError:
        check(True, "")


def test_operator_and_type_validation():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    _approve_directs(props, {"trial_title", "enrolled_count"}, {"trial", "trial_site"})
    pub = _publish_decided("clinical-trials", props)
    planner = gu.SemanticPlanner(pub)

    # SUM on a text column fails closed
    try:
        planner.plan(["Trial Title"], aggregate=gu.AggKind.SUM)
        check(False, "SUM on non-numeric must fail closed")
    except gu.PlanningError:
        check(True, "")

    # SUM on numeric measure OK
    plan = planner.plan(["Enrolled Count"], aggregate=gu.AggKind.SUM)
    comp = gu.SqlCompiler().compile(plan)
    check("SUM(" in comp.sql, "SUM not compiled")
    # The plan carries mapping provenance (version + set fingerprint).
    check(plan.mapping_version == pub.mapping_version and plan.mapping_version,
          "plan missing mapping_version")
    check(plan.set_fingerprint == pub.set_fingerprint and plan.set_fingerprint,
          "plan missing set_fingerprint")
    pd = plan.to_dict()
    check(pd["mapping_version"] == pub.mapping_version
          and pd["set_fingerprint"] == pub.set_fingerprint,
          "plan.to_dict missing provenance fields")


def _type_authority_fixture():
    """A schema that DEFEATS column-name heuristics on purpose:

      - 'x'            : an INTEGER measure with a non-measure-looking name
      - 'total_amount' : a STRING column whose name screams 'numeric'

    Discovered logical types are the ONLY authority. A planner that looked at
    names would (wrongly) SUM 'total_amount' and refuse to SUM 'x'.
    """
    tbl = gu.TableMetadata(
        name="t",
        columns=(
            gu.ColumnMetadata("pk", gu.LogicalType.STRING, nullable=False),
            gu.ColumnMetadata("x", gu.LogicalType.INTEGER),
            gu.ColumnMetadata("total_amount", gu.LogicalType.STRING),
        ),
        keys=(gu.KeyMetadata(gu.KeyType.PRIMARY, ("pk",), name="pk_t"),),
    )
    ad = gu.InMemoryDataAdapter(
        source_id="type-authority",
        tables=[gu.InMemoryTable(tbl, [
            {"pk": "A", "x": 10, "total_amount": "USD-100"},
            {"pk": "B", "x": 20, "total_amount": "USD-200"},
        ])],
    )
    ns = "http://example.org/ontology/ta#"
    onto = {
        "classes": [{"class": ns + "T", "label": "T"}],
        "properties": [
            {"property": ns + "x", "label": "X", "domain": ns + "T",
             "range": "xsd:integer", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "totalAmount", "label": "Total Amount",
             "domain": ns + "T", "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [],
    }
    return ad, onto


def test_type_authority_metadata_not_column_name():
    ad, onto = _type_authority_fixture()
    disc = ad.discover()
    props = gu.propose_mappings(disc, onto)

    # Proposals must carry the DISCOVERED logical type verbatim.
    by_col = {p.target_column: p for p in props if p.kind == gu.ProposalKind.DIRECT}
    check(by_col["x"].logical_type == gu.LogicalType.INTEGER,
          "numeric column 'x' lost its discovered INTEGER type")
    check(by_col["total_amount"].logical_type == gu.LogicalType.STRING,
          "text column 'total_amount' wrongly typed (name heuristic leaked)")

    _approve_directs(props, {"x", "total_amount"}, {"t"})
    pub = _publish_decided("type-authority", props)
    # Published mappings preserve the discovered type.
    pub_by_col = {m.target_column: m for m in pub.mappings if m.kind == "direct"}
    check(pub_by_col["x"].logical_type == gu.LogicalType.INTEGER.value, "published x type wrong")
    check(pub_by_col["total_amount"].logical_type == gu.LogicalType.STRING.value,
          "published total_amount type wrong")

    planner = gu.SemanticPlanner(pub)

    # SUM on numeric 'x' is permitted by METADATA even though its name doesn't
    # look like a measure.
    plan = planner.plan(["X"], aggregate=gu.AggKind.SUM)
    check("SUM(" in gu.SqlCompiler().compile(plan).sql, "SUM on numeric 'x' refused")

    # SUM on 'total_amount' is REFUSED despite the measure-y name, because its
    # discovered type is STRING.
    try:
        planner.plan(["Total Amount"], aggregate=gu.AggKind.SUM)
        check(False, "SUM on text 'total_amount' must fail (name heuristic must not win)")
    except gu.PlanningError:
        check(True, "")

    # ILIKE is valid on the text column 'total_amount' ...
    fplan = planner.plan(["Total Amount"],
                         filters=[gu.ConceptRef("Total Amount", is_filter=True,
                                                filter_op=gu.FilterOp.ILIKE, filter_value="USD")])
    check("ILIKE" in gu.SqlCompiler().compile(fplan).sql, "ILIKE on text column refused")

    # ... but ILIKE on the numeric column 'x' is REFUSED (type authority again).
    try:
        planner.plan(["X"], filters=[gu.ConceptRef("X", is_filter=True,
                                                   filter_op=gu.FilterOp.ILIKE, filter_value="1")])
        check(False, "ILIKE on numeric 'x' must fail closed")
    except gu.PlanningError:
        check(True, "")


def test_fanout_many_to_many_guard():
    # A many-to-many published join must be refused by the planner.
    m2m = gu.JoinMetadata("a", ("x",), "b", ("y",), cardinality="many-to-many",
                          origin="discovered", name="m2m")
    pub = gu.PublishedMappingSet(
        source_id="s", mapping_version="1.0", source_fingerprint="f", set_fingerprint="g",
        mappings=[
            gu.PublishedMapping("u1", "AName", "direct", "a", "col_a", None, 0.9, "p1", "f1", "t", None),
            gu.PublishedMapping("u2", "BName", "direct", "b", "col_b", None, 0.9, "p2", "f2", "t", None),
            gu.PublishedMapping("r", "rel", "relationship", None, None, m2m.to_dict(), 0.6, "p3", "f3", "t", None),
        ])
    try:
        gu.SemanticPlanner(pub).plan(["AName", "BName"])
        check(False, "many-to-many join must be refused (fail closed)")
    except gu.PlanningError:
        check(True, "")


def test_compiler_injection_safe_and_clamped():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    _approve_directs(props, {"site_name", "country"}, {"site"})
    pub = _publish_decided("clinical-trials", props)
    planner = gu.SemanticPlanner(pub)

    evil = "US'; DROP TABLE site; --"
    plan = planner.plan(["Site Name"],
                        filters=[gu.ConceptRef("Country", is_filter=True, filter_value=evil)],
                        limit=10_000)
    comp = gu.SqlCompiler().compile(plan)
    check("DROP TABLE" not in comp.sql, "injection string leaked into SQL")
    check(":p0" in comp.sql, "named parameter marker missing")
    check(comp.parameters["p0"] == f"%{evil}%", "value not bound to parameter")
    # limit clamped to MAX_LIMIT
    check(f"LIMIT {gu.SemanticPlanner.MAX_LIMIT}" in comp.sql, "limit not clamped")
    # identifiers are quoted
    check('"site_name"' in comp.sql and '"country"' in comp.sql, "identifiers not quoted")

    # executes safely against the fixture (0 rows, no error)
    res = ad.execute(comp.sql, comp.parameters)
    check(res.row_count == 0, "evil filter should match nothing")

    # a bad identifier is rejected by the compiler
    try:
        gu.SqlCompiler()._qualified('bad"; drop')
        check(False, "compiler must reject invalid identifier")
    except gu.CompileError:
        check(True, "")


def test_join_across_composite_fk():
    ad = clinical_trial_adapter()
    disc = ad.discover()
    ns = "http://example.org/ontology/ct#"
    onto = {
        "classes": [{"class": ns + "Site", "label": "Site"},
                    {"class": ns + "TrialSite", "label": "Trial Site"}],
        "properties": [
            {"property": ns + "siteName", "label": "Site Name", "domain": ns + "Site",
             "range": "xsd:string", "ptype": "owl:DatatypeProperty"},
            {"property": ns + "enrolledCount", "label": "Enrolled Count",
             "domain": ns + "TrialSite", "range": "xsd:integer", "ptype": "owl:DatatypeProperty"},
        ],
        "relationships": [
            {"property": ns + "atSite", "label": "at site",
             "domain": ns + "TrialSite", "range": ns + "Site"},
        ],
    }
    props = gu.propose_mappings(disc, onto)
    _approve_directs(props, {"site_name", "enrolled_count"}, {"site", "trial_site"})
    for p in props:
        if p.kind == gu.ProposalKind.RELATIONSHIP and p.join and p.is_approvable:
            gu.approve(p, "tester", "join reviewed in offline test")
    pub = _publish_decided("clinical-trials", props)
    plan = gu.SemanticPlanner(pub).plan(["Site Name", "Enrolled Count"])
    comp = gu.SqlCompiler().compile(plan)
    check("LEFT JOIN" in comp.sql, "join not compiled")
    rows = ad.execute(comp.sql, comp.parameters).rows
    check(len(rows) == 2, f"expected 2 joined rows, got {len(rows)}")
    check(all("Site_Name" in r and "Enrolled_Count" in r for r in rows), "join projection wrong")


def test_retrieval_normalization_federation_dedupe_rrf():
    r = abstract_retriever()
    caps = r.capabilities()
    check(caps.supports_filters, "retriever caps missing")

    req = gu.RetrievalRequest(query="oncology trial enrollment", top_k=3)
    passages = r.retrieve(req)
    check(passages and all(isinstance(p, gu.Passage) for p in passages), "no passages")
    # field mapping is descriptor-driven: normalized fields, renamed metadata
    top = passages[0]
    check(top.id and top.text and top.source == "abstracts", "passage not normalized")
    check("trial" in top.metadata, "metadata rename (trial_id->trial) not applied")

    # NO ContractIQ columns anywhere in the mapping or metadata
    fm = abstract_field_mapping().to_dict()
    blob = json.dumps(fm) + json.dumps([p.to_dict() for p in passages])
    for col in CONTRACTIQ_COLUMNS:
        check(col not in blob, f"ContractIQ column '{col}' leaked into retrieval")

    # filter support
    freq = gu.RetrievalRequest(query="trial", top_k=5, filters={"country": "US"})
    fres = r.retrieve(freq)
    check(all(p.metadata.get("country") == "US" for p in fres), "filter not applied")

    # federation + dedupe + RRF across two retrievers
    r2 = abstract_retriever("abstracts-2")
    lists = gu.federate([r, r2], req)
    check(len(lists) == 2, "federation did not return 2 lists")
    merged = [p for lst in lists for p in lst]
    deduped = gu.dedupe(merged)
    check(len(deduped) <= len(merged), "dedupe grew the list")
    # identical ids across the two retrievers collapse
    check(len({p.id for p in deduped}) == len(deduped), "dedupe left duplicate ids")
    fused = gu.rrf_fuse(lists, top_k=3)
    check(fused and all(p.source == "rrf" for p in fused), "RRF fusion failed")
    check(len(fused) <= 3, "RRF top_k not respected")


def test_no_contractiq_assumptions_in_clinical_path():
    """End-to-end on the clinical fixture must never reference ContractIQ."""
    ad = clinical_trial_adapter()
    disc = ad.discover()
    props = gu.propose_mappings(disc, clinical_trial_ontology())
    _approve_directs(props, {"trial_title", "phase", "enrolled_count", "site_name", "country"},
                     {"trial", "trial_site", "site"})
    pub = _publish_decided("clinical-trials", props)

    blob = json.dumps(disc.to_dict()) + json.dumps([p.to_dict() for p in props]) \
        + json.dumps(pub.to_dict())
    for col in CONTRACTIQ_COLUMNS:
        check(col not in blob, f"ContractIQ column '{col}' leaked into clinical path")
    for tbl in CONTRACTIQ_TABLES:
        check(tbl not in blob, f"ContractIQ table '{tbl}' leaked into clinical path")

    plan = gu.SemanticPlanner(pub).plan(["Trial Title", "Phase"])
    comp = gu.SqlCompiler().compile(plan)
    for col in CONTRACTIQ_COLUMNS | CONTRACTIQ_TABLES:
        check(col not in comp.sql, f"ContractIQ token '{col}' leaked into compiled SQL")
    # and there is NO universal 'contract_key' join assumption
    check("contract_key" not in comp.sql, "universal join key leaked into clinical SQL")


def test_descriptor_no_default_contractiq_join_key():
    """A generic descriptor must NOT silently inherit ContractIQ's join key.

    The legacy databricks-uc engine needs a single join key, so it must be set
    EXPLICITLY (fail-closed) — never defaulted to 'contract_key'.
    """
    # Default is empty — no tenant's join key is inherited.
    check(gu.BackendSource(type="databricks-uc").universal_join_key == "",
          "BackendSource still defaults universal_join_key to a value")

    # A databricks-uc source that omits the join key fails validation loudly.
    missing = gu.GraphSource(
        graph_source_id="bu-y", bu="bu-y", display_name="BU Y",
        ontology=gu.OntologySource(type="neptune", sparql_url="https://x:8182/sparql",
                                   graph_uri="http://g", namespace="y#"),
        backend=gu.BackendSource(type="databricks-uc", catalog="c", schema="s",
                                 registry_table="c.s.t"),
        llm_endpoint="llm",
    )
    errs = missing.validate()
    check(any("universal_join_key" in e for e in errs),
          "missing universal_join_key not flagged for databricks-uc")

    # Set explicitly -> valid; the value is this source's own key, not inherited.
    ok = gu.GraphSource(
        graph_source_id="bu-y", bu="bu-y", display_name="BU Y",
        ontology=gu.OntologySource(type="neptune", sparql_url="https://x:8182/sparql",
                                   graph_uri="http://g", namespace="y#"),
        backend=gu.BackendSource(type="databricks-uc", catalog="c", schema="s",
                                 registry_table="c.s.t", universal_join_key="study_id"),
        llm_endpoint="llm",
    )
    check(ok.validate() == [], "explicit join key should validate clean")
    check(ok.backend.universal_join_key == "study_id", "join key not preserved")

    # A non-UC backend (precision/future seam) never needs the legacy key.
    warehouse = gu.GraphSource(
        graph_source_id="bu-z", bu="bu-z", display_name="BU Z",
        ontology=gu.OntologySource(type="none"),
        backend=gu.BackendSource(type="warehouse", registry_table="c.s.t"),
        llm_endpoint="llm",
    )
    check(all("universal_join_key" not in e for e in warehouse.validate()),
          "non-UC backend wrongly required a universal join key")


def main() -> int:
    tests = [
        test_discovery_and_profiling,
        test_proposals_name_similarity_never_approves,
        test_relationship_join_no_universal_key,
        test_approval_and_publish_gate,
        test_r2rml_artifact_and_provenance,
        test_planner_fail_closed_unmapped_and_ambiguous,
        test_operator_and_type_validation,
        test_type_authority_metadata_not_column_name,
        test_fanout_many_to_many_guard,
        test_compiler_injection_safe_and_clamped,
        test_join_across_composite_fk,
        test_retrieval_normalization_federation_dedupe_rrf,
        test_no_contractiq_assumptions_in_clinical_path,
        test_descriptor_no_default_contractiq_join_key,
    ]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\nALL PRECISION OFFLINE TESTS PASSED ({PASSED} assertions, {len(tests)} tests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
