// Mapping lifecycle API — build runs, proposals, approve/reject, publish.
//
// GET    /api/graph/mappings?graphSourceId=...        -> build runs + proposals + versions
// POST   { op: "startBuild" | "addProposals" | "decide" | "publish", ... }
//
// All reads/writes go through the async GraphControlStore. Decisions require a
// mandatory reviewer + note. Publish is gated: every included proposal must be
// approved AND valid (no blocking issues).

import { NextRequest, NextResponse } from "next/server";
import { logAudit } from "@/lib/store";
import { GraphControlConfigError } from "@/lib/graph/factory";
import {
  addProposals,
  controlStore,
  decideProposals,
  publishMappingVersion,
  startBuildRun,
  NotFoundError,
  PublishGateError,
} from "@/lib/graph/service";
import type { ProposalInput } from "@/lib/graph/service";
import { validateDecisionInput } from "@/lib/graph/logic";

export const runtime = "nodejs";

function configError(e: unknown): NextResponse | null {
  if (e instanceof GraphControlConfigError) {
    return NextResponse.json({ error: e.message, code: e.code }, { status: 412 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const graphSourceId = req.nextUrl.searchParams.get("graphSourceId") ?? undefined;
  const buildRunId = req.nextUrl.searchParams.get("buildRunId") ?? undefined;
  if (!graphSourceId) {
    return NextResponse.json({ error: "graphSourceId is required" }, { status: 400 });
  }
  try {
    const ctl = await controlStore();
    const [buildRuns, proposals, versions] = await Promise.all([
      ctl.listBuildRuns({ graphSourceId }),
      ctl.listProposals({ graphSourceId, buildRunId }),
      ctl.listMappingVersions(graphSourceId),
    ]);
    return NextResponse.json({ graphSourceId, buildRuns, proposals, versions });
  } catch (e) {
    const ce = configError(e);
    if (ce) return ce;
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

type StartBuildBody = { op: "startBuild"; graphSourceId: string; trigger?: string };
type AddProposalsBody = {
  op: "addProposals";
  graphSourceId: string;
  buildRunId: string;
  proposals: ProposalInput[];
};
type DecideBody = {
  op: "decide";
  proposalIds: string[];
  decision: "approved" | "rejected";
  reviewer: string;
  note: string;
};
type PublishBody = {
  op: "publish";
  graphSourceId: string;
  buildRunId: string;
  publishedBy?: string;
};
type Body = StartBuildBody | AddProposalsBody | DecideBody | PublishBody;

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.op) {
      case "startBuild": {
        if (!body.graphSourceId) {
          return NextResponse.json({ error: "graphSourceId is required" }, { status: 400 });
        }
        const run = await startBuildRun(body.graphSourceId, body.trigger || "manual");
        logAudit({
          category: "graph",
          action: "build-start",
          actor: "console-user",
          detail: `Build run ${run.buildRunId} started for '${body.graphSourceId}'`,
        });
        return NextResponse.json(run, { status: 201 });
      }

      case "addProposals": {
        if (!body.graphSourceId || !body.buildRunId || !Array.isArray(body.proposals)) {
          return NextResponse.json(
            { error: "graphSourceId, buildRunId and proposals[] are required" },
            { status: 400 }
          );
        }
        const created = await addProposals(body.graphSourceId, body.buildRunId, body.proposals);
        logAudit({
          category: "graph",
          action: "proposals-add",
          actor: "build-plane",
          detail: `${created.length} proposal(s) added to build ${body.buildRunId}`,
        });
        return NextResponse.json({ created }, { status: 201 });
      }

      case "decide": {
        const inputError = validateDecisionInput(body);
        if (inputError) return NextResponse.json({ error: inputError }, { status: 400 });
        if (!Array.isArray(body.proposalIds) || body.proposalIds.length === 0) {
          return NextResponse.json({ error: "proposalIds[] is required" }, { status: 400 });
        }
        if (body.decision !== "approved" && body.decision !== "rejected") {
          return NextResponse.json({ error: "decision must be approved|rejected" }, { status: 400 });
        }
        const results = await decideProposals(
          body.proposalIds,
          body.decision,
          body.reviewer,
          body.note
        );
        logAudit({
          category: "graph",
          action: `proposals-${body.decision}`,
          actor: body.reviewer,
          detail: `${results.filter((r) => r.ok).length}/${results.length} proposal(s) ${body.decision} — ${body.note}`,
        });
        const anyFail = results.some((r) => !r.ok);
        return NextResponse.json({ results }, { status: anyFail ? 207 : 200 });
      }

      case "publish": {
        if (!body.graphSourceId || !body.buildRunId) {
          return NextResponse.json(
            { error: "graphSourceId and buildRunId are required" },
            { status: 400 }
          );
        }
        const version = await publishMappingVersion(
          body.graphSourceId,
          body.buildRunId,
          body.publishedBy || "console-user"
        );
        logAudit({
          category: "graph",
          action: "mapping-publish",
          actor: version.publishedBy,
          detail: `Published mapping v${version.version} for '${body.graphSourceId}' (${version.proposalIds.length} mappings)`,
        });
        return NextResponse.json(version, { status: 201 });
      }

      default:
        return NextResponse.json({ error: "unknown operation" }, { status: 400 });
    }
  } catch (e) {
    const ce = configError(e);
    if (ce) return ce;
    if (e instanceof NotFoundError) {
      return NextResponse.json({ error: (e as Error).message }, { status: 404 });
    }
    if (e instanceof PublishGateError) {
      return NextResponse.json({ error: (e as Error).message, code: "PUBLISH_GATE" }, { status: 409 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
