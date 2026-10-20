"""Memory layers for multi-agent (Sales <-> Supply Chain) orchestration.

Tiers (see ARCHITECTURE.md Section 4):
  - SessionMemory : shared WORKING memory both agents read/write (key: session_id).
  - SemanticMemory: LONG-TERM recall (Bedrock KB / vector store) for history.
  - AuditMemory   : append-only EPISODIC log of every message/decision.

Backends are swappable. The defaults are in-memory (zero setup) for local dev.
For production, swap the internals for DynamoDB / Redis / Bedrock KB as noted.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any


class SessionMemory:
    """Shared working memory for one orchestration run.

    Both agents read and write the SAME session so they never drift. In
    production, replace ``_store`` with a DynamoDB table (durable) or Redis
    (fast), keyed by ``session_id``.
    """

    def __init__(self) -> None:
        self._store: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()

    def put(self, session_id: str, key: str, value: Any) -> None:
        with self._lock:
            self._store.setdefault(session_id, {})[key] = {
                "value": value,
                "ts": time.time(),
            }

    def get(self, session_id: str, key: str, default: Any = None) -> Any:
        with self._lock:
            return (
                self._store.get(session_id, {})
                .get(key, {})
                .get("value", default)
            )

    def snapshot(self, session_id: str) -> dict[str, Any]:
        """Return the full shared state for a session (for debugging / audit)."""
        with self._lock:
            return {
                k: v["value"]
                for k, v in self._store.get(session_id, {}).items()
            }


@dataclass
class SemanticMemory:
    """Long-term semantic recall.

    Dev: keeps the last N snippets in a list. Prod: embed + upsert into a
    Bedrock Knowledge Base or vector store, and ``recall`` via
    ``bedrock-agent-runtime.retrieve(knowledgeBaseId=self.kb_id, ...)``.

    Register the same KB in the platform Registry (type='Knowledge Base') and
    attach it to both agents via ``knowledgeRefs`` so it is governed.
    """

    kb_id: str | None = None
    _fallback: list[str] = field(default_factory=list)

    def remember(self, text: str) -> None:
        # prod: compute embedding and upsert into the KB / vector index.
        self._fallback.append(text)

    def recall(self, query: str, top_k: int = 3) -> list[str]:
        # prod: KB Retrieve filtered by metadata (e.g. region), return chunks.
        # dev: return the most recent snippets as a naive stand-in.
        return self._fallback[-top_k:]


@dataclass
class AuditMemory:
    """Append-only episodic log — the attributable trail (GxP-friendly).

    Prod: write each event to a DynamoDB append-only table; optionally forward
    to the platform Audit view.
    """

    _events: list[dict[str, Any]] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def log(self, session_id: str, actor: str, action: str, detail: str) -> None:
        with self._lock:
            self._events.append(
                {
                    "session_id": session_id,
                    "actor": actor,
                    "action": action,
                    "detail": detail,
                    "ts": time.time(),
                }
            )

    def events(self, session_id: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            if session_id is None:
                return list(self._events)
            return [e for e in self._events if e["session_id"] == session_id]


# Process-wide singletons so both agent modules share the same instances when
# run in-process (e.g. by run_demo.py). When each agent runs as its own server,
# point these at shared DynamoDB/Redis instead.
SESSION = SessionMemory()
SEMANTIC = SemanticMemory(kb_id=None)
AUDIT = AuditMemory()
