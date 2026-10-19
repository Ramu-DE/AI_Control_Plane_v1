"""Central configuration for AgentExpress.

Values come from environment variables (optionally loaded from a local
``.env`` file) with sensible defaults, so the project runs locally with
minimal setup and the same code deploys unchanged to AgentCore Runtime.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _load_dotenv() -> None:
    """Minimal .env loader (no external dependency).

    Only sets variables that are not already present in the environment,
    so real environment variables always win over the .env file.
    """
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if not env_path.exists():
        return
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv()


@dataclass(frozen=True)
class Settings:
    """Runtime settings shared by every agent."""

    region: str = os.getenv("AWS_REGION", "us-east-1")
    model_id: str = os.getenv(
        "AGENTEXPRESS_MODEL_ID",
        "us.anthropic.claude-3-5-haiku-20241022-v1:0",
    )
    temperature: float = float(os.getenv("AGENTEXPRESS_TEMPERATURE", "0.3"))


settings = Settings()
