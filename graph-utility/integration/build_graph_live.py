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

Per-tenant builds (docs/TAKEDA_BU_KG_DESIGN.md):

    --tenant fn-rnd --approval-profile gxp-strict --publisher "Jane Doe"
    --neo4j                      load the gated build into Neo4j (NEO4J_* env)
    --neptune                    bulk-load it into Neptune and verify (NEPTUNE_* env)
    --register <control-plane>   register each loaded copy as a DRAFT Graph Source
                                 (<id> for Neo4j, <id>-rdf for Neptune)
                                 (a human approves it in /graph)
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import graph_utility as gu
from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
from graph_utility.materialize import ANSI_DIALECT, DATABRICKS_DIALECT
from graph_utility.uc_adapter import UnityCatalogDataAdapter


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ontology", required=True, help="path to an RDF ontology document")
    ap.add_argument("--namespace", required=True, help="the ontology's own namespace")
    ap.add_argument("--catalog", default="workspace")
    ap.add_argument("--schema", default=None, help="Unity Catalog schema (or use --csv-dir)")
    ap.add_argument("--csv-dir", default=None,
                    help="build from a directory of CSV files instead of Unity Catalog "
                         "(types inferred, no keys declared: use --profile-keys/--profile-joins)")
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
    ap.add_argument("--force", action="store_true",
                    help="build even when a soundness gate fires (conflated "
                         "entities, dangling edges, broken constraints). The "
                         "waiver is recorded in the provenance graph.")
    ap.add_argument("--reason", action="store_true",
                    help="materialise entailments into <graph>:inferred and "
                         "validate constraining axioms")
    ap.add_argument("--graph-source-id", default=None,
                    help="id for the Graph Source (default <catalog>.<schema>)")
    ap.add_argument("--tenant", default=None,
                    help="owning control-plane tenant, e.g. fn-rnd (required for --neo4j)")
    ap.add_argument("--approval-profile", default="standard",
                    choices=sorted(gu.APPROVAL_PROFILES),
                    help="which auto-approval policy this tenant's data gets")
    ap.add_argument("--publisher", default=None,
                    help="the human who signs off publication; required by "
                         "profiles with require_human_publish (gxp-strict)")
    ap.add_argument("--neo4j", action="store_true",
                    help="load the gated build into Neo4j using NEO4J_URI, "
                         "NEO4J_USERNAME, NEO4J_PASSWORD, NEO4J_DATABASE")
    ap.add_argument("--neptune", action="store_true",
                    help="bulk-load the gated build into Neptune and verify it, using "
                         "NEPTUNE_ENDPOINT, NEPTUNE_S3_BUCKET, NEPTUNE_LOADER_ROLE_ARN, "
                         "AWS_REGION (see ~/neptune-setup/neptune.env)")
    ap.add_argument("--register", default=None, metavar="CONTROL_PLANE_URL",
                    help="register the loaded build as a DRAFT Neo4j Graph Source, "
                         "e.g. http://localhost:3000/proxy/3000")
    args = ap.parse_args()
    if bool(args.schema) == bool(args.csv_dir):
        print("give exactly one of --schema (Unity Catalog) or --csv-dir", file=sys.stderr)
        return 2
    if args.csv_dir:
        args.catalog, args.schema = "csv", os.path.basename(os.path.normpath(args.csv_dir))

    policy = gu.approval_policy(args.approval_profile)
    if policy.require_human_publish and not args.publisher:
        print(f"profile '{args.approval_profile}' requires --publisher: a machine may "
              f"shorten review, never sign off publication", file=sys.stderr)
        return 2
    if (args.neo4j or args.neptune or args.register) and not args.tenant:
        print("--neo4j / --neptune / --register need --tenant (the owning BU/BF)", file=sys.stderr)
        return 2
    if args.register and not (args.neo4j or args.neptune):
        print("--register needs --neo4j or --neptune: only a loaded build can be queried",
              file=sys.stderr)
        return 2

    build_id = args.build_id or f"kgb-{os.urandom(4).hex()}"
    graph_source_id = args.graph_source_id or f"{args.catalog}.{args.schema}"

    # --- 1. the ontology is an INPUT --------------------------------------- #
    source = GraphSource(
        graph_source_id=graph_source_id,
        bu=args.tenant or "demo",
        display_name=f"Ontology-first build of {args.catalog}.{args.schema}",
        ontology=OntologySource(type="rdf-file", file_path=args.ontology,
                                namespace=args.namespace),
        backend=BackendSource(type="databricks-uc", catalog=args.catalog,
                              schema=args.schema,
                              registry_table=f"{args.catalog}.{args.schema}.omda_mapping",
                              universal_join_key="n/a"),
        llm_endpoint="n/a",
        tenant_id=args.tenant,
        approval_profile=args.approval_profile,
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
    if args.csv_dir:
        from graph_utility.csv_adapter import CsvDirectoryAdapter
        adapter = CsvDirectoryAdapter.from_directory(args.csv_dir, table_filter=args.table_filter)
        dialect = ANSI_DIALECT
    else:
        adapter = UnityCatalogDataAdapter(
            catalog=args.catalog, schema=args.schema, table_filter=args.table_filter)
        dialect = DATABRICKS_DIALECT
    discovery = adapter.discover()
    keyed = [t.name for t in discovery.tables if t.primary_key()]
    unkeyed = [t.name for t in discovery.tables if not t.primary_key()]
    print(f"discovery   : {len(discovery.tables)} table(s), "
          f"{len(discovery.joins)} declared join(s)")
    print(f"  keyed     : {keyed}")
    if unkeyed:
        hint = ("--profile-keys will measure identity; owl:hasKey can declare it"
                if not args.profile_keys else "identity will be measured below")
        print(f"  UNKEYED   : {unkeyed}  (no declared key; {hint})")

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

    auto = gu.auto_approve(proposals, policy=policy)
    print(f"proposals   : {len(proposals)}  (profile {args.approval_profile})")
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
          f"set_fingerprint={published.set_fingerprint}"
          + (f", signed off by '{args.publisher}'" if args.publisher else ""))

    # --- 5-7. ONE governed build: materialise + entail + validate + gate --- #
    # The gates used to live HERE, which meant this script was safe and every
    # other caller inherited nothing. They now belong to `gu.build_graph`, so
    # the control plane and a Databricks job get the same refusals for free.
    axioms = client.list_axioms() if args.reason else None
    try:
        lines, report = gu.build_graph(
            published, adapter,
            build_id=build_id,
            axioms=axioms,
            base_uri=args.base_uri,
            # --force WAIVES each gate explicitly rather than switching strict
            # mode off: build_graph records explicit waivers in the :prov
            # graph, so a forced build stays visible to anyone querying it.
            strict=True,
            allow_conflation=args.force,
            allow_dangling=args.force,
            allow_violations=args.force,
            allow_truncation=args.force or args.max_rows_per_table is not None,
            max_rows_per_table=args.max_rows_per_table,
            table_qualifier=adapter.table_qualifier(),
            dialect=dialect,
            reason=args.reason,
        )
    except gu.BuildRefused as e:
        print(f"\nBUILD REFUSED\n{e}")
        for line in gu.describe_build(e.report):
            print(f"  {line}")
        return 1

    result = report.result
    entail_report = report.entailment
    violations = report.violations
    print("")
    for line in gu.describe_build(report):
        print(f"  {line}")
    print(f"\nTOTAL       : {len(lines)} quad(s) "
          f"({len(lines) - result.provenance_quads - report.inferred_triples} "
          f"asserted, {report.inferred_triples} inferred, "
          f"{result.provenance_quads} provenance)")

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

    if args.neptune and lines:
        if not _load_neptune(lines, build_id, result.graph_uri):
            return 1
        if args.register and not _register_neptune(args, graph_source_id, build_id, result.graph_uri):
            return 1

    if args.neo4j and lines:
        if not _load_neo4j(args, lines, graph_source_id, published):
            return 1

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


