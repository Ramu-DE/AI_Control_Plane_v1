"""Supply Chain agent — A2A server.

Role: point-to-point fastest-delivery optimization based on demand. Uses the
Sales agent (A2A peer) to get the demand/fulfilment priority, then reasons on
Bedrock over recalled history + the sales signal.

SDK NOTE: the exact a2a-sdk class/method names evolve across versions. The
server wiring below is structured against the a2a-sdk shape; pin the SDK
version (see README) and adapt the marked lines to the installed API. The
``optimize`` function holds the agent's actual logic and is SDK-independent, so
``run_demo.py`` can exercise the full Sales<->Supply-Chain loop + memory without
a running HTTP server.
"""
from __future__ import annotations

import os

from bedrock_brain import reason
from memory import SESSION, SEMANTIC, AUDIT

SALES_URL = os.environ.get("SALES_URL", "http://localhost:9002")
SC_PORT = int(os.environ.get("SC_PORT", "9001"))

SYSTEM_PROMPT = (
    "You are the Supply Chain agent. Pick the fastest viable delivery mechanism "
    "point-to-point given demand priority. Be concrete about mode (air/ground/"
    "expedited), rough ETA, and any capacity constraints."
)


def optimize(session_id: str, request_text: str, sales_signal: str) -> str:
    """Core agent logic (SDK-independent).

    1) store the sales signal in SHARED session memory,
    2) recall relevant history from SEMANTIC memory,
    3) reason on Bedrock to produce the optimized delivery plan,
    4) persist the plan + remember the outcome, and audit the step.
    """
    SESSION.put(session_id, "sales_demand", sales_signal)
    AUDIT.log(session_id, "SupplyChainAgent", "received_sales_signal", sales_signal[:200])

    history = SEMANTIC.recall(request_text)
    plan = reason(
        SYSTEM_PROMPT,
        f"Request: {request_text}\n\n"
        f"Sales demand/fulfilment signal: {sales_signal}\n\n"
        f"Relevant history: {history}",
    )

    SESSION.put(session_id, "sc_plan", plan)
    SEMANTIC.remember(f"{request_text} -> {plan}")
    AUDIT.log(session_id, "SupplyChainAgent", "produced_plan", plan[:200])
    return plan


def build_agent_card():
    """Return the A2A AgentCard advertising this agent's skills."""
    # SDK-pinned import.
    from a2a.types import AgentCard, AgentCapabilities, AgentSkill

    return AgentCard(
        name="SupplyChainAgent",
        description="Point-to-point fastest-delivery optimization based on demand.",
        url=f"http://localhost:{SC_PORT}",
        version="1.0.0",
        capabilities=AgentCapabilities(streaming=True),
        skills=[
            AgentSkill(
                id="route_optimize",
                name="Route optimization",
                description="Fastest delivery mechanism for a given demand",
                tags=["logistics", "eta", "routing"],
            ),
            AgentSkill(
                id="eta_estimate",
                name="ETA estimate",
                description="Estimated delivery time for a route",
                tags=["eta"],
            ),
        ],
        default_input_modes=["text"],
        default_output_modes=["text"],
    )


def build_app():
    """Build the A2A Starlette application (adapt to the pinned SDK API)."""
    from a2a.server.apps import A2AStarletteApplication
    from a2a.server.request_handlers import DefaultRequestHandler
    from a2a.server.tasks import InMemoryTaskStore
    from a2a.server.agent_execution import AgentExecutor

    class SupplyChainExecutor(AgentExecutor):
        async def execute(self, context, event_queue) -> None:  # type: ignore[override]
            import httpx
            from a2a.client import A2AClient  # SDK-pinned

            session_id = getattr(context, "task_id", None) or "default"
            request_text = context.get_user_input()

            # Ask the SALES agent (A2A peer) for the demand/fulfilment signal.
            async with httpx.AsyncClient(timeout=60) as hc:
                sales = A2AClient(httpx_client=hc, url=SALES_URL)
                # NOTE: method name varies by SDK version; adapt as needed.
                sales_signal = await sales.send_message_text(
                    "Given this supply-chain request, what is the sales demand "
                    f"& fulfilment priority?\n{request_text}"
                )

            plan = optimize(session_id, request_text, str(sales_signal))
            await event_queue.enqueue_message_text(plan)  # adapt per SDK

        async def cancel(self, context, event_queue) -> None:  # type: ignore[override]
            ...

    return A2AStarletteApplication(
        agent_card=build_agent_card(),
        http_handler=DefaultRequestHandler(
            agent_executor=SupplyChainExecutor(),
            task_store=InMemoryTaskStore(),
        ),
    ).build()


# For `uvicorn supply_chain_agent:app --port 9001` once the SDK is pinned,
# uncomment the next line:
# app = build_app()

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(build_app(), host="0.0.0.0", port=SC_PORT)
