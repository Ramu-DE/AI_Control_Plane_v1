#!/usr/bin/env python3
"""Provision a Unity Catalog dataset WITH DECLARED KEYS, for the ontology-first build.

Why this exists: the precision path derives subject keys and joins from
*declared* constraints, never from column-name shape. Unity Catalog supports
informational PRIMARY KEY / FOREIGN KEY constraints, but a table created without
them offers the discoverer nothing to work with — and the whole point is to stop
guessing. So a real end-to-end test needs a real keyed schema.

It lands in its own schema (`graph_demo`) so nothing pre-existing is touched,
and it is a structurally awkward dataset on purpose: a composite primary key and
a many-to-many junction table, with no single join key anywhere.

Reads DATABRICKS_HOST / DATABRICKS_TOKEN / DATABRICKS_WAREHOUSE_ID from the
environment. Re-runnable: it drops and recreates only the tables it owns.

    python3 integration/provision_uc_clinical.py [--catalog workspace] [--schema graph_demo]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

TABLES = ("trial_site", "trial", "investigator", "site")  # child first for FKs


def _api(host: str, token: str, path: str, body: dict | None = None, method: str = "POST"):
    req = urllib.request.Request(
        f"{host.rstrip('/')}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def run_sql(host: str, token: str, warehouse: str, sql: str, wait: int = 180) -> dict:
    out = _api(host, token, "/api/2.0/sql/statements", {
        "statement": sql,
        "warehouse_id": warehouse,
        "wait_timeout": "30s",
        "on_wait_timeout": "CONTINUE",
        "format": "JSON_ARRAY",
        "disposition": "INLINE",
    })
    sid = out.get("statement_id")
    deadline = time.time() + wait
    while out.get("status", {}).get("state") in ("PENDING", "RUNNING") and time.time() < deadline:
        time.sleep(3)
        out = _api(host, token, f"/api/2.0/sql/statements/{sid}", method="GET")
    state = out.get("status", {}).get("state")
    if state != "SUCCEEDED":
        raise RuntimeError(f"statement failed ({state}): "
                           f"{out.get('status', {}).get('error')}\n  SQL: {sql[:200]}")
    return out


def statements(catalog: str, schema: str) -> list[str]:
    fq = f"{catalog}.{schema}"
    out = [f"CREATE SCHEMA IF NOT EXISTS {fq}"]
    # Drop children before parents so FK constraints never block the drop.
    out += [f"DROP TABLE IF EXISTS {fq}.{t}" for t in TABLES]

    out += [
        f"""CREATE TABLE {fq}.trial (
              trial_id STRING NOT NULL,
              trial_title STRING,
              phase STRING,
              enrollment_target INT
            ) COMMENT 'Interventional clinical studies'""",
        f"ALTER TABLE {fq}.trial ADD CONSTRAINT pk_trial PRIMARY KEY (trial_id)",

        f"""CREATE TABLE {fq}.investigator (
              investigator_id STRING NOT NULL,
              investigator_name STRING,
              specialty STRING
            ) COMMENT 'Principal investigators'""",
        f"ALTER TABLE {fq}.investigator ADD CONSTRAINT pk_investigator PRIMARY KEY (investigator_id)",

        f"""CREATE TABLE {fq}.site (
              site_id STRING NOT NULL,
              site_name STRING,
              country STRING
            ) COMMENT 'Trial sites'""",
        f"ALTER TABLE {fq}.site ADD CONSTRAINT pk_site PRIMARY KEY (site_id)",

        # Composite PK + three FKs: the shape that defeats a single join key.
        f"""CREATE TABLE {fq}.trial_site (
              trial_id STRING NOT NULL,
              site_id STRING NOT NULL,
              investigator_id STRING,
              enrolled_count INT
            ) COMMENT 'A trial as conducted at one site'""",
        f"ALTER TABLE {fq}.trial_site ADD CONSTRAINT pk_trial_site PRIMARY KEY (trial_id, site_id)",
        f"ALTER TABLE {fq}.trial_site ADD CONSTRAINT fk_ts_trial "
        f"FOREIGN KEY (trial_id) REFERENCES {fq}.trial(trial_id)",
        f"ALTER TABLE {fq}.trial_site ADD CONSTRAINT fk_ts_site "
        f"FOREIGN KEY (site_id) REFERENCES {fq}.site(site_id)",
        f"ALTER TABLE {fq}.trial_site ADD CONSTRAINT fk_ts_investigator "
        f"FOREIGN KEY (investigator_id) REFERENCES {fq}.investigator(investigator_id)",

        f"""INSERT INTO {fq}.trial VALUES
              ('T1','Oncology Phase II Study','II',120),
              ('T2','Cardio Phase III Study','III',300),
              ('T3','Rare Disease Phase I Study','I',45)""",
        f"""INSERT INTO {fq}.investigator VALUES
              ('I1','Dr Reyes','Oncology'),
              ('I2','Dr Okafor','Cardiology'),
              ('I3','Dr Lindqvist','Rare Disease')""",
        f"""INSERT INTO {fq}.site VALUES
              ('S1','North Clinic','US'),
              ('S2','South Clinic','BR'),
              ('S3','Harbour Clinic','PT')""",
        # Includes a NULL investigator, so the builder's NULL handling is
        # exercised against real data rather than only in the fixture.
        f"""INSERT INTO {fq}.trial_site VALUES
              ('T1','S1','I1',40),
              ('T1','S2','I1',35),
              ('T2','S1','I2',200),
              ('T3','S3',NULL,12)""",
    ]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="workspace")
    ap.add_argument("--schema", default="graph_demo")
    args = ap.parse_args()

    try:
        host = os.environ["DATABRICKS_HOST"]
        token = os.environ["DATABRICKS_TOKEN"]
        warehouse = os.environ["DATABRICKS_WAREHOUSE_ID"]
    except KeyError as e:
        print(f"missing environment variable: {e}", file=sys.stderr)
        return 2

    for sql in statements(args.catalog, args.schema):
        label = " ".join(sql.split())[:88]
        try:
            run_sql(host, token, warehouse, sql)
            print(f"  ok   {label}")
        except (RuntimeError, urllib.error.HTTPError) as e:
            print(f"  FAIL {label}\n       {e}", file=sys.stderr)
            return 1

    check = run_sql(host, token, warehouse, f"""
        SELECT tc.table_name, tc.constraint_type, kcu.column_name
        FROM {args.catalog}.information_schema.table_constraints tc
        JOIN {args.catalog}.information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.constraint_schema = kcu.constraint_schema
        WHERE tc.table_schema = '{args.schema}'
        ORDER BY tc.table_name, tc.constraint_type, kcu.ordinal_position
    """)
    rows = check.get("result", {}).get("data_array") or []
    print(f"\ndeclared constraints now visible in information_schema: {len(rows)}")
    for r in rows:
        print("   ", " | ".join(str(x) for x in r))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