def _load_neptune(lines, build_id, graph_uri) -> bool:
    """Bulk-load the gated artifact into Neptune and verify quad counts."""
    from graph_utility.neptune_load import load_build_into_neptune

    env = {k: os.environ.get(k) for k in
           ("NEPTUNE_ENDPOINT", "NEPTUNE_S3_BUCKET", "NEPTUNE_LOADER_ROLE_ARN")}
    missing = [k for k, v in env.items() if not v]
    if missing:
        print(f"\nNEPTUNE NOT CONFIGURED: set {missing}", file=sys.stderr)
        return False
    report = load_build_into_neptune(
        lines, build_id=build_id, graph_uri=graph_uri,
        endpoint=env["NEPTUNE_ENDPOINT"], bucket=env["NEPTUNE_S3_BUCKET"],
        role_arn=env["NEPTUNE_LOADER_ROLE_ARN"],
        region=os.environ.get("AWS_REGION", "us-east-1"),
        port=int(os.environ.get("NEPTUNE_PORT", "8182")),
    )
    status = "verified" if report.verified else "MISMATCH"
    print(f"\nneptune     : {report.status} (load {report.load_id[:8]}) from {report.s3_uri}")
    for g in sorted(set(report.expected) | set(report.loaded)):
        print(f"  {g}: {report.loaded.get(g, 0)}/{report.expected.get(g, 0)} quad(s)")
    print(f"  {status}; remove with: {gu.drop_graph_sparql(graph_uri)}")
    return report.verified


