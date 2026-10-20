"""Databricks Job entrypoint — auto-build a GraphSource's mapping registry.

Run as a Databricks Job task (Python script) or %run from a notebook. It:
  1. loads the GraphSource descriptor (by id) from the packaged graph_sources dir,
  2. runs the Temporal-ready build activities (fetch -> derive -> MERGE -> smoke),
  3. prints a JSON summary + the descriptor to register in AgentControl.

Usage (Databricks Job parameters):
    --graph-source-id contract-iq
    --graph-sources-dir /dbfs/FileStore/graph_utility/graph_sources

The Spark session is picked up automatically on Databricks. Neptune access
requires the job's cluster to have VPC route + the assume-role permission.

When onboarding becomes multi-system/durable, lift `run_build`'s calls into
Temporal activities unchanged — this entrypoint stays the single-system runner.
"""
from __future__ import annotations

import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a GraphSource mapping registry.")
    ap.add_argument("--graph-source-id", required=True)
    ap.add_argument("--graph-sources-dir", default="graph_sources")
    ap.add_argument("--no-merge", action="store_true",
                    help="skip MERGE/smoke (fetch+derive+emit only; no Spark needed)")
    args = ap.parse_args()

    from graph_utility.descriptor import GraphSourceRegistry
    from graph_utility import run_build

    reg = GraphSourceRegistry.from_dir(args.graph_sources_dir)
    source = reg.get(args.graph_source_id)

    adapter = None
    if not args.no_merge:
        from graph_utility.backends import make_adapter

        adapter = make_adapter(source)  # resolves active Spark session on Databricks

    result = run_build(source, adapter=adapter)
    print(json.dumps(result, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
