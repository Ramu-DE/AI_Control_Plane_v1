#!/usr/bin/env python3
"""ONTOLOGY-FIRST BUILD, end to end, against live Unity Catalog.

    clinical_ontology.ttl  +  workspace.graph_demo  ->  N-Quads

This is the entrypoint the precision path never had: discover -> propose ->
auto-approve -> publish -> materialise, driven by a SUPPLIED ontology and
pointed at whatever dataset the arguments name. Nothing in it knows the
clinical schema.

    export DATABRICKS_HOST=... DATABRICKS_TOKEN=... DATABRICKS_WAREHOUSE_ID=...
    python3 integration/build_graph_live.py \
        --ontology tests/fixtures/clinical_ontology.ttl \
        --namespace 'http://example.org/ontology/ct#' \
        --catalog workspace --schema graph_demo \
        --out /tmp/clinical.nq

Exit code is non-zero if the build produced no triples, so this is usable as a
check rather than only as a demo.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import graph_utility as gu
from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
from graph_utility.materialize import DATABRICKS_DIALECT
from graph_utility.uc_adapter import UnityCatalogDataAdapter


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ontology", required=True, help="path to an RDF ontology document")
    ap.add_argument("--namespace", required=True, help="the ontology's own namespace")
    ap.add_argument("--catalog", default="workspace")
    ap.add_argument("--schema", required=True)
    ap.add_argument("--table-filter", default=None)
    ap.add_argument("--build-id", default=None)
    ap.add_argument("--base-uri", default="http://graph-utility/resource/")
    ap.add_argument("--out", default=None, help="write N-Quads here")
    ap.add_argument("--max-rows-per-table", type=int, default=None)
    ap.add_argument("--approve-deferred-as", default=None,
                    help="stand in for a human reviewer and approve what the "
                         "policy deferred (records this name as the approver)")
    ap.add_argument("--json", action="store_true", help="emit the manifest as JSON")
    ap.add_argument("--profile-keys", action="store_true",
                    help="measure column uniqueness so a table with no declared "
                         "primary key can still be keyed, honestly")
    ap.add_argument("--profile-joins", action="store_true",
                    help="measure value overlap for relationships that have no "
                         "declared foreign key, and use the result as evidence")
    ap.add_argument("--reason", action="store_true",
                    help="materialise entailments into <graph>:inferred and "
                         "validate constraining axioms")
    args = ap.parse_args()

    build_id = args.build_id or f"kgb-{os.urandom(4).hex()}"

    # --- 1. the ontology is an INPUT --------------------------------------- #
    source = GraphSource(
        graph_source_id=f"{args.catalog}.{args.schema}",
        bu="demo",
        display_name=f"Ontology-first build of {args.catalog}.{args.schema}",
        ontology=OntologySource(type="rdf-file", file_path=args.ontology,
                                namespace=args.namespace),
        backend=BackendSource(type="databricks-uc", catalog=args.catalog,
                              schema=args.schema,
                              registry_table=f"{args.catalog}.{args.schema}.omda_mapping",
                              universal_join_key="n/a"),
        llm_endpoint="n/a",
    )
    client = gu.make_ontology_client(source)
    schema = {
        "classes": client.list_classes(),
        "properties": client.list_properties(),
        "relationships": client.list_relationships(),
    }
    print(f"ontology    : {len(schema['classes'])} class(es), "
          f"{len(schema['properties'])} property row(s), "
          f"{len(schema['relationships'])} relationship(s) "
          f"from {os.path.basename(args.ontology)}")
    for w in getattr(client, "warnings", [])[:5]:
        print(f"  warning   : {w}")

    # --- 2. discover the real dataset -------------------------------------- #
    adapter = UnityCatalogDataAdapter(
        catalog=args.catalog, schema=args.schema, table_filter=args.table_filter)
    discovery = adapter.discover()
    keyed = [t.name for t in discovery.tables if t.primary_key()]
    unkeyed = [t.name for t in discovery.tables if not t.primary_key()]
    print(f"discovery   : {len(discovery.tables)} table(s), "
          f"{len(discovery.joins)} declared join(s)")
    print(f"  keyed     : {keyed}")
    if unkeyed:
        print(f"  UNKEYED   : {unkeyed}  (no declared PK -> cannot be materialised)")

    # --- 3. propose, profile, then threshold auto-approve ------------------ #
    proposals = gu.propose_mappings(discovery, schema)

    if args.profile_keys:
        proofs = gu.enrich_classes_with_uniqueness(proposals, adapter, discovery)
        adopted = [p for p in proposals
                   if p.kind == gu.ProposalKind.CLASS and p.subject_columns
                   and any(e.kind == "uniqueness-verified" for e in p.evidence)]
        print(f"key probes  : {len(proofs)} uniqueness probe(s), "
              f"{len(adopted)} class(es) keyed by measurement")
        for pr in proofs:
            mark = "OK  " if pr.proves_identity else "no  "
            print(f"  {mark}{pr.describe()}")

    if args.profile_joins:
        measurements = gu.enrich_relationships_with_overlap(proposals, adapter, discovery)
        usable = [m for m in measurements if m.supports_auto_approval]
        print(f"profiling   : {len(measurements)} overlap probe(s), "
              f"{len(usable)} usable as key evidence")
        for m in measurements:
            mark = "OK  " if m.supports_auto_approval else "no  "
            print(f"  {mark}{m.left_table}.{list(m.left_columns)} -> "
                  f"{m.right_table}.{list(m.right_columns)}: "
                  f"{m.containment * 100:.1f}% contained, "
                  f"right unique={m.right_is_unique}, {m.method}")

    auto = gu.auto_approve(proposals)
    print(f"proposals   : {len(proposals)}")
    print(f"  auto      : {len(auto.approved)} approved by policy "
          f"({auto.policy['approver']})")
    print(f"  deferred  : {len(auto.deferred)} left for a human")

    if args.approve_deferred_as:
        extra = 0
        for p in proposals:
            if p.status == gu.ProposalStatus.PROPOSED and p.is_approvable:
                gu.approve(p, args.approve_deferred_as, "approved via live build run")
                extra += 1
        print(f"  human     : {extra} additionally approved as "
              f"'{args.approve_deferred_as}'")

    # --- 4. publish (the hard gate) ---------------------------------------- #
    published = gu.publish_mappings(source.graph_source_id, proposals, strict=False)
    print(f"published   : {len(published.mappings)} mapping(s), "
          f"set_fingerprint={published.set_fingerprint}")

    # --- 5. materialise ---------------------------------------------------- #
    triples, result = gu.materialize_graph(
        published, adapter,
        build_id=build_id,
        base_uri=args.base_uri,
        strict=False,
        max_rows_per_table=args.max_rows_per_table,
        table_qualifier=adapter.table_qualifier(),
        dialect=DATABRICKS_DIALECT,
    )
    lines = gu.serialize_quads(triples, result.graph_uri)
    print(f"\nMATERIALISED: {result.quads} quad(s) into <{result.graph_uri}>")
    print(f"  instances : {result.class_instances}")
    print(f"  literals  : {result.literal_triples}")
    print(f"  edges     : {result.relationship_triples}")
    print(f"  rows read : {result.rows_read}")
    print(f"  skipped   : {result.rows_skipped_null_key} row(s) with a NULL key, "
          f"{result.null_values_skipped} NULL value(s)")
    print(f"  complete  : {result.complete}")
    if result.has_conflation:
        print(f"  CONFLATED : {result.rows_with_duplicate_key} row(s) shared a "
              f"subject key in {result.conflated_tables} — those entities were "
              f"MERGED, so the graph asserts something false")
    for s in result.skipped:
        print(f"  omitted   : {s.get('code')} — {s.get('message', '')[:120]}")

    # --- 6. reasoning + constraint validation ------------------------------ #
    entail_report = None
    violations: list = []
    if args.reason:
        axioms = client.list_axioms()
        declared = sum(len(v) for v in axioms.values())
        inferred, entail_report = gu.entail(triples, axioms)
        print(f"\nREASONING   : {declared} axiom(s) read; "
              f"{entail_report.inferred} triple(s) inferred "
              f"in {entail_report.iterations} pass(es)")
        for rule, n in sorted(entail_report.by_rule.items()):
            print(f"  {rule:24} {n}")
        if entail_report.skipped_literal_range:
            print(f"  (skipped {entail_report.skipped_literal_range} literal-range "
                  f"entailment(s): a literal cannot be a subject)")
        print(f"  complete  : {entail_report.complete}")

        violations = gu.validate_constraints(triples, axioms, inferred=inferred)
        if violations:
            print(f"\nCONSTRAINT VIOLATIONS: {len(violations)} — "
                  f"these indicate the MAPPING is wrong")
            for v in violations[:10]:
                print(f"  {v.code}: {v.subject}\n      {v.message}")
        else:
            print("  violations: none — the mapping breaches no declared constraint")

        # Inferred triples go to their OWN graph, never mixed with asserted.
        lines = lines + gu.serialize_quads(inferred, f"{result.graph_uri}:inferred")

    # --- 7. provenance, in its own graph ----------------------------------- #
    extra = {}
    if entail_report:
        extra = {
            "inferredGraph": f"{result.graph_uri}:inferred",
            "inferredCount": str(entail_report.inferred),
            "entailmentComplete": str(entail_report.complete).lower(),
            "constraintViolations": str(len(violations)),
        }
    prov = gu.provenance_quads(published, result, base_uri=args.base_uri, extra=extra)
    lines = lines + prov
    result.provenance_quads = len(prov)
    result.quads = len(lines)
    print(f"\nTOTAL       : {len(lines)} quad(s) "
          f"({result.quads - len(prov) - (entail_report.inferred if entail_report else 0)} asserted, "
          f"{entail_report.inferred if entail_report else 0} inferred, {len(prov)} provenance)")

    if args.out:
        meta = gu.write_nquads(lines, args.out)
        print(f"\nwrote {meta['lines']} line(s), {meta['bytes']} byte(s) -> {meta['path']}")
        print(f"sha256 {meta['sha256']}")
        print(f"\nload into Neptune with:\n"
              f"  aws s3 cp {args.out} s3://<bucket>/<prefix>/\n"
              f"  curl -X POST https://<neptune>:8182/loader -H 'Content-Type: application/json' \\\n"
              f"       -d '{{\"source\":\"s3://<bucket>/<prefix>/\",\"format\":\"nquads\","
              f"\"iamRoleArn\":\"<NeptuneLoadFromS3>\",\"region\":\"<region>\"}}'")
        print(f"\nremove this build later with:\n  {gu.drop_graph_sparql(result.graph_uri)}")

    if args.json:
        print("\n" + json.dumps({
            "manifest": result.to_dict(),
            "auto_approval": auto.to_dict(),
            "entailment": entail_report.to_dict() if entail_report else None,
            "violations": [v.to_dict() for v in violations],
        }, indent=2, default=str))

    if not lines:
        print("\nNO TRIPLES PRODUCED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
