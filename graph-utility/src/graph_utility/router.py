"""Agentic hybrid-RAG router (precision path).

The router answers one question: *which retriever should serve this question?*
Basic RAG forces every question through a similarity-search retriever. A hybrid
pipeline instead classifies the question and routes it to a specialized
retriever:

    semantic       -> vector / similarity retriever   (unstructured passages)
    relationship   -> graph retriever                 (Neptune SPARQL / Neo4j Cypher)
    computational  -> structured retriever            (SQL aggregation / Cypher agg)

Design:
  * PURE and OFFLINE. `classify()` uses deterministic lexical signals so it is
    fully testable with no model. An optional `llm` callable is used ONLY as a
    tie-breaker for questions with no strong signal; when absent we fall back to
    `semantic` (the safe default — similarity search).
  * `reroute()` implements bounded escalation driven by a critic Verdict: when
    an answer is not grounded / does not answer the question, move to a
    retriever more likely to help (semantic -> relationship -> computational),
    without repeating a route already tried.
  * The router names retrievers by string; the pipeline owns the registry that
    maps a name to a concrete Retriever (vector / Neptune / Neo4j / SQL). The
    router therefore has NO backend dependency.

stdlib only.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Callable, Optional, Sequence


class QuestionKind(str, Enum):
    SEMANTIC = "semantic"
    RELATIONSHIP = "relationship"
    COMPUTATIONAL = "computational"


# Default retriever names per kind. The pipeline's registry must provide a
# retriever under the name it wants; these are the conventional defaults.
DEFAULT_RETRIEVER = {
    QuestionKind.SEMANTIC: "vector",
    QuestionKind.RELATIONSHIP: "graph",
    QuestionKind.COMPUTATIONAL: "structured",
}

# Escalation order used by reroute(): if the current kind did not produce a
# good answer, try the next kind that has not been tried yet.
ESCALATION_ORDER = (
    QuestionKind.SEMANTIC,
    QuestionKind.RELATIONSHIP,
    QuestionKind.COMPUTATIONAL,
)


# --------------------------------------------------------------------------- #
# Lexical signals (deterministic, offline). Whole-word matched, case-folded.
# --------------------------------------------------------------------------- #
# Relationship / traversal language: paths, connections, hierarchy, provenance.
_RELATIONSHIP_TERMS = (
    "related", "relationship", "connected", "connection", "path", "shortest path",
    "upstream", "downstream", "parent", "child", "hierarchy", "ancestor",
    "descendant", "who approved", "approved by", "reports to", "depends on",
    "linked", "neighbor", "neighbour", "between", "traverse", "graph",
    "same supplier", "shared", "common",
)
# Computational / aggregation language: math over sets of rows.
_COMPUTATIONAL_TERMS = (
    "total", "sum", "average", "avg", "mean", "count", "how many", "number of",
    "max", "maximum", "min", "minimum", "top ", "bottom ", "per ", "by ",
    "group by", "aggregate", "percentage", "percent", "ratio", "distribution",
    "trend", "over time", "rank", "median",
)
# Semantic language: meaning / description / free-text lookup.
_SEMANTIC_TERMS = (
    "about", "describe", "description", "explain", "summary", "summarize",
    "what is", "tell me about", "find documents", "similar", "like",
    "mentions", "discuss", "regarding", "context",
)


def _wordset(text: str) -> str:
    """Normalize to a space-padded, lowercased string for whole-word 'in' tests."""
    folded = "".join(c.lower() if (c.isalnum() or c.isspace()) else " " for c in text)
    return " " + re.sub(r"\s+", " ", folded).strip() + " "


def _hits(padded: str, terms: Sequence[str]) -> list[str]:
    """Return which terms appear as substrings of the padded, normalized text.

    Multi-word terms and trailing-space terms (e.g. 'by ') are matched directly;
    single tokens are matched as whole words via the surrounding spaces already
    present in `padded`.
    """
    found = []
    for t in terms:
        needle = t if t.endswith(" ") else f" {t} " if " " not in t else t
        # For multi-word phrases without trailing space, do a plain containment.
        if needle in padded or (" " in t and t in padded):
            found.append(t.strip())
    return found


# --------------------------------------------------------------------------- #
# Route result
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Route:
    kind: QuestionKind
    retriever: str
    rationale: str
    # Confidence in [0,1]: how strong the winning signal was relative to others.
    confidence: float = 0.0
    # Signal terms that fired, for transparency / audit.
    signals: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        d = asdict(self)
        d["kind"] = self.kind.value
        return d


# A minimal structural view of a critic verdict the router can act on, so the
# router does not import critic.py (avoids a cycle; the pipeline passes it in).
@dataclass(frozen=True)
class RerouteSignal:
    ok: bool
    answers_question: bool
    grounded: bool


# --------------------------------------------------------------------------- #
# Classifier
# --------------------------------------------------------------------------- #
def classify(
    question: str,
    *,
    retriever_names: Optional[dict] = None,
    llm: Optional[Callable[[str], str]] = None,
) -> Route:
    """Classify `question` into a QuestionKind and resolve a retriever name.

    Deterministic signals decide the route. Ties / no-signal fall back to the
    optional `llm` classifier, and finally to SEMANTIC (similarity search).
    `retriever_names` optionally overrides the default name for a kind.
    """
    if not question or not question.strip():
        return Route(QuestionKind.SEMANTIC, _name(QuestionKind.SEMANTIC, retriever_names),
                     "empty question → default to semantic", 0.0, ())

    padded = _wordset(question)
    rel = _hits(padded, _RELATIONSHIP_TERMS)
    comp = _hits(padded, _COMPUTATIONAL_TERMS)
    sem = _hits(padded, _SEMANTIC_TERMS)

    counts = {
        QuestionKind.RELATIONSHIP: len(rel),
        QuestionKind.COMPUTATIONAL: len(comp),
        QuestionKind.SEMANTIC: len(sem),
    }
    signals = {
        QuestionKind.RELATIONSHIP: rel,
        QuestionKind.COMPUTATIONAL: comp,
        QuestionKind.SEMANTIC: sem,
    }
    best = max(counts, key=lambda k: counts[k])
    best_n = counts[best]

    # No signal at all → LLM tie-break, else semantic default.
    if best_n == 0:
        if llm is not None:
            kind = _coerce_kind(llm(question))
            return Route(kind, _name(kind, retriever_names),
                         "no lexical signal → llm classifier", 0.34, ())
        return Route(QuestionKind.SEMANTIC, _name(QuestionKind.SEMANTIC, retriever_names),
                     "no lexical signal → default semantic", 0.34, ())

    # Tie between two kinds with equal, non-zero signal → precedence:
    # relationship > computational > semantic (structure questions are the ones
    # basic RAG most often gets wrong, so prefer the specialized retriever).
    top = [k for k, n in counts.items() if n == best_n]
    if len(top) > 1:
        for k in (QuestionKind.RELATIONSHIP, QuestionKind.COMPUTATIONAL, QuestionKind.SEMANTIC):
            if k in top:
                best = k
                break

    total = sum(counts.values()) or 1
    confidence = round(best_n / total, 3)
    return Route(
        best, _name(best, retriever_names),
        f"lexical signal: {best.value} ({best_n} hit(s))",
        confidence, tuple(signals[best]),
    )


def _name(kind: QuestionKind, overrides: Optional[dict]) -> str:
    if overrides and kind in overrides:
        return overrides[kind]
    if overrides and kind.value in overrides:
        return overrides[kind.value]
    return DEFAULT_RETRIEVER[kind]


def _coerce_kind(raw: str) -> QuestionKind:
    v = (raw or "").strip().lower()
    for k in QuestionKind:
        if k.value in v:
            return k
    return QuestionKind.SEMANTIC


# --------------------------------------------------------------------------- #
# Reroute (bounded escalation)
# --------------------------------------------------------------------------- #
def reroute(
    question: str,
    current: Route,
    verdict: RerouteSignal,
    *,
    tried: Optional[Sequence[QuestionKind]] = None,
    retriever_names: Optional[dict] = None,
) -> Optional[Route]:
    """Pick the next route after a failed answer, or None if nothing new to try.

    Strategy:
      * If the answer was NOT grounded, the retriever surfaced the wrong context
        → move to the next untried kind in ESCALATION_ORDER.
      * If it was grounded but did NOT answer the question, the retriever type is
        likely wrong for the intent → also escalate to the next untried kind.
      * Never return a kind already tried; return None when exhausted so the
        caller stops (bounded, no infinite loop).
    """
    if verdict.ok:
        return None  # nothing to reroute; answer is acceptable

    tried_set = set(tried or ())
    tried_set.add(current.kind)

    for kind in ESCALATION_ORDER:
        if kind in tried_set:
            continue
        reason = (
            "not grounded → try a different retriever"
            if not verdict.grounded
            else "grounded but did not answer → change retriever type"
        )
        return Route(kind, _name(kind, retriever_names),
                     f"reroute: {reason} ({current.kind.value}→{kind.value})",
                     0.0, ())
    return None
