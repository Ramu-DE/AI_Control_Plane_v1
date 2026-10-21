"""Answer critic (precision path).

The critic checks whether a draft answer actually (a) is GROUNDED in the
retrieved passages and (b) ANSWERS the user's original question. It is the
quality gate that turns a one-shot RAG call into an agentic loop: when the
verdict fails, the pipeline reroutes to a different retriever and retries.

Design:
  * PURE and OFFLINE by default. The heuristics use only token overlap and
    simple lexical checks — no model, fully deterministic, unit-testable.
  * An optional `llm` callable may override the judgment for nuanced cases; when
    absent, the heuristics stand alone. The llm, if given, is asked to return a
    strict JSON-ish verdict and is defensively parsed.
  * The critic NEVER fabricates: it reports what it checked (grounding ratio,
    overlap with the question, whether the draft hedges/abstains) so a reviewer
    can see why it passed or failed.

stdlib only.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict
from typing import Callable, Optional, Sequence

# Local import kept light; Passage is a frozen dataclass in retriever.py.
from .retriever import Passage


# Phrases that signal the model abstained / could not answer. If the draft is
# essentially an abstention, it does not answer the question regardless of
# overlap.
_ABSTENTION_PATTERNS = (
    r"\bi (?:do not|don't) know\b",
    r"\bno (?:relevant )?(?:information|data|context)\b",
    r"\bcannot (?:answer|determine|find)\b",
    r"\bnot (?:enough|sufficient) (?:information|context)\b",
    r"\bunable to\b",
    r"\bno (?:results|matches|records) found\b",
)

# Very common words excluded from overlap scoring so grounding/answer checks key
# on content words, not stopwords.
_STOPWORDS = frozenset("""
a an the of to in on for and or but is are was were be been being with by at as
from into over under this that these those it its their there here what which who
whom whose how when where why do does did done has have had will would can could
should may might must not no yes me my you your we our they them he she his her
""".split())


def _content_tokens(text: str) -> set[str]:
    folded = "".join(c.lower() if c.isalnum() else " " for c in (text or ""))
    return {t for t in folded.split() if t and t not in _STOPWORDS and len(t) > 1}


def _looks_like_abstention(draft: str) -> bool:
    low = (draft or "").lower()
    return any(re.search(p, low) for p in _ABSTENTION_PATTERNS)


@dataclass(frozen=True)
class Verdict:
    """Critic result. `ok` is the overall pass/fail used by the loop."""
    ok: bool
    grounded: bool
    answers_question: bool
    # Fraction of the draft's content tokens supported by the passages [0,1].
    grounding_ratio: float
    # Fraction of the question's content tokens reflected in the answer [0,1].
    answer_coverage: float
    # Missing question terms the answer did not address (for reroute context).
    missing: tuple[str, ...] = ()
    rationale: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class CriticThresholds:
    # Min fraction of answer tokens that must appear in retrieved passages.
    min_grounding: float = 0.5
    # Min fraction of question content tokens the answer must cover.
    min_answer_coverage: float = 0.4
    # An empty draft (no content tokens) always fails.

    def to_dict(self) -> dict:
        return asdict(self)


def evaluate(
    question: str,
    passages: Sequence[Passage],
    draft: str,
    *,
    thresholds: Optional[CriticThresholds] = None,
    llm: Optional[Callable[[str, Sequence[Passage], str], dict]] = None,
) -> Verdict:
    """Judge whether `draft` answers `question` using `passages` as evidence.

    Heuristic checks (deterministic):
      grounded          = grounding_ratio >= min_grounding  AND not abstention
      answers_question  = answer_coverage >= min_answer_coverage AND not abstention
      ok                = grounded AND answers_question

    If `llm` is provided, its boolean judgments (grounded / answers_question)
    override the heuristic ones, but the measured ratios are still reported.
    """
    th = thresholds or CriticThresholds()
    q_tokens = _content_tokens(question)
    d_tokens = _content_tokens(draft)

    # Evidence vocabulary = union of all passage texts (+ their metadata values).
    ev_tokens: set[str] = set()
    for p in passages or ():
        ev_tokens |= _content_tokens(p.text)
        for v in (p.metadata or {}).values():
            ev_tokens |= _content_tokens(str(v))

    abstains = _looks_like_abstention(draft)

    # Grounding: how much of the answer is backed by the evidence.
    if not d_tokens:
        grounding_ratio = 0.0
    else:
        grounding_ratio = round(len(d_tokens & ev_tokens) / len(d_tokens), 3)

    # Answer coverage: how much of the question's intent the answer addresses.
    if not q_tokens:
        answer_coverage = 0.0
        missing: tuple[str, ...] = ()
    else:
        covered = q_tokens & d_tokens
        answer_coverage = round(len(covered) / len(q_tokens), 3)
        missing = tuple(sorted(q_tokens - d_tokens))

    grounded = (not abstains) and bool(d_tokens) and grounding_ratio >= th.min_grounding
    answers = (not abstains) and bool(d_tokens) and answer_coverage >= th.min_answer_coverage

    # Optional LLM override (defensive parse; only booleans are trusted).
    if llm is not None:
        try:
            v = llm(question, list(passages or ()), draft) or {}
            if "grounded" in v:
                grounded = bool(v["grounded"])
            if "answers_question" in v:
                answers = bool(v["answers_question"])
        except Exception:
            pass  # fail safe: keep heuristic verdict

    ok = grounded and answers
    if abstains:
        rationale = "draft abstains / reports no answer"
    elif ok:
        rationale = "grounded in passages and covers the question"
    elif not grounded and not answers:
        rationale = "answer is neither grounded nor on-topic"
    elif not grounded:
        rationale = "answer not sufficiently grounded in retrieved passages"
    else:
        rationale = "answer grounded but does not cover the question"

    return Verdict(
        ok=ok,
        grounded=grounded,
        answers_question=answers,
        grounding_ratio=grounding_ratio,
        answer_coverage=answer_coverage,
        missing=missing,
        rationale=rationale,
    )
