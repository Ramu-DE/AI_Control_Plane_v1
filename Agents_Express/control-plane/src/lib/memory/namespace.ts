// Memory namespaces — the tenant isolation control.
//
// AgentCore Memory scopes every record by namespace, and namespace design IS
// the isolation boundary: get it wrong and one tenant's memories are
// retrievable by another. The failures are not hypothetical — a tenant
// isolation flaw in Asana's MCP server exposed other organisations' data in
// June 2025, and a Redis client bug showed ChatGPT users each other's chat
// titles in March 2023.
//
// TWO CONSTRAINTS FROM THE BACKEND SHAPE THIS DESIGN, both verified against a
// live AgentCore memory rather than assumed:
//
//  1. A namespace template may only interpolate `{actorId}` and `{sessionId}`,
//     each at most once. There is NO tenant variable — `CreateMemory` rejects
//     a template that repeats one. So the tenant cannot be its own path
//     segment unless you run one memory resource per tenant.
//
//     Therefore the tenant is encoded INTO the actor id: `<tenantId>__<persona>`.
//     That puts it in every namespace path, which makes isolation structural —
//     a caller cannot produce another tenant's namespace, because it does not
//     supply the actor id; the service derives it from the tenant the work runs
//     for. Encoding it this way is not cosmetic: it is what makes a prefix
//     comparison a real tenant check.
//
//  2. Retrieval must use the SAME namespace that extraction wrote to. So the
//     namespace is RENDERED from the template stored on the approved record,
//     not rebuilt from a hard-coded shape here. If the two ever disagreed,
//     retrieval would silently return nothing and look like "no memories yet".
//
// `tenant` and `strategy` scopes are therefore NOT offered: this backend cannot
// express them without a per-tenant resource, and a scope that renders a path
// nothing was written to is worse than no scope at all. Shared knowledge
// belongs in an approved Knowledge Base record, which has its own Cedar gate.
//
// Pure — no I/O, no SDK.

/** How wide a retrieval may search. Narrower is always safer. */
export type MemoryScope = "session" | "actor";

/** Ordered narrowest → widest, which is also increasing order of risk. */
export const MEMORY_SCOPES: readonly MemoryScope[] = ["session", "actor"] as const;

/** Separates tenant from persona inside the composite actor id. */
export const ACTOR_SEPARATOR = "__";

export class MemoryNamespaceError extends Error {
  readonly code = "MEMORY_NAMESPACE";
  constructor(message: string) {
    super(message);
    this.name = "MemoryNamespaceError";
  }
}

/**
 * Identifiers become path segments, so a value containing `/` or `..` could
 * climb out of its own scope into a sibling tenant's. Refuse rather than
 * escape: these ids come from the platform's own records, so a bad one means
 * something upstream is wrong and should be surfaced, not quietly rewritten.
 *
 * The separator is excluded from tenant and persona ids so the composite actor
 * id can always be split back apart unambiguously.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/;

export function assertSegment(label: string, value: string): string {
  if (typeof value !== "string" || !SEGMENT.test(value)) {
    throw new MemoryNamespaceError(
      `${label} '${value}' is not a safe namespace segment (letters, digits, ` +
        `dot, dash; no '/', no '..', no '${ACTOR_SEPARATOR}')`
    );
  }
  return value;
}

/**
 * The composite actor id: tenant first, so a prefix comparison on the rendered
 * path is a genuine tenant check.
 */
export function actorKey(tenantId: string, personaId: string): string {
  return `${assertSegment("tenantId", tenantId)}${ACTOR_SEPARATOR}${assertSegment(
    "personaId",
    personaId
  )}`;
}

/** Split a composite actor id back into its parts. */
export function parseActorKey(
  key: string
): { tenantId: string; personaId: string } | null {
  const idx = key.indexOf(ACTOR_SEPARATOR);
  if (idx <= 0) return null;
  const tenantId = key.slice(0, idx);
  const personaId = key.slice(idx + ACTOR_SEPARATOR.length);
  if (!tenantId || !personaId) return null;
  return { tenantId, personaId };
}

