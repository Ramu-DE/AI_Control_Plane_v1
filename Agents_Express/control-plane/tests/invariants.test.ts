// Offline invariant tests:
//  - no identity module imports aws/* or bedrock (deterministic, no network)
//  - the seed encodes the three PDF scenarios with the right patterns
//  - vault entries never carry raw token/secret fields
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { seedIdentity } from "../src/lib/identity/seed.ts";
import { validateProfile } from "../src/lib/identity/autonomy.ts";

const here = dirname(fileURLToPath(import.meta.url));
const identityDir = join(here, "..", "src", "lib", "identity");

test("no identity module imports aws/* or bedrock (offline guarantee)", () => {
  const files = readdirSync(identityDir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 8, "expected the identity modules to be present");
  for (const f of files) {
    const src = readFileSync(join(identityDir, f), "utf8");
    // Only inspect import statements, not comments/prose.
    const importLines = src
      .split("\n")
      .filter((l) => /^\s*import\s|from\s+["']/.test(l));
    const joined = importLines.join("\n");
    assert.ok(!/@aws-sdk/.test(joined), `${f} must not import @aws-sdk`);
    assert.ok(!/\bbedrock\b/.test(joined), `${f} must not import bedrock`);
    assert.ok(!/lib\/aws/.test(joined), `${f} must not import lib/aws`);
    // No outbound network primitives in the identity layer.
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} must not call fetch()`);
  }
});

test("seed encodes the three PDF scenarios", () => {
  const s = seedIdentity();
  const byId = (id: string) => s.profiles.find((p) => p.agentId === id)!;

  const scanner = byId("agent-compliance-scanner");
  assert.equal(scanner.autonomyLevel, "L2");
  assert.equal(scanner.inbound.kind, "sigv4");
  assert.ok(scanner.outbound.every((o) => o.pattern === "iam"));

  const dev = byId("agent-dev-productivity");
  assert.equal(dev.autonomyLevel, "L1");
  assert.ok(dev.outbound.some((o) => o.pattern === "3lo" && o.resource === "github-api"));

  const email = byId("agent-email-summarizer");
  assert.equal(email.autonomyLevel, "L1");
  assert.ok(email.outbound.some((o) => o.pattern === "obo" && o.resource === "microsoft-graph"));

  // Expense Assistant got an identity profile.
  assert.ok(byId("agent-expense-assistant"));
});

test("every seeded profile is valid under its autonomy level", () => {
  const s = seedIdentity();
  const hasWid = (agentId: string) =>
    s.workloadIdentities.some((w) => w.agentId === agentId);
  for (const p of s.profiles) {
    const v = validateProfile(p, {
      hasWorkloadIdentity: hasWid(p.agentId),
      hasDelegationPolicy: s.delegationPolicies.length > 0,
    });
    assert.equal(v.valid, true, `${p.agentId}: ${v.errors.join("; ")}`);
  }
});

test("seed vault is empty and audit chain is intact", () => {
  const s = seedIdentity();
  assert.equal(s.vault.length, 0, "no standing tokens at rest");
  // the seeded audit is a valid chain.
  assert.equal(s.audit[0].prevHash, "");
  assert.equal(s.audit[1].prevHash, s.audit[0].hash);
});
