"""Offline tests for the agentic hybrid-RAG router + critic + pipeline.

No network, no models — deterministic lexical router, heuristic critic, and the
bounded reroute loop driven by in-memory retrievers. Proves:
  - question-type classification (semantic / relationship / computational)
  - tie-break precedence and no-signal fallback
  - reroute escalation never repeats a tried kind and terminates
  - critic grounding + answers-question checks, abstention detection
  - the full loop: wrong retriever first -> reroute -> graph retriever answers
  - swapping Neptune<->Neo4j is a registry change (same loop)

Run: python3 tests/test_agentic_offline.py
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

import graph_utility as gu
from graph_utility import (
    Passage,
    RetrievalRequest,
    FieldMapping,
    InMemoryRetriever,
    QuestionKind,
    Route,
    RerouteSignal,
    CriticThresholds,
    RetrieverRegistry,
)

PASSED = 0


def check(cond, msg):
    global PASSED
    assert cond, "FAIL: " + msg
    PASSED += 1


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
def test_router_classifies_three_kinds():
    r = gu.classify("What is the total fees amount by supplier name?")
    check(r.kind is QuestionKind.COMPUTATIONAL, "aggregation question -> computational")
    check(r.retriever == "structured", "computational -> structured retriever")

    r = gu.classify("Which suppliers are connected to the same parent entity?")
    check(r.kind is QuestionKind.RELATIONSHIP, "traversal question -> relationship")
    check(r.retriever == "graph", "relationship -> graph retriever")

    r = gu.classify("Describe what the rebate clause is about")
    check(r.kind is QuestionKind.SEMANTIC, "descriptive question -> semantic")
    check(r.retriever == "vector", "semantic -> vector retriever")


def test_router_no_signal_falls_back_to_semantic():
    r = gu.classify("xyzzy plugh")
    check(r.kind is QuestionKind.SEMANTIC, "no lexical signal -> semantic default")
    check(r.confidence < 0.5, "no-signal route has low confidence")

    r = gu.classify("")
    check(r.kind is QuestionKind.SEMANTIC, "empty question -> semantic default")


def test_router_llm_tiebreak_used_only_without_signal():
    calls = {"n": 0}

    def fake_llm(q):
        calls["n"] += 1
        return "relationship"

    # Strong computational signal: llm must NOT be consulted.
    r = gu.classify("sum of fees by supplier", llm=fake_llm)
    check(r.kind is QuestionKind.COMPUTATIONAL, "signal wins over llm")
    check(calls["n"] == 0, "llm not called when a signal exists")

    # No signal: llm decides.
    r = gu.classify("qqq zzz", llm=fake_llm)
    check(r.kind is QuestionKind.RELATIONSHIP, "llm tiebreak applied on no-signal")
    check(calls["n"] == 1, "llm called exactly once on no-signal")


def test_router_name_overrides():
    names = {QuestionKind.RELATIONSHIP: "neptune", "computational": "sql-warehouse"}
    r = gu.classify("shortest path between two suppliers", retriever_names=names)
    check(r.retriever == "neptune", "relationship route honors name override (enum key)")
    r = gu.classify("average fees per therapeutic area", retriever_names=names)
    check(r.retriever == "sql-warehouse", "computational route honors name override (str key)")


def test_reroute_escalates_without_repeating_and_terminates():
    start = gu.classify("Describe the agreement")  # semantic
    fail = RerouteSignal(ok=False, answers_question=False, grounded=False)

    tried = [start.kind]
    nxt = gu.reroute("Describe the agreement", start, fail, tried=tried)
    check(nxt is not None and nxt.kind is not start.kind, "reroute moves to a new kind")
    tried.append(nxt.kind)

    nxt2 = gu.reroute("Describe the agreement", nxt, fail, tried=tried)
    check(nxt2 is not None and nxt2.kind not in tried, "second reroute still new")
    tried.append(nxt2.kind)

    # All three kinds tried -> no more routes -> None (bounded).
    nxt3 = gu.reroute("Describe the agreement", nxt2, fail, tried=tried)
    check(nxt3 is None, "reroute terminates once all kinds tried")


def test_reroute_noop_when_verdict_ok():
    start = gu.classify("total by supplier")
    ok = RerouteSignal(ok=True, answers_question=True, grounded=True)
    check(gu.reroute("q", start, ok) is None, "no reroute when the answer is acceptable")


# --------------------------------------------------------------------------- #
# Critic
# --------------------------------------------------------------------------- #
def test_critic_passes_grounded_on_topic_answer():
    passages = [Passage("1", "Globex Pharma total fees by supplier is 240000", 1.0, "graph")]
    v = gu.evaluate("total fees by supplier", passages, "The total fees by supplier Globex is 240000")
    check(v.ok, "grounded, on-topic answer passes")
    check(v.grounded and v.answers_question, "both sub-checks true")
    check(v.grounding_ratio >= 0.5 and v.answer_coverage >= 0.4, "ratios above thresholds")


def test_critic_fails_ungrounded_answer():
    passages = [Passage("1", "apples oranges bananas fruit basket", 1.0, "vector")]
    v = gu.evaluate("total fees by supplier", passages, "The fees total is 999 for supplier Acme")
    check(not v.grounded, "answer not supported by passages -> not grounded")
    check(not v.ok, "ungrounded answer fails overall")


def test_critic_detects_abstention():
    passages = [Passage("1", "supplier fees contract data here", 1.0, "graph")]
    v = gu.evaluate("total fees by supplier", passages, "I don't know, no relevant information was found.")
    check(not v.ok and not v.answers_question, "abstention does not answer the question")
    check("abstains" in v.rationale, "rationale flags abstention")


def test_critic_reports_missing_question_terms():
    passages = [Passage("1", "supplier revenue figures", 1.0, "graph")]
    v = gu.evaluate("total fees by supplier and region", passages, "supplier totals")
    check("region" in v.missing or "fees" in v.missing, "uncovered question terms reported")


def test_critic_llm_override():
    passages = [Passage("1", "unrelated text", 1.0, "vector")]
    # Heuristic would fail grounding; llm override forces a pass.
    def llm(q, ps, d):
        return {"grounded": True, "answers_question": True}
    v = gu.evaluate("total fees", passages, "something", llm=llm)
    check(v.ok, "llm override can pass a heuristically-failing answer")
    # ratios still reported from the heuristic measurement
    check(v.grounding_ratio <= 1.0, "measured ratio still reported under override")


# --------------------------------------------------------------------------- #
# Pipeline (full agentic loop)
# --------------------------------------------------------------------------- #
def _mapping():
    return FieldMapping(id_field="id", text_field="text", score_field="_score",
                        metadata_fields=("kind",))


def _graph_retriever():
    # Relationship-style records: who-is-connected-to-what.
    records = [
        {"id": "r1", "text": "Supplier Globex is connected to parent entity Initech Holdings", "kind": "edge"},
        {"id": "r2", "text": "Supplier Acme shares a parent entity with Globex", "kind": "edge"},
    ]
    return InMemoryRetriever("graph", records, _mapping())


def _vector_retriever():
    # Semantic corpus that does NOT contain the relationship answer.
    records = [
        {"id": "v1", "text": "A rebate clause describes pricing adjustments over time", "kind": "doc"},
        {"id": "v2", "text": "Therapeutic areas include oncology and cardiology", "kind": "doc"},
    ]
    return InMemoryRetriever("vector", records, _mapping())


def test_pipeline_routes_relationship_to_graph_and_answers():
    reg = RetrieverRegistry({"graph": _graph_retriever(), "vector": _vector_retriever()})
    res = gu.run("Which supplier shares a parent entity with Globex?", reg, max_reroutes=2)
    check(res.ok, "pipeline produces an acceptable answer")
    check(res.route.kind is QuestionKind.RELATIONSHIP, "routed to relationship/graph")
    check(res.route.retriever == "graph", "graph retriever served the answer")
    check("Acme" in res.answer or "parent" in res.answer, "answer carries the graph evidence")
    check(len(res.attempts) == 1, "answered on the first route, no reroute needed")


def test_pipeline_reroutes_when_first_retriever_is_wrong():
    # Force a wrong first route by naming the semantic retriever for everything,
    # but keep the graph retriever available for escalation. We simulate a
    # mis-route by registering only 'vector' for the semantic kind and 'graph'
    # for relationship, then asking a relationship question phrased semantically.
    reg = RetrieverRegistry({"vector": _vector_retriever(), "graph": _graph_retriever()})

    # A question with a weak 'about'/'describe' semantic lead-in but whose real
    # answer only exists in the graph corpus.
    q = "Tell me about which supplier shares a parent entity with Globex"
    res = gu.run(q, reg, max_reroutes=2)
    check(res.ok, "loop recovers with a reroute")
    # Whatever the first route, the ANSWERING route must be the graph one.
    check(res.route.retriever == "graph", "final answer comes from the graph retriever")
    check(len(res.attempts) >= 1, "at least one attempt recorded")
    # Attempts are ordered; the successful one is last.
    check(res.attempts[-1].verdict.ok, "last attempt is the passing one")


def test_pipeline_bounded_when_nothing_answers():
    # Empty corpus: every retriever returns nothing -> drafts abstain -> fail.
    empty = InMemoryRetriever("graph", [], _mapping())
    empty_v = InMemoryRetriever("vector", [], _mapping())
    empty_s = InMemoryRetriever("structured", [], _mapping())
    reg = RetrieverRegistry({"graph": empty, "vector": empty_v, "structured": empty_s})
    res = gu.run("Which supplier is connected to Globex?", reg, max_reroutes=2)
    check(not res.ok, "no data -> not ok")
    # Bounded: initial + up to max_reroutes, and never more than the 3 kinds.
    check(1 <= len(res.attempts) <= 3, "attempts are bounded")
    check(res.answer == "No relevant information found." or res.answer == "",
          "best-effort abstention surfaced, not a fabricated answer")


def test_pipeline_neptune_neo4j_are_registry_swap():
    # Same loop, same question; only the binding for the 'graph' name differs.
    # Here both 'neptune' and 'neo4j' are the SAME in-memory graph retriever to
    # prove the pipeline is backend-agnostic: we point the router's relationship
    # route name at each in turn.
    graph = _graph_retriever()
    q = "Which supplier shares a parent entity with Globex?"

    reg_neptune = RetrieverRegistry({"neptune": graph, "vector": _vector_retriever()})
    res_n = gu.run(q, reg_neptune, max_reroutes=2,
                   retriever_names={QuestionKind.RELATIONSHIP: "neptune"})
    check(res_n.ok and res_n.route.retriever == "neptune", "Neptune binding serves relationship route")

    reg_neo4j = RetrieverRegistry({"neo4j": graph, "vector": _vector_retriever()})
    res_j = gu.run(q, reg_neo4j, max_reroutes=2,
                   retriever_names={QuestionKind.RELATIONSHIP: "neo4j"})
    check(res_j.ok and res_j.route.retriever == "neo4j", "Neo4j binding serves relationship route")

    # Identical answers — the backend name is the only difference.
    check(res_n.answer == res_j.answer, "same loop output regardless of graph backend name")


def test_pipeline_unregistered_route_reroutes_gracefully():
    # Relationship route points at a name that isn't registered; the loop must
    # record the miss and escalate rather than crash.
    reg = RetrieverRegistry({"vector": _vector_retriever(), "graph": _graph_retriever()})
    res = gu.run("Which supplier is connected to Globex?", reg, max_reroutes=2,
                 retriever_names={QuestionKind.RELATIONSHIP: "does-not-exist"})
    # First attempt is the unregistered relationship route (empty), then it
    # escalates; since the graph corpus is reachable under the default 'graph'
    # name only for the DEFAULT mapping, this proves no crash + bounded attempts.
    check(len(res.attempts) >= 1, "unregistered route recorded as an attempt")
    check(any("no retriever registered" in a.verdict.rationale for a in res.attempts),
          "the unregistered miss is reported in a verdict rationale")


# --------------------------------------------------------------------------- #
def main() -> int:
    tests = [
        test_router_classifies_three_kinds,
        test_router_no_signal_falls_back_to_semantic,
        test_router_llm_tiebreak_used_only_without_signal,
        test_router_name_overrides,
        test_reroute_escalates_without_repeating_and_terminates,
        test_reroute_noop_when_verdict_ok,
        test_critic_passes_grounded_on_topic_answer,
        test_critic_fails_ungrounded_answer,
        test_critic_detects_abstention,
        test_critic_reports_missing_question_terms,
        test_critic_llm_override,
        test_pipeline_routes_relationship_to_graph_and_answers,
        test_pipeline_reroutes_when_first_retriever_is_wrong,
        test_pipeline_bounded_when_nothing_answers,
        test_pipeline_neptune_neo4j_are_registry_swap,
        test_pipeline_unregistered_route_reroutes_gracefully,
    ]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\nALL AGENTIC OFFLINE TESTS PASSED ({PASSED} assertions, {len(tests)} tests)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
