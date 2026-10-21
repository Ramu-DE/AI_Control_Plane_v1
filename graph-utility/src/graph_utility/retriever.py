"""Provider-neutral Retriever seam (precision path).

Split cleanly from the structured `DataAdapter`. A Retriever does unstructured /
vector / lexical passage retrieval. It is PROVIDER-NEUTRAL: ContractIQ columns
are gone; field mapping is driven by a descriptor so any index schema works.

Types:
    RetrievalRequest    — query, top_k, filters, requested fields
    Passage             — normalized result: id, text, score, source, metadata
    RetrieverCapabilities — what a backend supports (filters, hybrid, rerank...)
    FieldMapping        — descriptor: which index columns map to id/text/score/meta
    Retriever (ABC)     — retrieve(request) -> list[Passage]

Helpers (offline, no live calls):
    federate   — run several retrievers and concatenate
    dedupe     — remove duplicate passages by id/text fingerprint
    rrf_fuse   — Reciprocal Rank Fusion across ranked lists

DatabricksVectorRetriever is descriptor-driven and imports its SDK lazily; it is
never called in tests (no live provider calls).

stdlib only (plus lazy optional SDKs inside provider classes).
"""
from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Optional


# --------------------------------------------------------------------------- #
# Request / result / capability contracts
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class RetrievalRequest:
    query: str
    top_k: int = 5
    filters: dict[str, Any] = field(default_factory=dict)
    # Which normalized fields the caller wants back in Passage.metadata.
    requested_fields: tuple[str, ...] = ()

    def clamped_top_k(self, max_k: int = 100) -> int:
        return max(1, min(self.top_k, max_k))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class Passage:
    id: str
    text: str
    score: float
    source: str                       # which retriever produced it
    metadata: dict[str, Any] = field(default_factory=dict)

    def fingerprint(self) -> str:
        basis = (self.text or "").strip().lower().encode("utf-8")
        return hashlib.sha256(basis).hexdigest()[:16]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class RetrieverCapabilities:
    supports_filters: bool = False
    supports_hybrid: bool = False
    supports_rerank: bool = False
    max_top_k: int = 100

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class FieldMapping:
    """Descriptor mapping an index's native columns onto normalized Passage
    fields. This is what replaces ContractIQ hardcoded columns.

    `metadata_fields` lists native columns to pass through into Passage.metadata
    (optionally renamed via `rename`).
    """

    id_field: str
    text_field: str
    score_field: Optional[str] = None
    metadata_fields: tuple[str, ...] = ()
    rename: dict[str, str] = field(default_factory=dict)

    def normalize(self, record: dict[str, Any], *, source: str,
                  default_score: float = 0.0) -> Passage:
        pid = str(record.get(self.id_field, "")) or hashlib.sha256(
            str(record.get(self.text_field, "")).encode("utf-8")).hexdigest()[:16]
        text = str(record.get(self.text_field, ""))
        score = record.get(self.score_field) if self.score_field else default_score
        try:
            score = float(score) if score is not None else default_score
        except (TypeError, ValueError):
            score = default_score
        meta = {}
        for f in self.metadata_fields:
            if f in record:
                meta[self.rename.get(f, f)] = record[f]
        return Passage(id=pid, text=text, score=score, source=source, metadata=meta)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# --------------------------------------------------------------------------- #
# The seam
# --------------------------------------------------------------------------- #
class Retriever(ABC):
    name: str

    @abstractmethod
    def capabilities(self) -> RetrieverCapabilities:
        ...

    @abstractmethod
    def retrieve(self, request: RetrievalRequest) -> list[Passage]:
        ...


# --------------------------------------------------------------------------- #
# Offline in-memory retriever (fixture) — lexical, deterministic
# --------------------------------------------------------------------------- #
class InMemoryRetriever(Retriever):
    """Offline fixture retriever: scores passages by simple token overlap.

    Given records + a FieldMapping, it normalizes them to Passages and ranks by
    lexical overlap with the query. No network, fully deterministic.
    """

    def __init__(self, name: str, records: list[dict[str, Any]],
                 mapping: FieldMapping) -> None:
        self.name = name
        self._records = records
        self._mapping = mapping

    def capabilities(self) -> RetrieverCapabilities:
        return RetrieverCapabilities(supports_filters=True, max_top_k=100)

    @staticmethod
    def _tokens(text: str) -> set[str]:
        return {t for t in "".join(c.lower() if c.isalnum() else " " for c in text).split() if t}

    def retrieve(self, request: RetrievalRequest) -> list[Passage]:
        q = self._tokens(request.query)
        scored: list[Passage] = []
        for rec in self._records:
            # apply simple equality filters on native fields
            if request.filters and not all(
                str(rec.get(k)) == str(v) for k, v in request.filters.items()
            ):
                continue
            text = str(rec.get(self._mapping.text_field, ""))
            overlap = len(q & self._tokens(text))
            denom = len(q) or 1
            score = overlap / denom
            rec2 = dict(rec)
            rec2[self._mapping.score_field or "_score"] = score
            m = FieldMapping(
                id_field=self._mapping.id_field, text_field=self._mapping.text_field,
                score_field=self._mapping.score_field or "_score",
                metadata_fields=self._mapping.metadata_fields, rename=self._mapping.rename)
            scored.append(m.normalize(rec2, source=self.name))
        scored.sort(key=lambda p: p.score, reverse=True)
        return scored[: request.clamped_top_k(self.capabilities().max_top_k)]


