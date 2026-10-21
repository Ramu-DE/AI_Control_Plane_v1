// Seed data for the identity simulation — the three PDF "in production"
// scenarios plus an AgentIdentityProfile for the existing Expense Assistant.
//
//  Scenario 1  Nightly Compliance Scanner — L2, inbound SigV4 → outbound IAM
//  Scenario 2  Developer Productivity Agent — L1, outbound 3LO (GitHub)
//  Scenario 3  Enterprise Email Summarizer — L1, inbound OIDC → outbound OBO (Graph)
//
// Pure data; no I/O.

import type {
  AgentIdentityProfile,
  ConsentGrant,
  DelegationPolicy,
  IdentityAuditEvent,
  Session,
  VaultEntry,
  WorkloadIdentity,
} from "./types";
import { createWorkloadIdentity } from "./workloadIdentity";
import { appendIdentityAudit } from "./audit";

export interface IdentityState {
  profiles: AgentIdentityProfile[];
  workloadIdentities: WorkloadIdentity[];
  vault: VaultEntry[];
  consents: ConsentGrant[];
  sessions: Session[];
  delegationPolicies: DelegationPolicy[];
  audit: IdentityAuditEvent[];
}

function iso(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

export function seedIdentity(): IdentityState {
  const now = iso(0);

  const profiles: AgentIdentityProfile[] = [
    // Existing Expense Assistant — acts for the user via OBO to the finance API.
    {
      agentId: "agent-expense-assistant",
      autonomyLevel: "L1",
      actsAs: "user",
      inbound: {
        kind: "oidc",
        issuer: "https://cognito-idp.simulated.amazonaws.com/us-east-1_EXAMPLE",
        audience: "expense-assistant",
        requiredScopes: ["openid", "expense.use"],
        jwksHint: "simulated://cognito/jwks",
      },
      outbound: [
        {
          toolName: "submitExpense",
          pattern: "obo",
          resource: "finance-api",
          minScopes: ["spend.read"],
          incrementalScopes: ["spend.write"],
        },
        {
          toolName: "listTeamExpenses",
          pattern: "obo",
          resource: "finance-api",
          minScopes: ["spend.read"],
          incrementalScopes: [],
        },
      ],
      toolAllowlist: ["submitExpense", "listMyExpenses", "listTeamExpenses"],
      createdAt: iso(3),
      updatedAt: now,
    },
    // Scenario 1 — Nightly Compliance Scanner (L2, inbound SigV4, outbound IAM).
    {
      agentId: "agent-compliance-scanner",
      autonomyLevel: "L2",
      actsAs: "self",
      inbound: {
        kind: "sigv4",
        principalArnPattern: "arn:aws:iam::*:role/EventBridge-Scheduler-*",
      },
      outbound: [
        {
          toolName: "scanBuckets",
          pattern: "iam",
          resource: "s3",
          minScopes: ["s3:GetBucketPolicy"],
          incrementalScopes: [],
        },
        {
          toolName: "auditIam",
          pattern: "iam",
          resource: "iam",
          minScopes: ["iam:ListPolicies"],
          incrementalScopes: [],
        },
        {
          toolName: "writeFindings",
          pattern: "iam",
          resource: "dynamodb",
          minScopes: ["dynamodb:PutItem"],
          incrementalScopes: [],
        },
      ],
      toolAllowlist: ["scanBuckets", "auditIam", "writeFindings"],
      createdAt: iso(2),
      updatedAt: now,
    },
    // Scenario 2 — Developer Productivity Agent (L1, outbound 3LO to GitHub).
    {
      agentId: "agent-dev-productivity",
      autonomyLevel: "L1",
      actsAs: "user",
      inbound: {
        kind: "oidc",
        issuer: "https://cognito-idp.simulated.amazonaws.com/us-east-1_DEVPOOL",
        audience: "dev-productivity-agent",
        requiredScopes: ["openid"],
        jwksHint: "simulated://cognito/jwks",
      },
      outbound: [
        {
          toolName: "createPullRequest",
          pattern: "3lo",
          resource: "github-api",
          minScopes: ["repo", "pull_request:write"],
          incrementalScopes: ["issues:write"],
        },
      ],
      toolAllowlist: ["createPullRequest", "reviewCode"],
      createdAt: iso(2),
      updatedAt: now,
    },
    // Scenario 3 — Enterprise Email Summarizer (L1, inbound OIDC, outbound OBO).
    {
      agentId: "agent-email-summarizer",
      autonomyLevel: "L1",
      actsAs: "user",
      inbound: {
        kind: "oidc",
        issuer: "https://login.simulated.microsoftonline.com/tenant/v2.0",
        audience: "email-summarizer",
        requiredScopes: ["openid", "profile"],
        jwksHint: "simulated://entra/jwks",
      },
      outbound: [
        {
          toolName: "summarizeInbox",
          pattern: "obo",
          resource: "microsoft-graph",
          minScopes: ["Mail.Read"],
          incrementalScopes: ["Mail.Send"],
        },
      ],
      toolAllowlist: ["summarizeInbox"],
      createdAt: iso(1),
      updatedAt: now,
    },
  ];

  const workloadIdentities: WorkloadIdentity[] = profiles
    // L0 agents don't require a workload identity; all seeds here are L1/L2.
    .map((p) => createWorkloadIdentity(p.agentId));

  // One seeded 3LO consent: the dev authorized the dev-productivity agent for
  // GitHub once ("Maria approves once" analog).
  const consents: ConsentGrant[] = [
    {
      id: "consent-dev-github",
      userSub: "dev-jordan",
      agentId: "agent-dev-productivity",
      resource: "github-api",
      scopes: ["repo", "pull_request:write"],
      grantedAt: iso(1),
      revokedAt: null,
    },
  ];

  // Explicit delegation policy for an L3-style orchestration demo. Allows a
  // hypothetical orchestrator to delegate to the compliance scanner only.
  const delegationPolicies: DelegationPolicy[] = [
    {
      id: "delegation-default",
      allow: [
        { fromAgent: "agent-orchestrator", toAgent: "agent-compliance-scanner" },
      ],
    },
  ];

  const audit: IdentityAuditEvent[] = [];
  appendIdentityAudit(audit, {
    id: "ievt-seed-1",
    action: "profile-create",
    actor: "seed",
    detail: "Seeded AgentIdentityProfile for Expense Assistant (L1, OBO → finance-api)",
    attribution: { agentId: "agent-expense-assistant" },
    at: iso(3),
  });
  appendIdentityAudit(audit, {
    id: "ievt-seed-2",
    action: "consent-grant",
    actor: "dev-jordan",
    detail: "Developer authorized dev-productivity agent for GitHub (repo, pull_request:write)",
    attribution: { humanSub: "dev-jordan", agentId: "agent-dev-productivity", act: "agent" },
    at: iso(1),
  });

  return {
    profiles,
    workloadIdentities,
    vault: [],
    consents,
    sessions: [],
    delegationPolicies,
    audit,
  };
}
