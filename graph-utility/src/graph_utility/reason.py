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

import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Iterable, Optional

from .materialize import RDF_NS, ObjectTerm, Triple, is_iri, obj_iri

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

    # Collections are SORTED TUPLES, not sets. Rule application iterates them,
    # so set order — which varies with the per-process string hash seed — would
    # leak into the order facts are derived in. That is invisible for a complete
    # closure (a set is a set) but decides WHICH facts you keep when a cap stops
    # the fixpoint early, making a truncated result irreproducible.
    return {
        "super_classes": {k: tuple(sorted(v))
                          for k, v in _transitive_closure(sub_class).items()},
        "super_properties": {k: tuple(sorted(v))
                             for k, v in _transitive_closure(sub_prop).items()},
        "inverse_of": {k: tuple(sorted(v)) for k, v in inverse.items()},
        "domain": {k: tuple(sorted(v)) for k, v in domain.items()},
        "range": {k: tuple(sorted(v)) for k, v in range_.items()},
        "transitive": tuple(sorted(set(axioms.get("transitive", [])))),
        "symmetric": tuple(sorted(set(axioms.get("symmetric", [])))),
        "functional": tuple(sorted(set(axioms.get("functional", [])))),
        "disjoint_with": [tuple(p) for p in axioms.get("disjoint_with", [])],
    }


