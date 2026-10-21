// Scope algebra — subset checks, minimum-viable scopes, and scope-drift
// detection (PDF anti-pattern #3: over-scoped grants; "minimum viable scopes +
// incremental consent" and "automated scope-drift detection on every deploy").
//
// Pure, deterministic, no I/O. Scopes are compared case-sensitively as opaque
// strings (e.g. "repo", "Mail.Read", "dynamodb:PutItem").

/** Normalize a scope list: trim, drop empties, de-duplicate, sort. */
export function normalizeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0))
  ).sort();
}

/** True iff every scope in `child` is also present in `parent`. */
export function isSubset(child: string[], parent: string[]): boolean {
  const p = new Set(parent.map((s) => s.trim()));
  return child.every((s) => p.has(s.trim()));
}

/** The scopes present in `child` but NOT in `parent` (the over-ask). */
export function excessScopes(child: string[], parent: string[]): string[] {
  const p = new Set(parent.map((s) => s.trim()));
  return normalizeScopes(child.filter((s) => !p.has(s.trim())));
}

/**
 * The minimum viable scopes to request up front: everything the operation
 * strictly needs, with incremental scopes deferred. Here `needed` is the set a
 * tool call strictly requires; incremental scopes are removed from the up-front
 * ask so they can be requested on explicit user action instead.
 */
export function minimumScopes(needed: string[], incremental: string[]): string[] {
  const inc = new Set(incremental.map((s) => s.trim()));
  return normalizeScopes(needed.filter((s) => !inc.has(s.trim())));
}

export interface ScopeDrift {
  drifted: boolean;
  /** Scopes requested that exceed what is allowed. */
  excess: string[];
  /** Allowed scopes that are not being requested (informational). */
  unused: string[];
}

/**
 * Detect scope drift between what a deployment REQUESTS and what policy ALLOWS.
 * `drifted` is true when the request asks for anything beyond the allowed set.
 */
export function detectDrift(requested: string[], allowed: string[]): ScopeDrift {
  const excess = excessScopes(requested, allowed);
  const req = new Set(requested.map((s) => s.trim()));
  const unused = normalizeScopes(allowed.filter((s) => !req.has(s.trim())));
  return { drifted: excess.length > 0, excess, unused };
}
