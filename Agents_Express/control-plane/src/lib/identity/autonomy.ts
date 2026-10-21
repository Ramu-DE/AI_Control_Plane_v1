// Autonomy classification (L0–L3) ↔ acts-as model ↔ required controls.
//
// Source mapping ("Agency and autonomy decide the pattern"):
//   L0  acts as: no one   → 2LO, or none
//   L1  acts as: the user → 3LO or OBO
//   L2  acts as: itself   → SigV4 or 2LO (M2M)
//   L3  acts as: both     → all, plus delegation policy
//
// Pure, deterministic, no I/O.

import type {
  ActsAs,
  AgentIdentityProfile,
  AutonomyLevel,
  OutboundPattern,
  RequiredControls,
} from "./types";

/** The canonical acts-as value for a level. */
export function actsAsForLevel(level: AutonomyLevel): ActsAs {
  switch (level) {
    case "L0":
      return "none";
    case "L1":
      return "user";
    case "L2":
      return "self";
    case "L3":
      return "both";
  }
}

/** The required identity controls for an autonomy level. */
export function requiredControls(level: AutonomyLevel): RequiredControls {
  switch (level) {
    case "L0":
      return {
        level,
        actsAs: "none",
        requiresUserContext: false,
        requiresWorkloadIdentity: false,
        requiresDelegationPolicy: false,
        allowedOutbound: ["m2m"],
        rationale:
          "Acts as no one. Conversational / uses the app's identity. 2LO (M2M) or no outbound.",
      };
    case "L1":
      return {
        level,
        actsAs: "user",
        requiresUserContext: true,
        requiresWorkloadIdentity: true,
        requiresDelegationPolicy: false,
        allowedOutbound: ["3lo", "obo"],
        rationale:
          "Acts for the user. Needs delegated access via 3LO or OBO; tokens carry sub=user, act=agent.",
      };
    case "L2":
      return {
        level,
        actsAs: "self",
        requiresUserContext: false,
        requiresWorkloadIdentity: true,
        requiresDelegationPolicy: false,
        allowedOutbound: ["iam", "m2m"],
        rationale:
          "Acts as itself (autonomous). Inbound SigV4 or 2LO; outbound IAM execution role or M2M. No user token.",
      };
    case "L3":
      return {
        level,
        actsAs: "both",
        requiresUserContext: true,
        requiresWorkloadIdentity: true,
        requiresDelegationPolicy: true,
        allowedOutbound: ["iam", "m2m", "3lo", "obo"],
        rationale:
          "Acts as both. All patterns plus an explicit delegation policy; scope shrinks at every hop.",
      };
  }
}

/** The full matrix (for the UI overview). */
export function autonomyMatrix(): RequiredControls[] {
  return (["L0", "L1", "L2", "L3"] as AutonomyLevel[]).map(requiredControls);
}

export interface ProfileValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate an identity profile against its declared autonomy level.
 * Rejects misconfigurations (e.g. L1 without user context, outbound patterns
 * not permitted at the level, L3 missing a delegation policy binding, etc.).
 */
export function validateProfile(
  profile: Pick<
    AgentIdentityProfile,
    "autonomyLevel" | "actsAs" | "inbound" | "outbound"
  >,
  opts: { hasWorkloadIdentity: boolean; hasDelegationPolicy: boolean }
): ProfileValidation {
  const errors: string[] = [];
  const req = requiredControls(profile.autonomyLevel);

  // acts-as must match the level's canonical value.
  const expectedActsAs = actsAsForLevel(profile.autonomyLevel);
  if (profile.actsAs !== expectedActsAs) {
    errors.push(
      `autonomy ${profile.autonomyLevel} requires actsAs="${expectedActsAs}", got "${profile.actsAs}"`
    );
  }

  // Workload identity required at L1/L2/L3.
  if (req.requiresWorkloadIdentity && !opts.hasWorkloadIdentity) {
    errors.push(
      `autonomy ${profile.autonomyLevel} requires a distinct workload identity (own client_id)`
    );
  }

  // Delegation policy required at L3.
  if (req.requiresDelegationPolicy && !opts.hasDelegationPolicy) {
    errors.push(
      `autonomy L3 requires an explicit delegation policy before cross-agent delegation`
    );
  }

  // User context: L1 must use a user-delegated outbound pattern.
  const patterns = new Set<OutboundPattern>(profile.outbound.map((o) => o.pattern));
  if (req.requiresUserContext && profile.autonomyLevel === "L1") {
    const hasUserPattern = profile.outbound.some(
      (o) => o.pattern === "3lo" || o.pattern === "obo"
    );
    if (profile.outbound.length > 0 && !hasUserPattern) {
      errors.push(
        `autonomy L1 acts for the user — outbound bindings must use 3LO or OBO (found: ${[...patterns].join(", ") || "none"})`
      );
    }
  }

  // Every outbound binding must use a pattern allowed at this level.
  for (const b of profile.outbound) {
    if (!req.allowedOutbound.includes(b.pattern)) {
      errors.push(
        `tool "${b.toolName}" uses outbound "${b.pattern}" which is not allowed at ${profile.autonomyLevel} (allowed: ${req.allowedOutbound.join(", ")})`
      );
    }
    // Incremental scopes must be disjoint from the up-front minimum.
    const overlap = b.incrementalScopes.filter((s) => b.minScopes.includes(s));
    if (overlap.length > 0) {
      errors.push(
        `tool "${b.toolName}": incremental scopes overlap minimum scopes (${overlap.join(", ")})`
      );
    }
  }

  // L0 must NOT carry a user-delegated pattern.
  if (profile.autonomyLevel === "L0") {
    const userPatterns = profile.outbound.filter(
      (o) => o.pattern === "3lo" || o.pattern === "obo"
    );
    if (userPatterns.length > 0) {
      errors.push(
        `autonomy L0 acts as no one — it must not use user-delegated patterns (3LO/OBO)`
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
