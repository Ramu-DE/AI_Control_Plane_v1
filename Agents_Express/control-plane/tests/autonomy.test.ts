// Offline tests: autonomy classification/validation + scope algebra.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actsAsForLevel,
  autonomyMatrix,
  requiredControls,
  validateProfile,
} from "../src/lib/identity/autonomy.ts";
import {
  detectDrift,
  excessScopes,
  isSubset,
  minimumScopes,
  normalizeScopes,
} from "../src/lib/identity/scopes.ts";
import type { AgentIdentityProfile } from "../src/lib/identity/types.ts";

test("actsAs mapping follows L0..L3", () => {
  assert.equal(actsAsForLevel("L0"), "none");
  assert.equal(actsAsForLevel("L1"), "user");
  assert.equal(actsAsForLevel("L2"), "self");
  assert.equal(actsAsForLevel("L3"), "both");
});

test("required controls: L2 needs workload identity, not delegation", () => {
  const r = requiredControls("L2");
  assert.equal(r.requiresWorkloadIdentity, true);
  assert.equal(r.requiresDelegationPolicy, false);
  assert.deepEqual(r.allowedOutbound.sort(), ["iam", "m2m"]);
});

test("required controls: L3 needs delegation policy + all patterns", () => {
  const r = requiredControls("L3");
  assert.equal(r.requiresDelegationPolicy, true);
  assert.deepEqual(r.allowedOutbound.sort(), ["3lo", "iam", "m2m", "obo"]);
});

test("autonomy matrix returns all four levels", () => {
  assert.equal(autonomyMatrix().length, 4);
});

const base = (
  level: AgentIdentityProfile["autonomyLevel"],
  outbound: AgentIdentityProfile["outbound"]
): Pick<AgentIdentityProfile, "autonomyLevel" | "actsAs" | "inbound" | "outbound"> => ({
  autonomyLevel: level,
  actsAs: actsAsForLevel(level),
  inbound: { kind: "oidc", issuer: "iss", audience: "aud", requiredScopes: [] },
  outbound,
});

test("valid L1 profile with OBO passes", () => {
  const v = validateProfile(
    base("L1", [
      { toolName: "t", pattern: "obo", resource: "r", minScopes: ["Mail.Read"], incrementalScopes: ["Mail.Send"] },
    ]),
    { hasWorkloadIdentity: true, hasDelegationPolicy: false }
  );
  assert.equal(v.valid, true, v.errors.join("; "));
});

test("L1 without workload identity is rejected", () => {
  const v = validateProfile(base("L1", []), {
    hasWorkloadIdentity: false,
    hasDelegationPolicy: false,
  });
  assert.equal(v.valid, false);
  assert.match(v.errors.join(" "), /workload identity/);
});

test("L1 using iam outbound is rejected (must act for user)", () => {
  const v = validateProfile(
    base("L1", [
      { toolName: "t", pattern: "iam", resource: "s3", minScopes: ["s3:Get"], incrementalScopes: [] },
    ]),
    { hasWorkloadIdentity: true, hasDelegationPolicy: false }
  );
  assert.equal(v.valid, false);
});

test("L0 using 3LO is rejected (acts as no one)", () => {
  const v = validateProfile(
    base("L0", [
      { toolName: "t", pattern: "3lo", resource: "r", minScopes: ["x"], incrementalScopes: [] },
    ]),
    { hasWorkloadIdentity: false, hasDelegationPolicy: false }
  );
  assert.equal(v.valid, false);
});

test("L3 without delegation policy is rejected", () => {
  const v = validateProfile(base("L3", []), {
    hasWorkloadIdentity: true,
    hasDelegationPolicy: false,
  });
  assert.equal(v.valid, false);
  assert.match(v.errors.join(" "), /delegation policy/);
});

test("incremental scope overlapping minimum is rejected", () => {
  const v = validateProfile(
    base("L1", [
      { toolName: "t", pattern: "obo", resource: "r", minScopes: ["a"], incrementalScopes: ["a"] },
    ]),
    { hasWorkloadIdentity: true, hasDelegationPolicy: false }
  );
  assert.equal(v.valid, false);
});

// ---- scope algebra ----
test("normalizeScopes dedups/sorts/trims", () => {
  assert.deepEqual(normalizeScopes([" b", "a", "a", ""]), ["a", "b"]);
});

test("isSubset / excessScopes", () => {
  assert.equal(isSubset(["a"], ["a", "b"]), true);
  assert.equal(isSubset(["a", "c"], ["a", "b"]), false);
  assert.deepEqual(excessScopes(["a", "c"], ["a", "b"]), ["c"]);
});

test("minimumScopes removes incremental from the up-front ask", () => {
  assert.deepEqual(
    minimumScopes(["Mail.Read", "Mail.Send"], ["Mail.Send"]),
    ["Mail.Read"]
  );
});

test("detectDrift flags over-ask", () => {
  const d = detectDrift(["Mail.Read", "Mail.ReadWrite"], ["Mail.Read"]);
  assert.equal(d.drifted, true);
  assert.deepEqual(d.excess, ["Mail.ReadWrite"]);
});

test("detectDrift clean when within allowed", () => {
  const d = detectDrift(["Mail.Read"], ["Mail.Read", "Mail.Send"]);
  assert.equal(d.drifted, false);
  assert.deepEqual(d.unused, ["Mail.Send"]);
});
