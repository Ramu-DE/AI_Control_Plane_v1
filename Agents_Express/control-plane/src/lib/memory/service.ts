// Governed memory service — the only composed path to agent recall.
//
// Order of operations fails closed at every step, mirroring the KB service:
//   1. the record must exist, be type "Memory", and be Approved
//   2. the scope is NARROWED to the record's declared ceiling
//   3. the namespace is DERIVED from the tenant tree and persona, never taken
//      from the caller
//   4. Cedar two-stage check (perimeter, then record-scoped)
//   5. the AWS call runs under the server's own role
//   6. results are re-checked against the requested scope before being returned
//   7. every outcome is audited WITH the namespace, so isolation is provable
//
// Step 6 is the one that looks redundant and is not. The service derives the
// namespace itself, so an out-of-scope record should be impossible — which is
// exactly why a non-zero `outOfScope` count must be surfaced loudly rather
// than filtered away. If it ever fires, something upstream is broken.
//
// Server-only.

import { logAudit, store } from "../store";
import { createEvent, describeAwsError, retrieveRecords } from "./client";
import { authorizeMemory, readMemoryConfig, tenantInSubtree } from "./logic";
import { actorKey, partitionByScope, renderNamespace, templateScope } from "./namespace";
import { MemoryConfigError, MemoryDeniedError, MemoryNotFoundError } from "./types";
import type { MemoryScope } from "./namespace";
import type { MemoryRetrieval, MemoryWriteResult } from "./types";
import type { MemoryTurn } from "./client";

export interface MemoryRequest {
  recordId: string;
  personaId: string;
  /** The tenant the work runs for. Checked against the record's owner tenant. */
  tenantId: string;
  /** The workflow run, used for session scope. */
  sessionId: string;
  scope?: MemoryScope;
}

/** Resolve the record and its config, or fail with a reason a caller can act on. */
function resolveRecord(recordId: string) {
  const record = store.records.find((r) => r.id === recordId);
  if (!record) {
    throw new MemoryNotFoundError(`memory record '${recordId}' not found`);
  }
  return { record, config: readMemoryConfig(record) };
}

/**
 * The tenant check. A memory record belongs to a tenant; a persona acting for a
 * different tenant may only reach it if that tenant is in the owner's subtree,
 * which mirrors how workflow steps resolve cross-tenant agents. A sibling is
 * never allowed, whatever Cedar says — this is a structural boundary, not a
 * policy preference.
 */
function assertTenantMayUse(recordOwnerTenant: string | undefined, tenantId: string) {
  // Unset means platform-wide, and Cedar governs alone. Note this reads the
  // DECLARED owner tenant from memoryConfig, not RegistryRecord.owner — the
  // latter is a user id, and using it here would refuse every call.
  if (!recordOwnerTenant) return;
  if (!tenantInSubtree(recordOwnerTenant, tenantId, store.tenants)) {
    throw new MemoryConfigError(
      `tenant '${tenantId}' is not within '${recordOwnerTenant}', which owns ` +
        `this memory; cross-tenant recall is refused`
    );
  }
}