export interface NamespaceParts {
  tenantId: string;
  personaId: string;
  /** Required only when the template interpolates {sessionId}. */
  sessionId?: string;
}

/**
 * Render the session namespace from the record's declared template.
 *
 * The template is the single source of truth, because extraction writes to it.
 * An unknown placeholder is refused rather than left in the path, where it
 * would produce a namespace nothing was ever written to.
 */
export function renderNamespace(template: string, parts: NamespaceParts): string {
  if (typeof template !== "string" || !template.startsWith("/")) {
    throw new MemoryNamespaceError(
      `namespace template must be an absolute path, got '${template}'`
    );
  }
  const actor = actorKey(parts.tenantId, parts.personaId);
  let rendered = template.replace("{actorId}", actor);
  if (template.includes("{sessionId}")) {
    if (!parts.sessionId) {
      throw new MemoryNamespaceError(
        "this memory's template is session-scoped, so a sessionId is required"
      );
    }
    rendered = rendered.replace("{sessionId}", assertSegment("sessionId", parts.sessionId));
  }
  const leftover = /\{([A-Za-z]+)\}/.exec(rendered);
  if (leftover) {
    throw new MemoryNamespaceError(
      `namespace template placeholder '{${leftover[1]}}' is not supported; ` +
        `AgentCore interpolates only {actorId} and {sessionId}`
    );
  }
  return stripTrailingSlash(rendered);
}

/**
 * The scope a template can actually serve, read from its shape.
 *
 * THIS REPLACES TRUNCATION, and the reason matters. The first version rendered
 * the session namespace and cut it at `/session/` to get an "actor scope".
 * Verified against a live memory: that returns NOTHING. AgentCore's
 * `RetrieveMemoryRecords` matches a namespace EXACTLY — it does not do prefix
 * search — so a truncated path is a path nothing was ever written to, and the
 * result is indistinguishable from "this user has no memories". Silent and
 * convincing, which is the worst combination.
 *
 * So scope is not something a caller chooses and we then satisfy; it is a
 * property of the strategy's template. A template ending in `/session/{sessionId}`
 * serves one conversation. One ending at `/actor/{actorId}` serves that actor
 * across every session — which is the point of long-term memory.
 */
export function templateScope(template: string): MemoryScope {
  return template.includes("{sessionId}") ? "session" : "actor";
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Does `candidate` sit inside `scope`? Compared segment-wise, so a sibling
 * with a shared textual prefix (`takeda-labs` against `takeda`) is NOT treated
 * as inside — that mistake is the whole cross-tenant failure mode.
 */
export function isWithin(candidate: string, scope: string): boolean {
  if (typeof candidate !== "string" || typeof scope !== "string") return false;
  const c = stripTrailingSlash(candidate);
  const s = stripTrailingSlash(scope);
  if (c === s) return true;
  return c.startsWith(`${s}/`);
}

/** The tenant a rendered namespace belongs to, or null if it has no actor segment. */
export function tenantOf(namespace: string): string | null {
  const m = /\/actor\/([^/]+)/.exec(namespace);
  if (!m) return null;
  return parseActorKey(m[1])?.tenantId ?? null;
}

/**
 * Reject any retrieval result whose namespace falls outside the scope we asked
 * for. Defence in depth: the service derives the namespace itself, so this
 * should never fire — which is exactly why a non-zero result must be REPORTED
 * rather than quietly filtered. A record with no namespace cannot be proven
 * in-scope and is treated as an escape, not given the benefit of the doubt.
 */
export function partitionByScope<T extends { namespace?: string }>(
  records: T[],
  scope: string
): { kept: T[]; escaped: T[] } {
  const kept: T[] = [];
  const escaped: T[] = [];
  for (const r of records) {
    if (r.namespace && isWithin(r.namespace, scope)) kept.push(r);
    else escaped.push(r);
  }
  return { kept, escaped };
}
