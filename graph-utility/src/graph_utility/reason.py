"""Entailment and constraint validation over a built graph.

Neptune has no OWL reasoner, and the ingest path does none either, so until now
an ontology's axioms did no work: `subClassOf` bought nothing, `inverseOf` left
edges one-directional, and `disjointWith` could not catch a mapping error. This
module closes that, deliberately narrowly.

TWO KINDS OF AXIOM, TREATED DIFFERENTLY. Conflating them is how reasoners end up
asserting nonsense:

  - GENERATING axioms (subClassOf, subPropertyOf, domain, range, inverseOf,
    equivalence, transitivity, symmetry) produce new triples. `entail()`.
  - CONSTRAINING axioms (disjointWith, FunctionalProperty) cannot produce
    anything; a violation means the MAPPING is wrong. `validate_constraints()`
    reports them as findings. Reasoning over them would hide the bug.

INFERRED TRIPLES ARE NEVER MIXED WITH ASSERTED ONES. `entail()` returns only
what is new, for loading into a separate named graph
(`urn:kg:build:<id>:inferred`). That is what makes the result auditable: you can
always tell what came from your data, recompute inference with a single
`DROP GRAPH`, or query asserted-only.

DELIBERATELY NOT IMPLEMENTED, with reasons:
  - `owl:sameAs` / equality closure. It explodes combinatorially, and merging
    identities is dangerous here precisely because subject IRIs are minted from
    keys: one identity error would silently fuse two real entities.
  - Class expressions (`unionOf`, `intersectionOf`, restrictions). They need a
    real reasoner; guessing at them would be worse than omitting them.
  - Cardinality. It constrains, so it belongs in validation, not entailment.

This is an RDFS-plus-safe-OWL subset, not OWL 2 RL. For full OWL with
*incremental* materialisation, see docs/RDFOX_assessment.md — the rule set here
is intentionally shaped so it ports to such an engine.

TERMINATION IS BOUNDED AND REPORTED. Naive fixpoint with caps on iterations and
inferred triples; hitting either sets `complete = False` rather than quietly
returning a partial closure.

stdlib only.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from .materialize import RDF_NS, Triple, is_iri, obj_iri

RDF_TYPE = RDF_NS + "type"

#: Fixpoint safety rails. A deep hierarchy plus a transitive property is the
#: realistic blow-up, so both are capped and the cap is surfaced.
DEFAULT_MAX_ITERATIONS = 12
DEFAULT_MAX_INFERRED = 500_000


@dataclass
class EntailmentReport:
    """What was derived, by which rule, and whether the closure finished."""

    iterations: int = 0
    inferred: int = 0
    by_rule: dict[str, int] = field(default_factory=dict)
    hit_iteration_cap: bool = False
    hit_inferred_cap: bool = False
    max_iterations: int = DEFAULT_MAX_ITERATIONS
    max_inferred: int = DEFAULT_MAX_INFERRED
    skipped_literal_range: int = 0

    @property
    def complete(self) -> bool:
        """False whenever a cap stopped the fixpoint early."""
        return not (self.hit_iteration_cap or self.hit_inferred_cap)

    def to_dict(self) -> dict[str, Any]:
        return {
            "iterations": self.iterations,
            "inferred": self.inferred,
            "by_rule": dict(sorted(self.by_rule.items())),
            "hit_iteration_cap": self.hit_iteration_cap,
            "hit_inferred_cap": self.hit_inferred_cap,
            "skipped_literal_range": self.skipped_literal_range,
            "complete": self.complete,
        }


@dataclass(frozen=True)
class Violation:
    """A constraint the data breaks — i.e. evidence the mapping is wrong."""

    code: str
    subject: str
    message: str
    severity: str = "error"

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "subject": self.subject,
                "message": self.message, "severity": self.severity}


# --------------------------------------------------------------------------- #
# T-box preparation
# --------------------------------------------------------------------------- #
def _transitive_closure(pairs: Iterable[tuple[str, str]]) -> dict[str, set[str]]:
    """Reflexive-free transitive closure of a binary relation.

    Computed on the T-box once, up front. That is both cheaper than iterating
    the A-box for `rdfs5`/`rdfs11` and more predictable: hierarchy depth cannot
    then consume the A-box iteration budget.
    """
    direct: dict[str, set[str]] = defaultdict(set)
    for a, b in pairs:
        if a != b:
            direct[a].add(b)

    closed: dict[str, set[str]] = {}
    for start in direct:
        seen: set[str] = set()
        stack = list(direct[start])
        while stack:
            node = stack.pop()
            if node in seen or node == start:
                continue
            seen.add(node)
            stack.extend(direct.get(node, ()))
        closed[start] = seen
    return closed


def prepare_tbox(axioms: dict[str, Any]) -> dict[str, Any]:
    """Normalise axioms into the indexes the rules need.

    Equivalence is folded into the subsumption relation in both directions,
    which is the standard treatment and keeps the rule set small:
    `A equivalentClass B` behaves as `A subClassOf B` and `B subClassOf A`.
    """
    sub_class = list(axioms.get("sub_class_of", []))
    sub_prop = list(axioms.get("sub_property_of", []))
    for a, b in axioms.get("equivalent_class", []):
        sub_class += [(a, b), (b, a)]
    for a, b in axioms.get("equivalent_property", []):
        sub_prop += [(a, b), (b, a)]

    inverse: dict[str, set[str]] = defaultdict(set)
    for p, q in axioms.get("inverse_of", []):
        inverse[p].add(q)
        inverse[q].add(p)   # inverseOf is symmetric

    domain: dict[str, set[str]] = defaultdict(set)
    for p, c in axioms.get("domain", []):
        domain[p].add(c)
    range_: dict[str, set[str]] = defaultdict(set)
    for p, c in axioms.get("range", []):
        range_[p].add(c)

    return {
        "super_classes": _transitive_closure(sub_class),
        "super_properties": _transitive_closure(sub_prop),
        "inverse_of": dict(inverse),
        "domain": dict(domain),
        "range": dict(range_),
        "transitive": set(axioms.get("transitive", [])),
        "symmetric": set(axioms.get("symmetric", [])),
        "functional": set(axioms.get("functional", [])),
        "disjoint_with": [tuple(p) for p in axioms.get("disjoint_with", [])],
    }


# --------------------------------------------------------------------------- #
# Entailment
# --------------------------------------------------------------------------- #
def entail(
    asserted: Iterable[Triple],
    axioms: dict[str, Any],
    *,
    max_iterations: int = DEFAULT_MAX_ITERATIONS,
    max_inferred: int = DEFAULT_MAX_INFERRED,
) -> tuple[set[Triple], EntailmentReport]:
    """Forward-chain to a fixpoint. Returns ONLY the newly inferred triples.

    Nothing already asserted is returned, so the caller can load the result into
    a separate graph without duplicating data.
    """
    tbox = prepare_tbox(axioms)
    base: set[Triple] = set(asserted)
    inferred: set[Triple] = set()
    report = EntailmentReport(max_iterations=max_iterations, max_inferred=max_inferred)

    def known(t: Triple) -> bool:
        return t in base or t in inferred

    def add(t: Triple, rule: str) -> bool:
        if known(t):
            return False
        if len(inferred) >= max_inferred:
            report.hit_inferred_cap = True
            return False
        inferred.add(t)
        report.by_rule[rule] = report.by_rule.get(rule, 0) + 1
        return True

    for iteration in range(1, max_iterations + 1):
        report.iterations = iteration
        added = 0

        # Re-index each round over asserted + inferred, so rules compose.
        current = list(base) + list(inferred)
        by_pred: dict[str, list[tuple[str, Any]]] = defaultdict(list)
        types_of: dict[str, set[str]] = defaultdict(set)
        for s, p, o in current:
            if p == RDF_TYPE and is_iri(o):
                types_of[s].add(o[1])
            else:
                by_pred[p].append((s, o))

        # rdfs2 — domain: a property's use types its SUBJECT.
        for p, classes in tbox["domain"].items():
            for s, _o in by_pred.get(p, ()):
                for c in classes:
                    added += add((s, RDF_TYPE, obj_iri(c)), "rdfs2-domain")

        # rdfs3 — range: types the OBJECT, but only when it is a resource.
        # A datatype property's range is an XSD type and its object is a
        # literal; literals cannot be subjects, so asserting that would be
        # malformed RDF. Skipped and counted rather than emitted.
        for p, classes in tbox["range"].items():
            for _s, o in by_pred.get(p, ()):
                if not is_iri(o):
                    report.skipped_literal_range += 1
                    continue
                for c in classes:
                    added += add((o[1], RDF_TYPE, obj_iri(c)), "rdfs3-range")

        # rdfs7 — subPropertyOf (already transitively closed).
        for p, supers in tbox["super_properties"].items():
            for s, o in by_pred.get(p, ()):
                for q in supers:
                    added += add((s, q, o), "rdfs7-subPropertyOf")

        # rdfs9 — subClassOf (already transitively closed).
        for subject, classes in list(types_of.items()):
            for c in list(classes):
                for d in tbox["super_classes"].get(c, ()):
                    added += add((subject, RDF_TYPE, obj_iri(d)), "rdfs9-subClassOf")

        # owl:inverseOf — the edge in the other direction.
        for p, inverses in tbox["inverse_of"].items():
            for s, o in by_pred.get(p, ()):
                if not is_iri(o):
                    continue
                for q in inverses:
                    added += add((o[1], q, obj_iri(s)), "owl-inverseOf")

        # owl:SymmetricProperty
        for p in tbox["symmetric"]:
            for s, o in by_pred.get(p, ()):
                if is_iri(o):
                    added += add((o[1], p, obj_iri(s)), "owl-symmetric")

        # owl:TransitiveProperty
        for p in tbox["transitive"]:
            edges = [(s, o[1]) for s, o in by_pred.get(p, ()) if is_iri(o)]
            out: dict[str, set[str]] = defaultdict(set)
            for s, o in edges:
                out[s].add(o)
            for s, o in edges:
                for o2 in out.get(o, ()):
                    if o2 != s:
                        added += add((s, p, obj_iri(o2)), "owl-transitive")

        if report.hit_inferred_cap:
            break
        if added == 0:
            break   # fixpoint reached
    else:
        # Loop ran to the cap without the else-skipping break: still changing.
        report.hit_iteration_cap = True

    report.inferred = len(inferred)
    return inferred, report


# --------------------------------------------------------------------------- #
# Constraint validation
# --------------------------------------------------------------------------- #
def validate_constraints(
    triples: Iterable[Triple],
    axioms: dict[str, Any],
    *,
    inferred: Optional[Iterable[Triple]] = None,
) -> list[Violation]:
    """Check CONSTRAINING axioms. A violation means the mapping is wrong.

    Pass `inferred` as well as the asserted triples: a disjointness breach is
    usually only visible after subclass entailment, because the two conflicting
    types are rarely both asserted directly.
    """
    tbox = prepare_tbox(axioms)
    all_triples = list(triples) + list(inferred or ())

    types_of: dict[str, set[str]] = defaultdict(set)
    objects_of: dict[tuple[str, str], set[str]] = defaultdict(set)
    for s, p, o in all_triples:
        if p == RDF_TYPE and is_iri(o):
            types_of[s].add(o[1])
        else:
            objects_of[(s, p)].add(o[1])

    violations: list[Violation] = []

    # owl:disjointWith — one resource cannot be both.
    for a, b in tbox["disjoint_with"]:
        for subject, classes in types_of.items():
            if a in classes and b in classes:
                violations.append(Violation(
                    code="disjoint-classes",
                    subject=subject,
                    message=(f"typed as both <{a}> and <{b}>, which the ontology "
                             f"declares disjoint; the mapping cannot be right"),
                ))

    # owl:FunctionalProperty — at most one distinct value.
    for p in sorted(tbox["functional"]):
        for (subject, pred), objs in objects_of.items():
            if pred == p and len(objs) > 1:
                sample = ", ".join(sorted(objs)[:3])
                violations.append(Violation(
                    code="functional-property-violated",
                    subject=subject,
                    message=(f"<{p}> is functional but has {len(objs)} distinct "
                             f"values ({sample}…); the source column is not "
                             f"single-valued for this subject"),
                ))

    return sorted(violations, key=lambda v: (v.code, v.subject, v.message))
