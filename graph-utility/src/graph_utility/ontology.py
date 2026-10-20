"""Ontology source — read ontology SCHEMA (not data) to drive registry build.

Generalized from the Contract IQ notebooks (01 client + 03 templates) to be
descriptor-driven: any GraphSource with ontology.type == "neptune" works. The
client is read-only and returns classes / properties / relationships, which the
build plane turns into mapping-registry rows.

boto3/requests imported lazily so this module imports cleanly anywhere.
"""
from __future__ import annotations

from typing import Any

from .descriptor import GraphSource


class NeptuneOntologyClient:
    """Read-only SPARQL client for Neptune, authenticated via SigV4 + STS.

    Driven entirely by the GraphSource.ontology block — no hardcoded endpoints.
    """

    def __init__(self, source: GraphSource) -> None:
        ont = source.ontology
        if ont.type != "neptune":
            raise ValueError(f"NeptuneOntologyClient requires ontology.type 'neptune', got '{ont.type}'")
        self.sparql_url = ont.sparql_url
        self.graph_uri = ont.graph_uri
        self.namespace = ont.namespace
        self.region = ont.region
        self.role_arn = ont.role_arn
        self.auth = ont.auth
        self._creds = None

    # --- auth (lazy) ---
    def _credentials(self):
        if self._creds is not None:
            return self._creds
        import boto3
        from botocore.credentials import Credentials

        if self.auth == "sigv4-assume-role" and self.role_arn:
            sts = boto3.client("sts", region_name=self.region)
            assumed = sts.assume_role(
                RoleArn=self.role_arn,
                RoleSessionName="GraphUtility_Ontology_Session",
                DurationSeconds=3600,
            )
            c = assumed["Credentials"]
            self._creds = Credentials(c["AccessKeyId"], c["SecretAccessKey"], c["SessionToken"])
        else:
            sess = boto3.Session()
            self._creds = sess.get_credentials()
        return self._creds

    # --- query ---
    def select(self, sparql: str, timeout: int = 60) -> list[dict[str, Any]]:
        import requests
        from botocore.auth import SigV4Auth
        from botocore.awsrequest import AWSRequest

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/sparql-results+json",
        }
        body = f"query={requests.utils.quote(sparql)}"
        aws_req = AWSRequest(method="POST", url=self.sparql_url, data=body, headers=headers)
        SigV4Auth(self._credentials(), "neptune-db", self.region).add_auth(aws_req)
        resp = requests.post(self.sparql_url, headers=dict(aws_req.headers), data=body, timeout=timeout)
        resp.raise_for_status()
        rows = resp.json().get("results", {}).get("bindings", [])
        return [{k: v.get("value") for k, v in r.items()} for r in rows]

    # --- schema templates (ontology-only) ---
    def _prefix(self) -> str:
        return (
            f"PREFIX ma: <{self.namespace}>\n"
            "PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>\n"
            "PREFIX owl: <http://www.w3.org/2002/07/owl#>\n"
            "PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>\n"
        )

    def list_classes(self) -> list[dict[str, Any]]:
        return self.select(f"""{self._prefix()}
        SELECT DISTINCT ?class ?label ?comment FROM <{self.graph_uri}>
        WHERE {{ ?class a owl:Class .
                 OPTIONAL {{ ?class rdfs:label ?label }}
                 OPTIONAL {{ ?class rdfs:comment ?comment }} }}
        ORDER BY ?class""")

    def list_properties(self) -> list[dict[str, Any]]:
        return self.select(f"""{self._prefix()}
        SELECT DISTINCT ?property ?label ?domain ?range ?ptype FROM <{self.graph_uri}>
        WHERE {{ ?property a ?ptype .
                 FILTER(?ptype IN (owl:DatatypeProperty, owl:ObjectProperty))
                 OPTIONAL {{ ?property rdfs:label ?label }}
                 OPTIONAL {{ ?property rdfs:domain ?domain }}
                 OPTIONAL {{ ?property rdfs:range ?range }} }}
        ORDER BY ?property""")

    def list_relationships(self) -> list[dict[str, Any]]:
        return self.select(f"""{self._prefix()}
        SELECT DISTINCT ?property ?label ?domain ?range FROM <{self.graph_uri}>
        WHERE {{ ?property a owl:ObjectProperty .
                 OPTIONAL {{ ?property rdfs:label ?label }}
                 OPTIONAL {{ ?property rdfs:domain ?domain }}
                 OPTIONAL {{ ?property rdfs:range ?range }} }}
        ORDER BY ?property""")

    def triple_count(self) -> int:
        r = self.select(f"SELECT (COUNT(*) AS ?c) FROM <{self.graph_uri}> WHERE {{ ?s ?p ?o }}")
        return int(r[0]["c"]) if r else 0