def _load_neo4j(args, lines, graph_source_id, published) -> bool:
    """Load the gated artifact into Neo4j, verify it, optionally register it."""
    import hashlib
    from graph_utility.neo4j_load import (
        drop_build_cypher, plan_property_graph, write_property_graph,
    )

    env = {k: os.environ.get(k) for k in
           ("NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD", "NEO4J_DATABASE")}
    missing = [k for k in ("NEO4J_URI", "NEO4J_USERNAME", "NEO4J_PASSWORD") if not env[k]]
    if missing:
        print(f"\nNEO4J NOT CONFIGURED: set {missing}", file=sys.stderr)
        return False
    database = env["NEO4J_DATABASE"] or "neo4j"

    plan = plan_property_graph(lines)
    s = plan.summary()
    print(f"\nneo4j plan  : {s['nodes']} node(s), {s['relationships']} relationship(s) "
          f"({s['inferred_relationships']} inferred), labels {s['labels']}")
    if s["skipped_names"] or s["skipped_dangling"]:
        print(f"  skipped   : names {s['skipped_names']}, dangling {s['skipped_dangling']}")

    sha = hashlib.sha256("\n".join(lines).encode()).hexdigest()
    report = write_property_graph(
        plan, uri=env["NEO4J_URI"], username=env["NEO4J_USERNAME"],
        password=env["NEO4J_PASSWORD"], database=database,
        graph_source_id=graph_source_id, tenant_id=args.tenant,
        build_meta={
            "ontology": os.path.basename(args.ontology),
            "dataset": f"{args.catalog}.{args.schema}",
            "approval_profile": args.approval_profile,
            "publisher": args.publisher or "",
            "mapping_set_fingerprint": published.set_fingerprint,
            "artifact_sha256": sha,
        },
    )
    status = "verified" if report.verified else "COUNT MISMATCH"
    print(f"neo4j load  : {report.nodes_in_db}/{report.nodes_written} node(s), "
          f"{report.relationships_in_db}/{report.relationships_written} relationship(s) "
          f"in '{database}' — {status}")
    print(f"  remove with: {drop_build_cypher(plan.build_id)}")
    if not report.verified:
        return False

    if args.register:
        return _register(args, graph_source_id, env, database, plan.build_id)
    return True


def _register(args, graph_source_id, env, database, build_id) -> bool:
    """Register as a DRAFT Graph Source. Approval stays a human decision."""
    from urllib.parse import urlparse

    host = urlparse(env["NEO4J_URI"]).hostname or ""
    parts = host.split(".")
    allowed = ".".join(parts[1:]) if len(parts) > 3 else host
    body = {
        "op": "register",
        "source": {
            "graphSourceId": graph_source_id,
            "bu": args.tenant,
            "tenantId": args.tenant,
            "displayName": f"{graph_source_id} (ontology-first, {args.approval_profile})",
            "description": (
                f"Built by graph-utility from {os.path.basename(args.ontology)} over "
                f"{args.catalog}.{args.schema}; build {build_id}. Query nodes with "
                f"kg_source = '{graph_source_id}'."
            ),
            "ontology": {"type": "none"},
            "backend": {"type": "neo4j", "uri": env["NEO4J_URI"], "database": database,
                        "username": env["NEO4J_USERNAME"],
                        "authSecret": {"envVar": "NEO4J_PASSWORD"}},
            "llmEndpoint": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "allowedHosts": [allowed],
        },
    }
    return _post_register(args, body, graph_source_id, build_id)


def _register_neptune(args, graph_source_id, build_id, graph_uri) -> bool:
    """Register the Neptune copy as a DRAFT source scoped to this build's graphs."""
    from urllib.parse import urlparse

    endpoint = f"https://{os.environ['NEPTUNE_ENDPOINT']}:{os.environ.get('NEPTUNE_PORT', '8182')}"
    rdf_id = f"{graph_source_id}-rdf"
    body = {
        "op": "register",
        "source": {
            "graphSourceId": rdf_id,
            "bu": args.tenant,
            "tenantId": args.tenant,
            "displayName": f"{graph_source_id} on Neptune (RDF, {args.approval_profile})",
            "description": (
                f"Built by graph-utility from {os.path.basename(args.ontology)} over "
                f"{args.catalog}.{args.schema}; build {build_id}. SPARQL is scoped to "
                f"<{graph_uri}> and its :inferred graph."
            ),
            "ontology": {"type": "none"},
            "backend": {"type": "neptune", "endpoint": endpoint,
                        "namedGraphs": [graph_uri, f"{graph_uri}:inferred"]},
            "llmEndpoint": "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
            "allowedHosts": [urlparse(endpoint).hostname or ""],
        },
    }
    return _post_register(args, body, rdf_id, build_id)


def _post_register(args, body, source_id, build_id) -> bool:
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        f"{args.register.rstrip('/')}/api/graph", data=json.dumps(body).encode(),
        headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            out = json.loads(resp.read())
        print(f"registered  : Graph Source '{source_id}' as {out.get('status')} "
              f"for tenant '{args.tenant}' — approve it in /graph")
        return True
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        if e.code == 409:
            print(f"registered  : '{source_id}' already exists; build {build_id} "
                  f"is loaded alongside earlier builds")
            return True
        print(f"REGISTER FAILED {e.code}: {detail}", file=sys.stderr)
        return False


if __name__ == "__main__":
    raise SystemExit(main())
