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

    # --- 3. propose + threshold auto-approve ------------------------------- #
    proposals = gu.propose_mappings(discovery, schema)
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
    lines, result = gu.materialize_to_nquads(
        published, adapter,
        build_id=build_id,
        base_uri=args.base_uri,
        strict=False,
        max_rows_per_table=args.max_rows_per_table,
        table_qualifier=adapter.table_qualifier(),
        dialect=DATABRICKS_DIALECT,
    )
    print(f"\nMATERIALISED: {result.quads} quad(s) into <{result.graph_uri}>")
    print(f"  instances : {result.class_instances}")
    print(f"  literals  : {result.literal_triples}")
    print(f"  edges     : {result.relationship_triples}")
    print(f"  rows read : {result.rows_read}")
    print(f"  skipped   : {result.rows_skipped_null_key} row(s) with a NULL key, "
          f"{result.null_values_skipped} NULL value(s)")
    print(f"  complete  : {result.complete}")
    for s in result.skipped:
        print(f"  omitted   : {s.get('code')} — {s.get('message', '')[:120]}")

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
        }, indent=2, default=str))

    if not lines:
        print("\nNO TRIPLES PRODUCED", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
