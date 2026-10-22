// AgentCore Memory client — the only module that talks to AWS.
//
// Deliberately thin. It makes no policy decision, derives no namespace and
// writes no audit entry: those belong to logic.ts and service.ts, so the
// governance is testable without AWS. This file's job is to call the service
// and normalise what comes back.
//
// Credentials come from the server's own role, exactly as the Bedrock path
// does. Nothing here reads a token from a record.
//
// Server-only.

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import type { MemoryRecordView } from "./types";

const clients = new Map<string, BedrockAgentCoreClient>();

function clientFor(region: string): BedrockAgentCoreClient {
  const existing = clients.get(region);
  if (existing) return existing;
  const created = new BedrockAgentCoreClient({ region });
  clients.set(region, created);
  return created;
}

export interface MemoryTurn {
  role: "USER" | "ASSISTANT";
  text: string;
}

/**
 * Append a turn pair to short-term memory.
 *
 * The event is what long-term extraction later runs over, so the write must be
 * scoped correctly at the moment it happens — see `writeNamespace`. Extraction
 * is asynchronous and service-managed; this call does not wait for it, and the
 * caller must not imply that a fact is immediately retrievable.
 */
export async function createEvent(args: {
  region: string;
  memoryId: string;
  actorId: string;
  sessionId: string;
  turns: MemoryTurn[];
}): Promise<{ eventId?: string }> {
  const res = await clientFor(args.region).send(
    new CreateEventCommand({
      memoryId: args.memoryId,
      actorId: args.actorId,
      sessionId: args.sessionId,
      eventTimestamp: new Date(),
      payload: args.turns.map((t) => ({
        conversational: {
          role: t.role,
          content: { text: t.text },
        },
      })),
    })
  );
  return { eventId: res.event?.eventId };
}

/**
 * Retrieve long-term records from ONE namespace.
 *
 * The namespace is passed in already derived and validated — this function must
 * never build one, or the isolation control would live in two places.
 */
export async function retrieveRecords(args: {
  region: string;
  memoryId: string;
  namespace: string;
  query: string;
  topK: number;
}): Promise<MemoryRecordView[]> {
  const res = await clientFor(args.region).send(
    new RetrieveMemoryRecordsCommand({
      memoryId: args.memoryId,
      namespace: args.namespace,
      searchCriteria: { searchQuery: args.query, topK: args.topK },
      maxResults: args.topK,
    })
  );
  const found = res.memoryRecordSummaries ?? [];
  return found.map((r) => ({
    recordId: String(r.memoryRecordId ?? ""),
    // Kept so the service can PROVE the result stayed in scope rather than
    // assume it. A provider that omits this is treated as out of scope.
    namespace: Array.isArray(r.namespaces) ? r.namespaces[0] : undefined,
    content: String(r.content?.text ?? ""),
    ...(typeof r.score === "number" ? { relevance: r.score } : {}),
    ...(r.createdAt ? { createdAt: new Date(r.createdAt).toISOString() } : {}),
    ...(r.memoryStrategyId ? { metadata: { strategyId: r.memoryStrategyId } } : {}),
  }));
}

/** Translate an AWS failure into something a caller can act on. */
export function describeAwsError(e: unknown): string {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? "Error";
  const msg = err?.message ?? String(e);
  if (name === "ResourceNotFoundException") {
    return `AgentCore memory or namespace not found: ${msg}`;
  }
  if (name === "AccessDeniedException") {
    return (
      `AWS denied the AgentCore Memory call (${msg}). The server's role needs ` +
      `bedrock-agentcore permissions for this memory.`
    );
  }
  if (name === "ValidationException") {
    return `AgentCore rejected the request: ${msg}`;
  }
  if (name === "ThrottlingException") {
    return `AgentCore throttled the request: ${msg}`;
  }
  return `AgentCore Memory ${name}${status ? ` (HTTP ${status})` : ""}: ${msg}`;
}
