"""Driver: run one Sales <-> Supply Chain orchestration and print shared memory.

This exercises the FULL loop using the agents' SDK-independent logic functions,
so it works whether or not the a2a-sdk HTTP servers are running. It makes REAL
Bedrock calls (requires AWS credentials + Bedrock access).

Flow (mirrors ARCHITECTURE.md Section 2):
  1. Supply Chain receives the request and asks Sales for the demand signal.
  2. Sales returns the demand/fulfilment signal  -> SESSION.
  3. Supply Chain optimizes delivery (Bedrock)   -> SESSION.sc_plan.
  4. Sales reads sc_plan and produces the final fulfilment plan -> SESSION.

Usage:
    python run_demo.py "Fulfil 5,000 units of Product P from DC-Atlanta to
    Region-West, fastest viable; SLA 72h."
"""
from __future__ import annotations

import sys
import uuid

from memory import SESSION, AUDIT
import sales_agent
import supply_chain_agent


def run(request_text: str) -> None:
    session_id = f"run-{uuid.uuid4().hex[:8]}"
    print(f"\n=== Session {session_id} ===")
    print(f"Request: {request_text}\n")

    # 1 + 2) Supply Chain asks Sales; Sales returns the demand signal.
    signal = sales_agent.demand_signal(session_id, request_text)
    print("--- Sales: demand signal ---")
    print(signal, "\n")

    # 3) Supply Chain optimizes delivery using the sales signal + history.
    sc_plan = supply_chain_agent.optimize(session_id, request_text, signal)
    print("--- Supply Chain: optimized delivery ---")
    print(sc_plan, "\n")

    # 4) Sales reads sc_plan and produces the final fulfilment plan.
    fulfilment = sales_agent.plan(session_id, request_text, sc_plan)
    print("--- Sales: final fulfilment plan ---")
    print(fulfilment, "\n")

    # Shared memory + audit trail.
    print("--- Shared SESSION snapshot ---")
    for k, v in SESSION.snapshot(session_id).items():
        preview = str(v).replace("\n", " ")[:120]
        print(f"  {k}: {preview}...")

    print("\n--- AUDIT trail ---")
    for e in AUDIT.events(session_id):
        print(f"  [{e['actor']}] {e['action']}: {e['detail'][:80]}")


if __name__ == "__main__":
    default_request = (
        "Fulfil demand for 5,000 units of Product P from DC-Atlanta to "
        "Region-West, fastest viable; customer SLA is 72 hours."
    )
    run(sys.argv[1] if len(sys.argv) > 1 else default_request)
