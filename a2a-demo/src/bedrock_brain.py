"""Bedrock Converse reasoning helper — the LLM 'brain' each agent uses.

Uses the same inference profiles the Agent Management Platform uses, so behavior
matches what you see in the platform's Workflows/Playground.

Credentials come from the environment (instance role here, or AWS_* env vars).
boto3 is imported lazily so this module stays importable (and py_compile-clean)
even in environments without boto3 installed.
"""
from __future__ import annotations

import os

# Inference profiles verified to work in this account (cross-region "us." IDs).
MODEL_HAIKU = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
MODEL_SONNET = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
MODEL_OPUS = "us.anthropic.claude-opus-4-5-20251101-v1:0"

DEFAULT_MODEL = os.environ.get("A2A_MODEL_ID", MODEL_HAIKU)
REGION = os.environ.get("AWS_REGION", "us-east-1")

_client = None


def _get_client():
    """Lazily create and cache a single Bedrock runtime client."""
    global _client
    if _client is None:
        import boto3  # imported here so the module imports without boto3

        _client = boto3.client("bedrock-runtime", region_name=REGION)
    return _client


def reason(
    system: str,
    user: str,
    *,
    model_id: str | None = None,
    max_tokens: int = 600,
    temperature: float = 0.2,
) -> str:
    """Run one Converse call and return the concatenated text output."""
    resp = _get_client().converse(
        modelId=model_id or DEFAULT_MODEL,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": max_tokens, "temperature": temperature},
    )
    parts = resp["output"]["message"]["content"]
    return "".join(p.get("text", "") for p in parts)


if __name__ == "__main__":
    # Smoke test: python bedrock_brain.py
    print(reason("You are a terse assistant.", "Say OK and nothing else.", max_tokens=10))
