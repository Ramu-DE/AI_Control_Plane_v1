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


#: Axiom families carried as (subject, object) pairs.
AXIOM_PAIR_KINDS = (
    "sub_class_of", "sub_property_of", "equivalent_class",
    "equivalent_property", "inverse_of", "domain", "range",
)
#: Axiom families carried as a bare list of property URIs.
AXIOM_FLAG_KINDS = ("transitive", "symmetric", "functional")


def assemble_axioms(
    binary_rows: list[dict[str, Any]], characteristic_rows: list[dict[str, Any]]
) -> dict[str, Any]:
    """Turn SPARQL result rows into the axiom dict `reason.py` consumes.

    Pure, so the agreement between the Neptune reader and the file reader is
    testable without a cluster — which is the only part of the SPARQL path that
    can be got wrong silently. A divergence here would mean an ontology that
    reasons differently depending on where it was read from.
    """
    from .ontology_file import is_meta_term

    axioms: dict[str, Any] = {k: [] for k in AXIOM_PAIR_KINDS}
    for k in AXIOM_FLAG_KINDS:
        axioms[k] = []
    disjoint: set[tuple[str, str]] = set()

    for row in binary_rows:
        kind, s, o = row.get("kind"), row.get("s"), row.get("o")
        if not (kind and s and o):
            continue
        # A meta-vocabulary SUBJECT would mean redefining the vocabulary itself;
        # a meta OBJECT is legitimate (e.g. an xsd range).
        if is_meta_term(s):
            continue
        if kind == "disjoint_with":
            if not is_meta_term(o):
                disjoint.add(tuple(sorted((s, o))))  # type: ignore[arg-type]
        elif kind in axioms:
            axioms[kind].append((s, o))

    for row in characteristic_rows:
        kind, s = row.get("kind"), row.get("s")
        if kind in AXIOM_FLAG_KINDS and s and not is_meta_term(s):
            axioms[kind].append(s)

    for kind in AXIOM_PAIR_KINDS + AXIOM_FLAG_KINDS:
        axioms[kind] = sorted(set(axioms[kind]))
    axioms["disjoint_with"] = sorted(disjoint)
    return axioms


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
        # Parity with the file reader: what could not be read precisely.
        self.warnings: list[str] = []

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

    def list_axioms(self) -> dict[str, Any]:
        """Read the ontology's LOGICAL content, for entailment and validation.

        Returns the SAME shape as `RdfFileOntologyClient.list_axioms()`, so
        `reason.py` cannot tell a Neptune-sourced ontology from a supplied file.
        Keeping the two in lockstep is the point: an ontology that reasons one
        way from a file and another way from a cluster is worse than one that
        does not reason at all.

        Two queries rather than eleven, to keep the round trips down: one UNION
        over the binary axiom predicates, one over the property characteristics.

        Blank-node participants are excluded in SPARQL (`isBlank`) because
        resolving a class expression needs reasoning this reader does not do —
        the same rule the file reader follows. They are counted and surfaced in
        `self.warnings` rather than dropped silently, but unlike the file reader
        they are reported as a total, not itemised per term.
        """
        binary = self.select(f"""{self._prefix()}
        SELECT DISTINCT ?kind ?s ?o FROM <{self.graph_uri}>
        WHERE {{
          {{ ?s rdfs:subClassOf ?o .      BIND("sub_class_of" AS ?kind) }}
          UNION {{ ?s rdfs:subPropertyOf ?o .   BIND("sub_property_of" AS ?kind) }}
          UNION {{ ?s owl:equivalentClass ?o .  BIND("equivalent_class" AS ?kind) }}
          UNION {{ ?s owl:equivalentProperty ?o . BIND("equivalent_property" AS ?kind) }}
          UNION {{ ?s owl:inverseOf ?o .        BIND("inverse_of" AS ?kind) }}
          UNION {{ ?s rdfs:domain ?o .          BIND("domain" AS ?kind) }}
          UNION {{ ?s rdfs:range ?o .           BIND("range" AS ?kind) }}
          UNION {{ ?s owl:disjointWith ?o .     BIND("disjoint_with" AS ?kind) }}
          FILTER(!isBlank(?s) && !isBlank(?o))
        }}
        ORDER BY ?kind ?s ?o""")

        characteristics = self.select(f"""{self._prefix()}
        SELECT DISTINCT ?kind ?s FROM <{self.graph_uri}>
        WHERE {{
          {{ ?s a owl:TransitiveProperty . BIND("transitive" AS ?kind) }}
          UNION {{ ?s a owl:SymmetricProperty .  BIND("symmetric" AS ?kind) }}
          UNION {{ ?s a owl:FunctionalProperty . BIND("functional" AS ?kind) }}
          FILTER(!isBlank(?s))
        }}
        ORDER BY ?kind ?s""")

        blank = self.select(f"""{self._prefix()}
        SELECT (COUNT(*) AS ?c) FROM <{self.graph_uri}>
        WHERE {{
          {{ ?s rdfs:subClassOf ?o }} UNION {{ ?s rdfs:domain ?o }}
          UNION {{ ?s rdfs:range ?o }} UNION {{ ?s owl:disjointWith ?o }}
          FILTER(isBlank(?o) || isBlank(?s))
        }}""")
        skipped = int(blank[0]["c"]) if blank and blank[0].get("c") else 0
        if skipped:
            self.warnings.append(
                f"{skipped} axiom(s) have a blank-node participant (likely "
                f"owl:unionOf or a restriction); resolving them needs reasoning, "
                f"so they are skipped"
            )

        return assemble_axioms(binary, characteristics)

    def triple_count(self) -> int:
        r = self.select(f"SELECT (COUNT(*) AS ?c) FROM <{self.graph_uri}> WHERE {{ ?s ?p ?o }}")
        return int(r[0]["c"]) if r else 0


def make_ontology_client(source: GraphSource):
    """Select the ontology adapter the descriptor asks for.

    The build plane calls this instead of constructing a client directly, so an
    `rdf-file` source no longer fails with a confusing Neptune error. Each
    unsupported type raises a message that says what to do about it rather than
    what went wrong internally.
    """
    ont_type = source.ontology.type
    if ont_type == "neptune":
        return NeptuneOntologyClient(source)
    if ont_type == "rdf-file":
        from .ontology_file import RdfFileOntologyClient

        return RdfFileOntologyClient(source)
    if ont_type == "rdfox":
        raise NotImplementedError(
            "ontology.type 'rdfox' is a configuration seam only: there is no "
            "RDFox client in this module yet (see docs/RDFOX_assessment.md). "
            "Use 'rdf-file' with an ontology that already has its entailments "
            "materialised, or 'neptune'."
        )
    if ont_type == "none":
        raise ValueError(
            "ontology.type 'none' means the backend graph IS the ontology, so "
            "there is no schema to read here; this source cannot drive an "
            "ontology-first build."
        )
    raise ValueError(f"unsupported ontology.type '{ont_type}'")
