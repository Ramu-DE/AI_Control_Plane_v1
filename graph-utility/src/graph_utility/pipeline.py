"""Agentic hybrid-RAG pipeline orchestrator (precision path).

Wires the three pieces into one bounded loop:

    classify (router) -> retrieve (specialized Retriever) -> synthesize (LLM)
    -> critique (critic) -> reroute (router) -> retry ... (bounded)

The pipeline depends ONLY on the provider-neutral `Retriever` seam and the
pure router/critic. Any retriever plugs in by name through `RetrieverRegistry`:
a vector retriever for semantic questions, a graph retriever (Neptune SPARQL or
Neo4j Cypher) for relationship questions, and a structured retriever for
computational questions. Swapping Neptune for Neo4j is a registry change — the
loop does not change.

The `synthesize` step is injected (an LLM callable). For offline tests a
deterministic stub is used so the whole loop runs with no network.

stdlib only.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Callable, Optional, Sequence

from .retriever import Retriever, RetrievalRequest, Passage
from .router import (
    Route,
    RerouteSignal,
    QuestionKind,
    classify as route_classify,
    reroute as route_reroute,
)
from .critic import Verdict, CriticThresholds, evaluate as critic_evaluate


# A synthesizer turns (question, passages) into a draft answer string.
Synthesizer = Callable[[str, Sequence[Passage]], str]


class RetrieverRegistry:
    """Maps a retriever NAME (as emitted by the router) to a Retriever.

    The router names retrievers ("vector" / "graph" / "structured" or custom);
    the registry binds those names to concrete backends. Neptune and Neo4j are
    just two different bindings for the "graph" name.
    """

    def __init__(self, retrievers: Optional[dict] = None) -> None:
        self._by_name: dict[str, Retriever] = {}
        for name, r in (retrievers or {}).items():
            self.register(name, r)

    def register(self, name: str, retriever: Retriever) -> None:
        self._by_name[name] = retriever

    def get(self, name: str) -> Optional[Retriever]:
        return self._by_name.get(name)

    def names(self) -> tuple[str, ...]:
        return tuple(self._by_name)


@dataclass(frozen=True)
class Attempt:
    """One iteration of the loop, recorded for transparency / audit."""
    route: Route
    passage_count: int
    draft: str
    verdict: Verdict

    def to_dict(self) -> dict:
        return {
            "route": self.route.to_dict(),
            "passage_count": self.passage_count,
            "draft": self.draft,
            "verdict": self.verdict.to_dict(),
        }


@dataclass(frozen=True)
class PipelineResult:
    question: str
    answer: str
    ok: bool
    route: Route                 # the route that produced `answer`
    verdict: Verdict             # critic verdict for `answer`
    passages: tuple[Passage, ...]
    attempts: tuple[Attempt, ...]

    def to_dict(self) -> dict:
        return {
            "question": self.question,
            "answer": self.answer,
            "ok": self.ok,
            "route": self.route.to_dict(),
            "verdict": self.verdict.to_dict(),
            "passages": [p.to_dict() for p in self.passages],
            "attempts": [a.to_dict() for a in self.attempts],
        }


def _default_synthesizer(question: str, passages: Sequence[Passage]) -> str:
    """Deterministic, offline draft: concatenate the top passages' text.

    This is a stand-in for an LLM so the loop is fully testable. It produces a
    draft that IS grounded (it quotes passage text) so the critic's grounding
    check passes when relevant passages were retrieved, and fails (empty) when
    nothing was retrieved.
    """
    top = list(passages)[:3]
    if not top:
        return "No relevant information found."
    return " ".join(p.text for p in top if p.text).strip() or "No relevant information found."


def run(
    question: str,
    registry: RetrieverRegistry,
    *,
    synthesize: Optional[Synthesizer] = None,
    top_k: int = 8,
    max_reroutes: int = 2,
    thresholds: Optional[CriticThresholds] = None,
    classifier_llm: Optional[Callable[[str], str]] = None,
    critic_llm: Optional[Callable] = None,
    retriever_names: Optional[dict] = None,
) -> PipelineResult:
    """Run the agentic loop and return the best answer with full provenance.

    1. classify the question into a route
    2. retrieve with the named retriever (fall back gracefully if unregistered)
    3. synthesize a draft
    4. critique; if ok, return
    5. otherwise reroute to an untried kind and retry, up to `max_reroutes`
       extra attempts (bounded — never loops forever). The best attempt (first
       ok, else highest grounding+coverage) is returned.
    """
    synth = synthesize or _default_synthesizer
    attempts: list[Attempt] = []
    tried: list[QuestionKind] = []

    route: Optional[Route] = route_classify(
        question, retriever_names=retriever_names, llm=classifier_llm
    )

    # total attempts = 1 initial + max_reroutes
    for _ in range(max_reroutes + 1):
        if route is None:
            break
        tried.append(route.kind)

        retriever = registry.get(route.retriever)
        if retriever is None:
            # Unregistered route: record an empty attempt and let reroute move on.
            verdict = Verdict(
                ok=False, grounded=False, answers_question=False,
                grounding_ratio=0.0, answer_coverage=0.0, missing=(),
                rationale=f"no retriever registered under '{route.retriever}'",
            )
            attempts.append(Attempt(route, 0, "", verdict))
            route = route_reroute(
                question, route,
                RerouteSignal(verdict.ok, verdict.answers_question, verdict.grounded),
                tried=tried, retriever_names=retriever_names,
            )
            continue

        passages = retriever.retrieve(RetrievalRequest(query=question, top_k=top_k))
        draft = synth(question, passages)
        verdict = critic_evaluate(question, passages, draft, thresholds=thresholds, llm=critic_llm)
        attempts.append(Attempt(route, len(passages), draft, verdict))

        if verdict.ok:
            return PipelineResult(
                question=question, answer=draft, ok=True, route=route,
                verdict=verdict, passages=tuple(passages), attempts=tuple(attempts),
            )

        route = route_reroute(
            question, route,
            RerouteSignal(verdict.ok, verdict.answers_question, verdict.grounded),
            tried=tried, retriever_names=retriever_names,
        )

    # No attempt passed the critic — return the best effort (highest combined
    # grounding + coverage), clearly flagged ok=False with the critic's reason.
    best = max(
        attempts,
        key=lambda a: (a.verdict.grounding_ratio + a.verdict.answer_coverage),
        default=None,
    )
    if best is None:
        empty = Verdict(False, False, False, 0.0, 0.0, (), "no attempts executed")
        empty_route = Route(QuestionKind.SEMANTIC, "vector", "no route", 0.0, ())
        return PipelineResult(question, "", False, empty_route, empty, (), ())
    return PipelineResult(
        question=question, answer=best.draft, ok=False, route=best.route,
        verdict=best.verdict, passages=(), attempts=tuple(attempts),
    )