def axioms_fingerprint(axioms: dict[str, Any]) -> str:
    """Content hash of an axiom set, in the convention used for mappings.

    A T-box edit is a change to the RULES, not the data: one new `subClassOf`
    retypes every instance of every subclass at once. Recording which axiom set
    entailed a graph is therefore as important as recording which mappings
    produced it, and nothing did so before — an ontology could be edited and the
    artifact would not show that anything had moved.
    """
    canonical = json.dumps(
        {k: sorted(v) if isinstance(v, (list, tuple, set)) else v
         for k, v in sorted(axioms.items())},
        sort_keys=True, default=str,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()[:16]


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

    # SEMI-NAIVE EVALUATION. The previous implementation re-indexed every known
    # fact and re-applied every rule to all of them on every round, so a fact
    # derived in round 1 was re-derived (and discarded as already-known) in
    # rounds 2 and 3. Re-indexing alone measured as 58% of total time. Here each
    # round applies rules only to the facts the PREVIOUS round produced — the
    # standard requirement that at least one body atom match the delta — and the
    # index is maintained incrementally. Output is unchanged: the closure of a
    # monotone rule set is the same set either way.
    known: set[Triple] = set(base)
    by_pred: dict[str, set[tuple[str, ObjectTerm]]] = defaultdict(set)
    types_of: dict[str, set[str]] = defaultdict(set)

    # Only predicates some rule can read are worth indexing. On a real build
    # most predicates are datatype properties no rule mentions.
    live_predicates = (
        set(tbox["domain"]) | set(tbox["range"]) | set(tbox["super_properties"])
        | set(tbox["inverse_of"]) | set(tbox["symmetric"]) | set(tbox["transitive"])
    )

    def index(t: Triple) -> None:
        s, p, o = t
        if p == RDF_TYPE and is_iri(o):
            types_of[s].add(o[1])
        elif p in live_predicates:
            by_pred[p].add((s, o))

    for t in base:
        index(t)

    frontier: list[Triple] = sorted(base)

    for iteration in range(1, max_iterations + 1):
        report.iterations = iteration
        produced: list[tuple[Triple, str]] = []
        emit = produced.append

        # Index the DELTA by predicate, then drive the rules from the rule set
        # rather than from the facts. Both halves matter: iterating the delta
        # per fact would pay a dict lookup per rule on every fact, including
        # the many datatype-property facts no rule can read, while iterating
        # all known facts (the previous shape) re-derives what earlier rounds
        # already produced.
        delta_by_pred: dict[str, list[tuple[str, ObjectTerm]]] = defaultdict(list)
        delta_types: list[tuple[str, str]] = []
        for s, p, o in frontier:
            if p == RDF_TYPE:
                if is_iri(o):
                    delta_types.append((s, o[1]))
            elif p in live_predicates:
                delta_by_pred[p].append((s, o))

        # rdfs9 — subClassOf (pre-closed on the T-box, so a single step).
        for s, cls in delta_types:
            for d in tbox["super_classes"].get(cls, ()):
                emit(((s, RDF_TYPE, obj_iri(d)), "rdfs9-subClassOf"))

        # rdfs2 — domain: a property's use types its SUBJECT.
        for p, classes in tbox["domain"].items():
            for s, _o in delta_by_pred.get(p, ()):
                for c in classes:
                    emit(((s, RDF_TYPE, obj_iri(c)), "rdfs2-domain"))

        # rdfs3 — range: types the OBJECT, but only when it is a resource.
        # A datatype property's range is an XSD type and its object is a
        # literal; literals cannot be subjects, so asserting that would be
        # malformed RDF. Skipped and counted rather than emitted.
        for p, classes in tbox["range"].items():
            for _s, o in delta_by_pred.get(p, ()):
                if not is_iri(o):
                    report.skipped_literal_range += 1
                    continue
                for c in classes:
                    emit(((o[1], RDF_TYPE, obj_iri(c)), "rdfs3-range"))

        # rdfs7 — subPropertyOf (also pre-closed).
        for p, supers in tbox["super_properties"].items():
            for s, o in delta_by_pred.get(p, ()):
                for q in supers:
                    emit(((s, q, o), "rdfs7-subPropertyOf"))

        # owl:inverseOf — the edge in the other direction.
        for p, inverses in tbox["inverse_of"].items():
            for s, o in delta_by_pred.get(p, ()):
                if is_iri(o):
                    for q in inverses:
                        emit(((o[1], q, obj_iri(s)), "owl-inverseOf"))

        # owl:SymmetricProperty
        for p in tbox["symmetric"]:
            for s, o in delta_by_pred.get(p, ()):
                if is_iri(o):
                    emit(((o[1], p, obj_iri(s)), "owl-symmetric"))

        # owl:TransitiveProperty — the only genuinely recursive rule. Joined
        # semi-naively (new ⋈ all, then all ⋈ new) instead of rebuilding the
        # whole adjacency and taking one doubling step per round.
        for p in tbox["transitive"]:
            delta_edges = [(s, o[1]) for s, o in delta_by_pred.get(p, ())
                           if is_iri(o)]
            if not delta_edges:
                continue
            # BOTH directions are required. Dropping `all join delta` looks
            # like a 2x win and silently under-derives — the randomised
            # differential test against the naive closure catches it.
            # Only ONE adjacency map is built over the (large) known edge set;
            # the second join reads a map of the (small) delta instead, which
            # is what the earlier two-map version paid for twice.
            out_adj: dict[str, set[str]] = defaultdict(set)
            for s, o in by_pred.get(p, ()):
                if is_iri(o):
                    out_adj[s].add(o[1])
            delta_out: dict[str, set[str]] = defaultdict(set)
            for a, b in delta_edges:
                delta_out[a].add(b)
            # delta join all
            for a, b in delta_edges:
                for c in out_adj.get(b, ()):
                    if c != a:
                        emit(((a, p, obj_iri(c)), "owl-transitive"))
            # all join delta
            for x, ys in out_adj.items():
                for y in ys:
                    for c in delta_out.get(y, ()):
                        if c != x:
                            emit(((x, p, obj_iri(c)), "owl-transitive"))

        # Sorting is what makes a TRUNCATED closure reproducible: which facts
        # survive the cap would otherwise depend on set iteration order, and so
        # on the per-process string hash seed. It is only needed when the cap
        # could actually bind — if everything derived this round is going to be
        # kept, order cannot change the resulting set, and sorting a large
        # candidate list is expensive enough to dominate the round.
        if len(inferred) + len(produced) > max_inferred:
            produced.sort()
        next_frontier: list[Triple] = []
        for t, rule in produced:
            if t in known:
                continue
            if len(inferred) >= max_inferred:
                report.hit_inferred_cap = True
                break
            inferred.add(t)
            known.add(t)
            index(t)
            report.by_rule[rule] = report.by_rule.get(rule, 0) + 1
            next_frontier.append(t)

        if report.hit_inferred_cap:
            break
        if not next_frontier:
            break   # fixpoint reached
        frontier = next_frontier
    else:
        # Ran to the iteration cap without reaching a fixpoint.
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
