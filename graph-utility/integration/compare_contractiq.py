#!/usr/bin/env python3
"""Compare metadata-only vs measured-evidence mapping on ContractIQ.

Two modes, same code, so the offline numbers and the live numbers are
comparable:

    # offline: the ContractIQ-shaped fixture with its traps and ground truth
    python integration/compare_contractiq.py

    # live Unity Catalog: the real tables
    export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
    export DATABRICKS_TOKEN=<pat>
    export DATABRICKS_WAREHOUSE_ID=<warehouse>
    python integration/compare_contractiq.py \
        --catalog usdev_corp --schema corp_us_mart \
        --ontology graph_sources/contract-iq-ontology.ttl \
        --truth path/to/truth.json

LIVE MODE NEEDS GROUND TRUTH, and will refuse without it. There is no way to
score a mapping against a schema nobody has labelled: the arms would simply
disagree, with no basis for calling either one right. Supplying `--truth`
is the only honest way to get a precision number, and `--no-truth` is offered
for the weaker question — how much each arm automates, with correctness left
unknown.

Read-only against Unity Catalog: discovery reads information_schema, and the
measurement path issues COUNT/COUNT DISTINCT aggregates. Nothing is written.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))

from graph_utility.compare import LLM_CAVEAT, compare  # noqa: E402
from graph_utility.ontobricks import NEO4J, NEPTUNE, ONTOBRICKS  # noqa: E402


def _fmt(value: float | None) -> str:
    return "  n/a" if value is None else f"{value * 100:5.1f}%"


def _print_report(c, label: str, truth_known: bool) -> None:
    print(f"\n{'=' * 72}")
    print(f"MAPPING COMPARISON — {label}")
    print(f"{'=' * 72}")
    rows = [("metadata-only (names/types/declared keys)", c.metadata),
            ("measured-evidence (+ uniqueness, overlap)", c.measured)]

    if truth_known:
        print(f"\n{'arm':44} {'appr':>5} {'ok':>4} {'WRONG':>6} {'miss':>5} "
              f"{'prec':>7} {'recall':>7} {'probes':>7}")
        print("-" * 96)
        for name, a in rows:
            print(f"{name:44} {a.approved:5} {len(a.approved_correct):4} "
                  f"{len(a.approved_wrong):6} {len(a.missed):5} "
                  f"{_fmt(a.precision):>7} {_fmt(a.recall):>7} "
                  f"{a.measurements.get('profile_queries', 0):7}")
        print(f"\n(ground truth: {c.truth_size} ontology terms)")
    else:
        print(f"\n{'arm':44} {'proposed':>9} {'auto-approved':>14} {'probes':>7}")
        print("-" * 78)
        for name, a in rows:
            print(f"{name:44} {a.proposed:9} {a.approved:14} "
                  f"{a.measurements.get('profile_queries', 0):7}")
        print("\nNo ground truth supplied, so these are AUTOMATION RATES ONLY — "
              "they say\nnothing about whether a mapping is correct. Pass "
              "--truth to score precision.")

    traps = c.by_trap()
    if traps and truth_known:
        print("\nPer-trap (what each case tests):")
        from fixtures_contractiq import TRAP_NOTES
        for trap in sorted(traps):
            m = traps[trap].get("metadata", {})
            s = traps[trap].get("measured", {})
            print(f"  {trap}  metadata ok={m.get('correct',0)} "
                  f"wrong={m.get('wrong',0)} miss={m.get('missed',0)}   |   "
                  f"measured ok={s.get('correct',0)} wrong={s.get('wrong',0)} "
                  f"miss={s.get('missed',0)}")
            note = TRAP_NOTES.get(trap)
            if note:
                print(f"        {note}")

    for name, a in rows:
        if a.approved_wrong:
            print(f"\n{name} — APPROVED BUT WRONG:")
            for w in a.approved_wrong:
                print(f"  [{w.get('trap')}] {w['ontology_uri'].split('#')[-1]}: "
                      f"{w['detail']}")
        if a.missed:
            print(f"\n{name} — deferred to a human (not errors):")
            for mm in a.missed:
                print(f"  [{mm.get('trap')}] {mm['ontology_uri'].split('#')[-1]} "
                      f"({mm['kind']})")

    print(f"\nCaveat: {LLM_CAVEAT}")


def _print_targets() -> None:
    print(f"\n{'=' * 72}")
    print("GRAPH TARGET CAPABILITIES — where a mapping can actually land")
    print(f"{'=' * 72}")
    caps = ["named_graphs", "sparql_1_1", "property_paths", "aggregation",
            "numeric_filters", "scoped_teardown"]
    print(f"\n{'capability':20}" + "".join(f"{t.name:>14}" for t in
                                          (ONTOBRICKS, NEPTUNE, NEO4J)))
    print("-" * 64)
    for cap in caps:
        line = f"{cap:20}"
        for t in (ONTOBRICKS, NEPTUNE, NEO4J):
            line += f"{('yes' if getattr(t, cap) else 'NO'):>14}"
        print(line)
    line = f"{'reasoning ceiling':20}"
    for t in (ONTOBRICKS, NEPTUNE, NEO4J):
        ceil = t.reasoning_triple_ceiling
        line += f"{(f'{ceil:,}' if ceil else 'none'):>14}"
    print(line)
    print("\nNotes:")
    for t in (ONTOBRICKS, NEPTUNE, NEO4J):
        for note in t.notes:
            print(f"  [{t.name}] {note}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--catalog", help="Unity Catalog catalog (live mode)")
    ap.add_argument("--schema", help="Unity Catalog schema (live mode)")
    ap.add_argument("--ontology", help="ontology file (live mode): .ttl/.nt/.owl")
    ap.add_argument("--truth", help="JSON ground truth: {ontology_uri: {...}}")
    ap.add_argument("--no-truth", action="store_true",
                    help="live mode without ground truth: automation rates only")
    ap.add_argument("--probe-limit", type=int, default=50_000)
    ap.add_argument("--json", action="store_true", help="emit JSON instead")
    args = ap.parse_args()

    live = bool(args.catalog and args.schema)

    if not live:
        from fixtures_contractiq import (CONTRACTIQ_TRUTH, contractiq_adapter,
                                         contractiq_ontology)
        adapter = contractiq_adapter()
        discovery = adapter.discover()
        ontology = contractiq_ontology()
        truth = CONTRACTIQ_TRUTH
        label = "offline ContractIQ fixture (trap-bearing)"
    else:
        if not args.ontology:
            print("live mode needs --ontology: an ontology-first comparison has "
                  "nothing to map FROM without one", file=sys.stderr)
            return 2
        if not args.truth and not args.no_truth:
            print("live mode needs --truth to score precision, or --no-truth to "
                  "report automation rates only", file=sys.stderr)
            return 2
        from graph_utility.descriptor import BackendSource, GraphSource, OntologySource
        from graph_utility.ontology_file import RdfFileOntologyClient
        from graph_utility.uc_adapter import UnityCatalogDataAdapter

        for var in ("DATABRICKS_HOST", "DATABRICKS_TOKEN"):
            if not os.environ.get(var):
                print(f"{var} is not set", file=sys.stderr)
                return 2
        source = GraphSource(
            graph_source_id="contract-iq",
            bu="market-access",
            display_name="Contract IQ",
            ontology=OntologySource(type="rdf-file", file_path=args.ontology,
                                    namespace="http://ontology.takeda.com/ontology/ma#"),
            backend=BackendSource(type="databricks-uc", catalog=args.catalog,
                                  schema=args.schema),
            llm_endpoint="databricks-meta-llama-3-3-70b-instruct",
        )
        adapter = UnityCatalogDataAdapter(source)
        discovery = adapter.discover()
        ontology = RdfFileOntologyClient(source).schema()
        truth = json.load(open(args.truth)) if args.truth else {}
        label = f"live Unity Catalog {args.catalog}.{args.schema}"

    c = compare(discovery, ontology, adapter, truth,
                probe_limit=args.probe_limit)

    if args.json:
        print(json.dumps({"label": label, **c.to_dict()}, indent=2))
    else:
        _print_report(c, label, truth_known=bool(truth))
        _print_targets()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
