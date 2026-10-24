"""Ontology source — read ontology SCHEMA from a SUPPLIED RDF document.

This is the ontology-FIRST entry point. `NeptuneOntologyClient` can only read an
ontology that already lives in a reachable SPARQL endpoint; this client takes the
ontology as an *input artifact* — a file you can hand over, diff and
version-control — which is what makes "build the graph from the ontology,
whatever the dataset" possible without a VPC or a running cluster.

It returns the EXACT same shape as the Neptune client
(`classes` / `properties` / `relationships`), so `propose_mappings` and the rest
of the precision path cannot tell the two apart.

PRECISION RULES — an ontology reader that guesses is worse than none, because
every guess becomes a mapping proposal that looks sourced:

  - NO INFERENCE. Only explicitly asserted triples are read. Nothing is derived
    from subclass chains, `owl:inverseOf`, or `owl:unionOf`. This matches
    Neptune, which has no reasoner either, so the two adapters agree. If
    entailments are wanted they must be materialised BEFORE this point (that is
    the RDFox seam, see docs/RDFOX_assessment.md).
  - A blank-node domain or range (the usual shape of `owl:unionOf`) cannot be
    resolved to a single class without reasoning, so it is reported in
    `warnings` and the term is emitted with that endpoint left as None. It is
    never collapsed to "the first class in the union".
  - Meta-vocabulary is excluded (`rdf:`, `rdfs:`, `owl:`, `xsd:`, SKOS, Dublin
    Core, FOAF, SHACL). Those terms describe ontologies; they are never a
    tenant's domain terms, and letting them through would propose mappings of
    `rdfs:label` onto real columns.
  - Multiple domains/ranges produce one entry per combination, mirroring the
    cross-product the Neptune client's OPTIONAL clauses already return.
  - Output is sorted, so the same file always yields the same proposals and the
    downstream fingerprints stay stable.

Divergence from the Neptune client, deliberate and worth knowing: the SPARQL
templates ask only for `owl:Class`, whereas a supplied file is often plain RDFS,
so this reader accepts `rdfs:Class` as well. A file containing only
`rdfs:Class` declarations would read as empty through the Neptune path.

rdflib is imported lazily, so this module stays importable in environments that
only need the Neptune path.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from .descriptor import GraphSource

RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
RDFS_NS = "http://www.w3.org/2000/01/rdf-schema#"
OWL_NS = "http://www.w3.org/2002/07/owl#"
XSD_NS = "http://www.w3.org/2001/XMLSchema#"

# Namespaces whose terms describe ontologies rather than a tenant's domain.
_META_NAMESPACES = (
    RDF_NS,
    RDFS_NS,
    OWL_NS,
    XSD_NS,
    "http://www.w3.org/2004/02/skos/core#",
    "http://www.w3.org/ns/shacl#",
    "http://www.w3.org/2003/11/swrl#",
    "http://purl.org/dc/elements/1.1/",
    "http://purl.org/dc/terms/",
    "http://xmlns.com/foaf/0.1/",
)

# Extension -> rdflib parser name. Only used when file_format is not given.
_EXT_FORMAT = {
    ".ttl": "turtle",
    ".turtle": "turtle",
    ".n3": "n3",
    ".nt": "nt",
    ".ntriples": "nt",
    ".nq": "nquads",
    ".nquads": "nquads",
    ".trig": "trig",
    ".rdf": "xml",
    ".owl": "xml",
    ".xml": "xml",
    ".jsonld": "json-ld",
    ".json": "json-ld",
}


class OntologyFileError(ValueError):
    """Raised when the ontology document cannot be read precisely."""


def infer_format(path: Path, explicit: Optional[str] = None) -> str:
    """Resolve the rdflib parser name, preferring an explicit descriptor hint."""
    if explicit:
        return explicit
    fmt = _EXT_FORMAT.get(path.suffix.lower())
    if not fmt:
        raise OntologyFileError(
            f"cannot infer RDF format from '{path.name}'; set ontology.file_format "
            f"to one of {sorted(set(_EXT_FORMAT.values()))}"
        )
    return fmt


def is_meta_term(uri: str) -> bool:
    """True for ontology meta-vocabulary, which must never become a candidate."""
    return any(uri.startswith(ns) for ns in _META_NAMESPACES)


class RdfFileOntologyClient:
    """Read-only ontology reader over a local RDF document.

    Mirrors NeptuneOntologyClient's interface so the build plane is agnostic to
    where the ontology came from.
    """

    def __init__(self, source: GraphSource) -> None:
        ont = source.ontology
        if ont.type != "rdf-file":
            raise ValueError(
                f"RdfFileOntologyClient requires ontology.type 'rdf-file', got '{ont.type}'"
            )
        if not ont.file_path:
            raise OntologyFileError("ontology.file_path is required for type 'rdf-file'")
        self.path = Path(ont.file_path).expanduser()
        self.file_format = ont.file_format
        self.namespace = ont.namespace
        self.graph_uri = ont.graph_uri
        # Terms outside `namespace` are kept by default (an ontology may legitimately
        # reuse another vocabulary); set this to scope strictly to the tenant's own.
        self.only_namespace = False
        self.warnings: list[str] = []
        self._graph = None

    # --- loading -------------------------------------------------------- #
    def graph(self):
        """Parse the document once and cache it."""
        if self._graph is not None:
            return self._graph
        if not self.path.is_file():
            raise OntologyFileError(f"ontology file not found: {self.path}")
        try:
            from rdflib import Dataset, URIRef
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise OntologyFileError(
                "reading an ontology file requires rdflib (pip install 'rdflib>=7.0')"
            ) from exc

        fmt = infer_format(self.path, self.file_format)
        ds = Dataset(default_union=True)
        try:
            ds.parse(source=str(self.path), format=fmt)
        except Exception as exc:
            raise OntologyFileError(
                f"could not parse '{self.path}' as {fmt}: {exc}"
            ) from exc

        if self.graph_uri:
            named = ds.graph(URIRef(self.graph_uri))
            if len(named) == 0:
                # Fail loudly: silently falling back to the whole document would
                # read triples the descriptor deliberately scoped out.
                raise OntologyFileError(
                    f"named graph <{self.graph_uri}> is empty or absent in "
                    f"'{self.path}'; remove ontology.graph_uri to read the whole "
                    f"document, or point it at a graph that exists"
                )
            self._graph = named
        else:
            self._graph = ds
        return self._graph

    # --- helpers -------------------------------------------------------- #
    def _uri(self, term) -> Optional[str]:
        """A term's URI, or None when it is a blank node (unresolvable here)."""
        from rdflib import BNode

        if term is None or isinstance(term, BNode):
            return None
        return str(term)

    def _label(self, subj) -> Optional[str]:
        """Pick one rdfs:label deterministically: plain/English first, else sorted."""
        from rdflib import RDFS

        labels = [o for o in self.graph().objects(subj, RDFS.label)]
        if not labels:
            return None
        plain = sorted(str(o) for o in labels if not getattr(o, "language", None))
        if plain:
            return plain[0]
        english = sorted(str(o) for o in labels if getattr(o, "language", "").startswith("en"))
        if english:
            return english[0]
        return sorted(str(o) for o in labels)[0]

    def _synonyms(self, subj) -> list[str]:
        """skos:prefLabel / altLabel / hiddenLabel — the ontology owner's own
        vocabulary for a term. Curated, versioned evidence for matching, unlike
        a guessed resemblance. Sorted so proposals are deterministic."""
        from rdflib import Namespace

        skos = Namespace("http://www.w3.org/2004/02/skos/core#")
        g = self.graph()
        found = {
            str(o)
            for pred in (skos.prefLabel, skos.altLabel, skos.hiddenLabel)
            for o in g.objects(subj, pred)
        }
        return sorted(found)

    def _has_key(self, subj) -> list[str]:
        """owl:hasKey (p1 p2 ...) — the ontology owner's declaration of which
        properties identify an instance. Returned in declared order, because a
        subject IRI embeds key order. Blank-node members are skipped (an
        anonymous property cannot be matched to a column)."""
        from rdflib import OWL
        from rdflib.collection import Collection

        g = self.graph()
        for head in g.objects(subj, OWL.hasKey):
            members = [self._uri(m) for m in Collection(g, head)]
            return [m for m in members if m]
        return []

    def _comment(self, subj) -> Optional[str]:
        from rdflib import RDFS

        comments = sorted(str(o) for o in self.graph().objects(subj, RDFS.comment))
        return comments[0] if comments else None

    def _keep(self, uri: str) -> bool:
        if is_meta_term(uri):
            return False
        if self.only_namespace and self.namespace and not uri.startswith(self.namespace):
            return False
        return True

    def _endpoints(self, subj, predicate, kind: str, term_uri: str) -> list[Optional[str]]:
        """Resolve rdfs:domain / rdfs:range, recording what cannot be resolved."""
        out: list[Optional[str]] = []
        for o in self.graph().objects(subj, predicate):
            uri = self._uri(o)
            if uri is None:
                # One problem, reported once: a term is read by both
                # list_properties and list_relationships, and repeating the
                # warning makes one blank node look like two.
                msg = (
                    f"{kind} of <{term_uri}> is a blank node (likely owl:unionOf); "
                    f"resolving it needs reasoning, so it is left unset"
                )
                if msg not in self.warnings:
                    self.warnings.append(msg)
                continue
            out.append(uri)
        return sorted(set(out)) if out else [None]

    def _declared_classes(self) -> set[str]:
        from rdflib import OWL, RDF, RDFS

        g = self.graph()
        found: set[str] = set()
        for cls_type in (OWL.Class, RDFS.Class):
            for s in g.subjects(RDF.type, cls_type):
                uri = self._uri(s)
                if uri and self._keep(uri):
                    found.add(uri)
        return found

    # --- schema reads (same contract as NeptuneOntologyClient) ----------- #
    def list_classes(self) -> list[dict[str, Any]]:
        from rdflib import OWL, RDF, RDFS, URIRef

        g = self.graph()
        rows: dict[str, dict[str, Any]] = {}
        for cls_type in (OWL.Class, RDFS.Class):
            for s in g.subjects(RDF.type, cls_type):
                uri = self._uri(s)
                if not uri or not self._keep(uri) or uri in rows:
                    continue
                rows[uri] = {
                    "class": uri,
                    "label": self._label(URIRef(uri)),
                    "comment": self._comment(URIRef(uri)),
                    "synonyms": self._synonyms(URIRef(uri)),
                    "has_key": self._has_key(URIRef(uri)),
                }
        return [rows[k] for k in sorted(rows)]

    def list_properties(self) -> list[dict[str, Any]]:
        """Datatype AND object properties, matching the Neptune client.

        `ptype` carries the full declaring type URI; the proposer keys off
        whether it contains "object", so the distinction must be accurate. A
        plain `rdf:Property` is classified by its range — XSD range means
        datatype, a declared class means object — and left as `rdf:Property`
        with a warning when neither applies, so it is never silently promoted
        to a relationship.
        """
        from rdflib import OWL, RDF, RDFS, URIRef

        g = self.graph()
        declared = self._declared_classes()
        out: list[dict[str, Any]] = []

        def emit(uri: str, ptype: str) -> None:
            subj = URIRef(uri)
            label = self._label(subj)
            synonyms = self._synonyms(subj)
            domains = self._endpoints(subj, RDFS.domain, "domain", uri)
            ranges = self._endpoints(subj, RDFS.range, "range", uri)
            for d in domains:
                for r in ranges:
                    out.append({
                        "property": uri,
                        "label": label,
                        "synonyms": synonyms,
                        "domain": d,
                        "range": r,
                        "ptype": ptype,
                    })

        seen: set[str] = set()
        for ptype_term in (OWL.DatatypeProperty, OWL.ObjectProperty):
            for s in g.subjects(RDF.type, ptype_term):
                uri = self._uri(s)
                if not uri or not self._keep(uri) or uri in seen:
                    continue
                seen.add(uri)
                emit(uri, str(ptype_term))

        # Plain RDFS properties, classified by range rather than assumed.
        for s in g.subjects(RDF.type, RDF.Property):
            uri = self._uri(s)
            if not uri or not self._keep(uri) or uri in seen:
                continue
            seen.add(uri)
            ranges = [self._uri(o) for o in g.objects(URIRef(uri), RDFS.range)]
            ranges = [r for r in ranges if r]
            if any(r.startswith(XSD_NS) for r in ranges):
                emit(uri, str(OWL.DatatypeProperty))
            elif any(r in declared for r in ranges):
                emit(uri, str(OWL.ObjectProperty))
            else:
                self.warnings.append(
                    f"<{uri}> is an rdf:Property whose range is neither an XSD "
                    f"datatype nor a declared class; treated as a datatype "
                    f"property, not a relationship"
                )
                emit(uri, str(RDF.Property))

        return sorted(
            out,
            key=lambda r: (r["property"], r["domain"] or "", r["range"] or ""),
        )

    def list_relationships(self) -> list[dict[str, Any]]:
        """Object properties only — the relationship candidates."""
        from rdflib import OWL, RDF, RDFS, URIRef

        g = self.graph()
        out: list[dict[str, Any]] = []
        for s in g.subjects(RDF.type, OWL.ObjectProperty):
            uri = self._uri(s)
            if not uri or not self._keep(uri):
                continue
            subj = URIRef(uri)
            label = self._label(subj)
            synonyms = self._synonyms(subj)
            for d in self._endpoints(subj, RDFS.domain, "domain", uri):
                for r in self._endpoints(subj, RDFS.range, "range", uri):
                    out.append({
                        "property": uri,
                        "label": label,
                        "synonyms": synonyms,
                        "domain": d,
                        "range": r,
                    })
        return sorted(
            out,
            key=lambda r: (r["property"], r["domain"] or "", r["range"] or ""),
        )

    def list_axioms(self) -> dict[str, Any]:
        """Read the ontology's LOGICAL content, for entailment and validation.

        Classes and properties say what vocabulary exists; axioms say what
        follows from it. Until something reads these, an ontology is only a
        naming scheme — `subClassOf` buys nothing, and `disjointWith` cannot
        catch a mapping error.

        Returns plain data (no rdflib types) so `reason.py` stays stdlib-only
        and any other ontology source can produce the same shape:

            sub_class_of / sub_property_of / equivalent_class /
            equivalent_property / inverse_of / domain / range
                                            -> list[(subject_uri, object_uri)]
            transitive / symmetric / functional
                                            -> list[property_uri]
            disjoint_with                   -> list[(class_uri, class_uri)]

        Blank-node participants are skipped for the same reason as elsewhere:
        resolving a class expression needs reasoning this reader does not do.
        """
        from rdflib import OWL, RDF, RDFS, URIRef

        g = self.graph()

        def pairs(predicate) -> list[tuple[str, str]]:
            out: set[tuple[str, str]] = set()
            for s, o in g.subject_objects(predicate):
                su, ou = self._uri(s), self._uri(o)
                if su is None or ou is None:
                    continue
                # Meta-vocabulary targets are real (e.g. an xsd range) and must
                # survive, but a meta SUBJECT means we would be redefining the
                # vocabulary itself, which is never this tenant's intent.
                if is_meta_term(su):
                    continue
                out.add((su, ou))
            return sorted(out)

        def typed(class_term) -> list[str]:
            out: set[str] = set()
            for s in g.subjects(RDF.type, class_term):
                su = self._uri(s)
                if su and self._keep(su):
                    out.add(su)
            return sorted(out)

        disjoint: set[tuple[str, str]] = set()
        for s, o in g.subject_objects(OWL.disjointWith):
            su, ou = self._uri(s), self._uri(o)
            if su and ou and self._keep(su) and self._keep(ou):
                # Store one orientation; the checker treats it symmetrically.
                disjoint.add(tuple(sorted((su, ou))))  # type: ignore[arg-type]

        return {
            "sub_class_of": pairs(RDFS.subClassOf),
            "sub_property_of": pairs(RDFS.subPropertyOf),
            "equivalent_class": pairs(OWL.equivalentClass),
            "equivalent_property": pairs(OWL.equivalentProperty),
            "inverse_of": pairs(OWL.inverseOf),
            "domain": pairs(RDFS.domain),
            "range": pairs(RDFS.range),
            "transitive": typed(OWL.TransitiveProperty),
            "symmetric": typed(OWL.SymmetricProperty),
            "functional": typed(OWL.FunctionalProperty),
            "disjoint_with": sorted(disjoint),
        }

    def triple_count(self) -> int:
        return len(self.graph())
