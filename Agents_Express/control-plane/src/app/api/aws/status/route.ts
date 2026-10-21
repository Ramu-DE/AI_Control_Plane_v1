import { NextResponse } from "next/server";
import {
  AwsConfigError,
  getExecutionMode,
  isAwsMode,
} from "@/lib/aws/config";
import { classifyAwsError } from "@/lib/aws/normalize";
import {
  getCallerIdentity,
  listBedrockAgents,
  listKnowledgeBases,
  listPolicyStores,
} from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

type ProbeState = "ok" | "access-denied" | "error" | "skipped";
interface Probe {
  service: string;
  state: ProbeState;
  detail?: string;
  count?: number;
}

// A single endpoint the UI uses to render the whole status panel: execution
// mode, resolved region, STS identity (account), and lightweight per-service
// probes. Nothing here mutates AWS; probes are list/describe calls only.
export async function GET() {
  const mode = getExecutionMode();

  // Resolve region honestly without a hardcoded fallback.
  let region: string | null = null;
  let regionError: string | null = null;
  try {
    const raw =
      (process.env.AWS_REGION || "").trim() ||
      (process.env.AWS_DEFAULT_REGION || "").trim();
    region = raw || null;
    if (!region) regionError = "AWS_REGION / AWS_DEFAULT_REGION not set";
  } catch {
    region = null;
  }

  if (!isAwsMode()) {
    return NextResponse.json({
      ok: true,
      mode,
      region,
      regionError,
      identity: null,
      probes: [] as Probe[],
      message:
        "Execution mode is 'local'. Set AWS_EXECUTION_MODE=aws (and a region) to run live probes.",
    });
  }

  if (!region) {
    return NextResponse.json(
      {
        ok: false,
        mode,
        region: null,
        regionError,
        code: "REGION_UNSET",
        error:
          "AWS region is not configured. Set AWS_REGION or AWS_DEFAULT_REGION.",
      },
      { status: 400 }
    );
  }

  // Identity probe (STS). If this fails with access/credential errors, surface
  // it but still attempt the service probes so the UI shows a full picture.
  let identity: { account: string; arn: string; userId: string } | null = null;
  let identityError: string | null = null;
  try {
    identity = await getCallerIdentity();
  } catch (err) {
    if (err instanceof AwsConfigError) {
      identityError = err.message;
    } else {
      const c = classifyAwsError(err);
      identityError = `${c.name}: ${c.message}`;
    }
  }

  const probes: Probe[] = [];
  async function probe(
    service: string,
    fn: () => Promise<{ length: number }>
  ) {
    try {
      const r = await fn();
      probes.push({ service, state: "ok", count: r.length });
    } catch (err) {
      const c = classifyAwsError(err);
      probes.push({
        service,
        state: c.kind === "access-denied" ? "access-denied" : "error",
        detail: `${c.name}`,
      });
    }
  }

  await Promise.all([
    probe("sts", async () => (identity ? ["x"] : [])),
    probe("bedrock-agent:knowledgeBases", async () => await listKnowledgeBases(1)),
    probe("bedrock-agent:agents", async () => await listBedrockAgents(1)),
    probe("verifiedpermissions:policyStores", async () => await listPolicyStores(1)),
  ]);

  return NextResponse.json({
    ok: true,
    mode,
    region,
    regionError: null,
    identity,
    identityError,
    probes,
  });
}