# --------------------------------------------------------------------------- #
# Databricks vector retriever — descriptor-driven, lazy SDK, never live in tests
# --------------------------------------------------------------------------- #
class DatabricksVectorRetriever(Retriever):
    """Descriptor-driven Databricks Vector Search retriever.

    Field mapping comes from a FieldMapping descriptor — NO hardcoded ContractIQ
    columns. The databricks SDK is imported lazily; this class is importable
    anywhere and is never invoked in offline tests.
    """

    def __init__(self, name: str, endpoint: str, index: str,
                 mapping: FieldMapping, client_factory: Optional[Callable[[], Any]] = None) -> None:
        self.name = name
        self.endpoint = endpoint
        self.index = index
        self._mapping = mapping
        self._client_factory = client_factory
        self._index_handle = None

    def capabilities(self) -> RetrieverCapabilities:
        return RetrieverCapabilities(
            supports_filters=True, supports_hybrid=True, supports_rerank=False, max_top_k=100)

    def _get_index(self):  # pragma: no cover - requires live SDK
        if self._index_handle is None:
            if self._client_factory is not None:
                client = self._client_factory()
            else:
                from databricks.vector_search.client import VectorSearchClient
                client = VectorSearchClient()
            self._index_handle = client.get_index(
                endpoint_name=self.endpoint, index_name=self.index)
        return self._index_handle

    def retrieve(self, request: RetrievalRequest) -> list[Passage]:  # pragma: no cover
        index = self._get_index()
        col_set = {self._mapping.id_field, self._mapping.text_field}
        if self._mapping.score_field:
            col_set.add(self._mapping.score_field)
        col_set.update(self._mapping.metadata_fields)
        columns = list(col_set)
        kwargs = {"query_text": request.query, "columns": columns,
                  "num_results": request.clamped_top_k(self.capabilities().max_top_k)}
        if request.filters:
            kwargs["filters"] = request.filters
        res = index.similarity_search(**kwargs)
        data = res.get("result", {}).get("data_array", [])
        col_names = [c["name"] for c in res.get("manifest", {}).get("columns", [])]
        passages = []
        for row in data:
            record = dict(zip(col_names, row))
            passages.append(self._mapping.normalize(record, source=self.name))
        return passages


# --------------------------------------------------------------------------- #
# Federation / dedupe / RRF helpers (offline, pure)
# --------------------------------------------------------------------------- #
def federate(retrievers: list[Retriever], request: RetrievalRequest) -> list[list[Passage]]:
    """Run each retriever and return a list of ranked lists (no live calls here
    beyond what each retriever does; fixtures stay offline)."""
    return [r.retrieve(request) for r in retrievers]


def dedupe(passages: list[Passage]) -> list[Passage]:
    """Remove duplicates by id first, then by text fingerprint; keep best score."""
    best: dict[str, Passage] = {}
    for p in passages:
        key = p.id or p.fingerprint()
        cur = best.get(key)
        if cur is None or p.score > cur.score:
            best[key] = p
    # second pass: collapse identical text with different ids
    by_text: dict[str, Passage] = {}
    for p in best.values():
        fp = p.fingerprint()
        cur = by_text.get(fp)
        if cur is None or p.score > cur.score:
            by_text[fp] = p
    return sorted(by_text.values(), key=lambda p: p.score, reverse=True)


def rrf_fuse(ranked_lists: list[list[Passage]], *, k: int = 60,
             top_k: Optional[int] = None) -> list[Passage]:
    """Reciprocal Rank Fusion across ranked lists.

    score(p) = sum over lists of 1 / (k + rank). Identity is the passage id, or
    the text fingerprint when ids are absent/collide across providers.
    """
    scores: dict[str, float] = {}
    rep: dict[str, Passage] = {}
    for lst in ranked_lists:
        for rank, p in enumerate(lst, start=1):
            key = p.id or p.fingerprint()
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
            # keep a representative (highest native score)
            if key not in rep or p.score > rep[key].score:
                rep[key] = p
    fused = []
    for key, s in scores.items():
        base = rep[key]
        fused.append(Passage(id=base.id, text=base.text, score=round(s, 6),
                             source="rrf", metadata=base.metadata))
    fused.sort(key=lambda p: p.score, reverse=True)
    if top_k is not None:
        fused = fused[:top_k]
    return fused