// --------------------------------------------------------------------------- //
// Retrieve
// --------------------------------------------------------------------------- //
export async function retrieveMemory(
  req: MemoryRequest & { query: string }
): Promise<MemoryRetrieval> {
  const started = Date.now();
  const { record, config } = resolveRecord(req.recordId);
  assertTenantMayUse(config.ownerTenantId, req.tenantId);

  // The scope is a property of the strategy's TEMPLATE, not something the
  // caller picks: AgentCore matches a namespace exactly, so there is no way to
  // widen or narrow a read after the fact. A caller that asks for a scope this
  // record cannot serve is told so, rather than handed an empty result that
  // looks like "no memories yet".
  const scope = templateScope(config.namespaceTemplate);
  if (req.scope && req.scope !== scope) {
    throw new MemoryConfigError(
      `this memory is ${scope}-scoped (template '${config.namespaceTemplate}'); ` +
        `it cannot serve a '${req.scope}' read. Attach a memory whose strategy ` +
        `is ${req.scope}-scoped instead.`
    );
  }
  const namespace = renderNamespace(config.namespaceTemplate, {
    tenantId: req.tenantId,
    personaId: req.personaId,
    sessionId: req.sessionId,
  });

  const authorization = authorizeMemory(req.recordId, req.personaId);
  if (!authorization.allowed) {
    logAudit({
      category: "memory",
      action: "deny-retrieve",
      actor: req.personaId,
      detail:
        `DENY memory retrieve on '${record.name}' at ${namespace} — ` +
        `${authorization.recordScoped.evaluated
          ? authorization.recordScoped.reason
          : authorization.perimeter.reason}`,
    });
    throw new MemoryDeniedError(
      `memory retrieval denied for persona '${req.personaId}'`,
      authorization
    );
  }

  let found;
  try {
    found = await retrieveRecords({
      region: config.region,
      memoryId: config.memoryId,
      namespace,
      query: req.query,
      topK: config.topK,
    });
  } catch (e) {
    const detail = describeAwsError(e);
    logAudit({
      category: "memory",
      action: "retrieve-failed",
      actor: req.personaId,
      detail: `Memory retrieve failed on '${record.name}' at ${namespace}: ${detail}`,
    });
    throw new MemoryConfigError(detail);
  }

  // Prove the scope held, rather than trusting it.
  const { kept, escaped } = partitionByScope(found, namespace);
  const floor = config.minRelevance;
  const above =
    floor === undefined
      ? kept
      : kept.filter((r) => r.relevance === undefined || r.relevance >= floor);
  const belowThreshold = kept.length - above.length;

  logAudit({
    category: "memory",
    action: "retrieve",
    actor: req.personaId,
    detail:
      `Retrieved ${above.length}/${config.topK} memory record(s) from '${record.name}' ` +
      `at ${namespace} (scope ${scope}` +
      `${belowThreshold ? `, ${belowThreshold} below relevance floor` : ""}` +
      `${escaped.length ? `, ${escaped.length} OUT OF SCOPE` : ""})`,
  });

  return {
    memoryId: config.memoryId,
    strategyId: config.strategyId,
    scope,
    namespace,
    records: above,
    topK: config.topK,
    returned: above.length,
    belowThreshold,
    outOfScope: escaped.length,
    latencyMs: Date.now() - started,
    authorization,
  };
}

// --------------------------------------------------------------------------- //
// Write
// --------------------------------------------------------------------------- //
export async function recordTurns(
  req: MemoryRequest & { turns: MemoryTurn[] }
): Promise<MemoryWriteResult> {
  const started = Date.now();
  const { record, config } = resolveRecord(req.recordId);
  assertTenantMayUse(config.ownerTenantId, req.tenantId);

  if (!req.turns.length) {
    throw new MemoryConfigError("at least one turn is required to record memory");
  }

  // Writes are always session-scoped: a raw turn belongs to the conversation
  // that produced it, and widening must be a deliberate promotion rather than
  // a side effect of logging. Raw events are the least reviewed thing here.
  const namespace = renderNamespace(config.namespaceTemplate, {
    tenantId: req.tenantId,
    personaId: req.personaId,
    sessionId: req.sessionId,
  });

  const authorization = authorizeMemory(req.recordId, req.personaId);
  if (!authorization.allowed) {
    logAudit({
      category: "memory",
      action: "deny-write",
      actor: req.personaId,
      detail: `DENY memory write on '${record.name}' at ${namespace}`,
    });
    throw new MemoryDeniedError(
      `memory write denied for persona '${req.personaId}'`,
      authorization
    );
  }

  let eventId: string | undefined;
  try {
    const res = await createEvent({
      region: config.region,
      memoryId: config.memoryId,
      // MUST be the COMPOSITE key, not the bare persona. AgentCore interpolates
      // this into the namespace template, so if the tenant were missing here,
      // extraction would write to a tenant-less path and the isolation this
      // whole module rests on would be gone — while every test on the read side
      // still passed.
      actorId: actorKey(req.tenantId, req.personaId),
      sessionId: req.sessionId,
      turns: req.turns,
    });
    eventId = res.eventId;
  } catch (e) {
    const detail = describeAwsError(e);
    logAudit({
      category: "memory",
      action: "write-failed",
      actor: req.personaId,
      detail: `Memory write failed on '${record.name}' at ${namespace}: ${detail}`,
    });
    throw new MemoryConfigError(detail);
  }

  logAudit({
    category: "memory",
    action: "write",
    actor: req.personaId,
    detail:
      `Recorded ${req.turns.length} turn(s) to '${record.name}' at ${namespace}` +
      `${eventId ? ` (event ${eventId})` : ""}. Long-term extraction is ` +
      `asynchronous, so these facts are not immediately retrievable.`,
  });

  return {
    memoryId: config.memoryId,
    namespace,
    ...(eventId ? { eventId } : {}),
    turns: req.turns.length,
    latencyMs: Date.now() - started,
    authorization,
  };
}
