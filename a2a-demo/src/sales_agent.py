"""Sales agent — A2A server.

Role: demand & supply fulfilment planning. Reads the Supply Chain agent's
optimized delivery (from shared session memory if present, else via A2A) and
produces a fulfilment plan that maximizes sales within delivery constraints.

SDK NOTE: same as supply_chain_agent.py — the ``plan`` and ``demand_signal``
functions hold SDK-independent logic so run_demo.py can exercise the loop.
"""
from __future__ import annotations

import os

from bedrock_brain import reason
from memory import SESSION, AUDIT

SUPPLY_CHAIN_URL = os.environ.get("SUPPLY_CHAIN_URL", "http://localhost:9001")
SALES_PORT = int(os.environ.get("SALES_PORT", "9002"))

SYSTEM_PROMPT = (
    "You are the Sales agent. Balance demand vs supply and return a fulfilment "
    "plan that maximizes sales given the delivery constraints. Call out demand "
    "priority, fill rate, and any revenue-at-risk."
)


def demand_signal(session_id: str, request_text: str) -> str:
    """Produce the demand/fulfilment priority signal the Supply Chain agent asks
    for at the start of a run. SDK-independent."""
    signal = reason(
        SYSTEM_PROMPT,
        "Summarize the demand and fulfilment priority for this request in 3-4 "
        f"concise bullet points:\n{request_text}",
        max_tokens=300,
    )
    SESSION.put(session_id, "sales_demand_signal", signal)
    AUDIT.log(session_id, "SalesAgent", "produced_demand_signal", signal[:200])
    return signal


def plan(session_id: str, request_text: str, sc_plan: str | None = None) -> str:
    """Final pass: read Supply Chain's optimized delivery and produce the
    fulfilment plan. SDK-independent."""
    if sc_plan is None:
        sc_plan = SESSION.get(session_id, "sc_plan", "")
    AUDIT.log(session_id, "SalesAgent", "read_sc_plan", str(sc_plan)[:200])

    result = reason(
        SYSTEM_PROMPT,
        f"Demand request: {request_text}\n\n"
        f"Supply-chain optimized delivery: {sc_plan}\n\n"
        "Produce the fulfilment plan now.",
    )
    SESSION.put(session_id, "sales_plan", result)
    AUDIT.log(session_id, "SalesAgent", "produced_fulfilment_plan", result[:200])
    return result


def build_agent_card():
    from a2a.types import AgentCard, AgentCapabilities, AgentSkill

    return AgentCard(
        name="SalesAgent",
        description="Demand & supply fulfilment planning.",
        url=f"http://localhost:{SALES_PORT}",
        version="1.0.0",
        capabilities=AgentCapabilities(streaming=True),
        skills=[
            AgentSkill(
                id="demand_signal",
                name="Demand signal",
                description="Demand & fulfilment priority for a request",
                tags=["sales", "demand"],
            ),
            AgentSkill(
                id="fulfilment_plan",
                name="Fulfilment planning",
                description="Fulfilment plan that maximizes sales",
                tags=["sales", "fulfilment"],
            ),
        ],
        default_input_modes=["text"],
        default_output_modes=["text"],
    )


def build_app():
    from a2a.server.apps import A2AStarletteApplication
    from a2a.server.request_handlers import DefaultRequestHandler
    from a2a.server.tasks import InMemoryTaskStore
    from a2a.server.agent_execution import AgentExecutor

    class SalesExecutor(AgentExecutor):
        async def execute(self, context, event_queue) -> None:  # type: ignore[override]
            session_id = getattr(context, "task_id", None) or "default"
            ask = context.get_user_input()

            # If Supply Chain hasn't written its plan yet, this is the opening
            # "demand signal" request; otherwise do the final fulfilment pass.
            sc_plan = SESSION.get(session_id, "sc_plan")
            if sc_plan is None:
                out = demand_signal(session_id, ask)
            else:
                out = plan(session_id, ask, sc_plan)
            await event_queue.enqueue_message_text(out)  # adapt per SDK

        async def cancel(self, context, event_queue) -> None:  # type: ignore[override]
            ...

    return A2AStarletteApplication(
        agent_card=build_agent_card(),
        http_handler=DefaultRequestHandler(
            agent_executor=SalesExecutor(),
            task_store=InMemoryTaskStore(),
        ),
    ).build()


# app = build_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=SALES_PORT)
