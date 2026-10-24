"""Load a governed build into Amazon Neptune (RDF) and verify it.

The build already ends as N-Quads with one named graph per build (data,
`:inferred`, `:prov`), which is exactly what Neptune's bulk loader ingests. This
module does the three steps an operator used to do by hand, and the one they
used to skip:

  1. upload the artifact to S3 under `builds/<build_id>/`;
  2. start the bulk loader (`format: nquads`, `failOnError: TRUE`) and wait;
  3. VERIFY: count quads per named graph with SPARQL and compare them to the
     artifact. A load that reports LOAD_COMPLETED but holds a different number
     of quads is a failure, not a success.

Neptune is VPC-only, so this runs from inside the VPC. IAM database auth is
not used here (the cluster this was built against has it disabled); the
security group is the boundary.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Optional


def graph_counts_from_nquads(lines: list[str]) -> dict[str, int]:
    """Quads per named graph in an artifact this module family produced.

    Every line ends `<graph> .`; parsing only that tail is enough and avoids
    re-tokenising literals."""
    counts: Counter[str] = Counter()
    for ln in lines:
        ln = ln.rstrip()
        if not ln.endswith(" ."):
            continue
        body = ln[:-2].rstrip()
        if body.endswith(">") and "<" in body:
            counts[body[body.rfind("<") + 1:-1]] += 1
    return dict(counts)


@dataclass
class NeptuneLoadReport:
    build_id: str
    s3_uri: str
    load_id: str
    status: str
    expected: dict[str, int] = field(default_factory=dict)
    loaded: dict[str, int] = field(default_factory=dict)

    @property
    def verified(self) -> bool:
        return self.status == "LOAD_COMPLETED" and self.expected == self.loaded

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__, "verified": self.verified}


class NeptuneClient:
    """Minimal HTTP client for the loader and SPARQL endpoints."""

    def __init__(self, endpoint: str, port: int = 8182, timeout: int = 30) -> None:
        self.base = f"https://{endpoint}:{port}"
        self.timeout = timeout

    def _request(self, path: str, *, data: Optional[bytes] = None,
                 headers: Optional[dict[str, str]] = None, method: str = "GET") -> dict:
        req = urllib.request.Request(self.base + path, data=data, headers=headers or {},
                                     method=method)
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read())

    def start_load(self, source: str, role_arn: str, region: str) -> str:
        body = json.dumps({
            "source": source, "format": "nquads", "iamRoleArn": role_arn,
            "region": region, "failOnError": "TRUE", "queueRequest": "TRUE",
        }).encode()
        out = self._request("/loader", data=body, method="POST",
                            headers={"Content-Type": "application/json"})
        return out["payload"]["loadId"]

    def load_status(self, load_id: str) -> dict:
        return self._request(f"/loader/{load_id}?details=true&errors=true")["payload"]

    def sparql_select(self, query: str) -> list[dict[str, str]]:
        data = urllib.parse.urlencode({"query": query}).encode()
        out = self._request("/sparql", data=data, method="POST", headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/sparql-results+json"})
        return [{k: v["value"] for k, v in b.items()} for b in out["results"]["bindings"]]

    def graph_counts(self, graph_prefix: str) -> dict[str, int]:
        rows = self.sparql_select(
            "SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } "
            f"FILTER(STRSTARTS(STR(?g), {json.dumps(graph_prefix)})) }} GROUP BY ?g")
        return {r["g"]: int(r["n"]) for r in rows}


def load_build_into_neptune(
    lines: list[str],
    *,
    build_id: str,
    graph_uri: str,
    endpoint: str,
    bucket: str,
    role_arn: str,
    region: str,
    port: int = 8182,
    poll_seconds: float = 5.0,
    timeout_seconds: float = 600.0,
) -> NeptuneLoadReport:
    """Upload, bulk-load, wait, and verify one build. Never deletes anything."""
    import boto3

    key = f"builds/{build_id}/{build_id}.nq"
    boto3.client("s3", region_name=region).put_object(
        Bucket=bucket, Key=key, Body="\n".join(lines).encode() + b"\n",
        ContentType="application/n-quads")
    prefix = f"s3://{bucket}/builds/{build_id}/"

    client = NeptuneClient(endpoint, port)
    load_id = client.start_load(prefix, role_arn, region)
    deadline = time.monotonic() + timeout_seconds
    status = "LOAD_IN_QUEUE"
    while time.monotonic() < deadline:
        overall = client.load_status(load_id)["overallStatus"]
        status = overall["status"]
        if status not in ("LOAD_NOT_STARTED", "LOAD_IN_QUEUE", "LOAD_IN_PROGRESS"):
            break
        time.sleep(poll_seconds)

    report = NeptuneLoadReport(
        build_id=build_id, s3_uri=prefix + f"{build_id}.nq", load_id=load_id,
        status=status, expected=graph_counts_from_nquads(lines))
    if status == "LOAD_COMPLETED":
        report.loaded = client.graph_counts(graph_uri)
    return report
