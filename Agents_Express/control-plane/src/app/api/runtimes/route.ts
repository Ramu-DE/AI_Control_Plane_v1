import { NextResponse } from "next/server";
import {
  DEFAULT_AGENT_RUNTIME_ID,
  DEFAULT_MODEL_RUNTIME_ID,
  RUNTIME_OPTIONS,
  groupRuntimeOptions,
} from "@/lib/runtimes";

export async function GET() {
  return NextResponse.json({
    defaults: {
      agentRuntimeId: DEFAULT_AGENT_RUNTIME_ID,
      modelRuntimeId: DEFAULT_MODEL_RUNTIME_ID,
    },
    planes: {
      agenticWorkload: groupRuntimeOptions("agentic-workload"),
      modelInference: groupRuntimeOptions("model-inference"),
    },
    options: RUNTIME_OPTIONS,
  });
}
