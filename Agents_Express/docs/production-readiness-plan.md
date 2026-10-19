# Production-Readiness Plan — Takeda Agent Control Plane

**Status:** Draft for review · Derived from research against the actual codebase (`control-plane/`).
**Current state (verified in code):** strong domain model, but **in-memory store, no auth, simulated Cedar, no tenant enforcement.** `store.ts` is a global singleton (data lost on restart, shared across tenants); API routes read no `Authorization` header (actor hardcoded `console-user`); `evaluator.ts` is a labeled regex **simulation**; `TierConfig` limits/budgets are data-only, never enforced.

This plan takes it from demo → production for a regulated pharma on **AWS Bedrock AgentCore + Databricks + Informatica IDMC**.

---

## P0 — Launch blockers (critical path P0.1 → P0.4)

### P0.1 Persistence & multi-tenant data model
- Replace the in-memory `store` singleton with **DynamoDB** (tenant-partitioned, `PK = TENANT#<id>`) or **Aurora Serverless v2**, behind the same function signatures so the API/UI don't change.
- **Databricks Unity Catalog** = governed data-access layer agents reach: catalog/schema per tenant/BU; **silo** = dedicated catalog, **pool** = shared catalog + row/column security.
- **Informatica IDMC** = governance/lineage/data-quality/classification plane feeding UC tables and driving masking.

### P0.2 AuthN / AuthZ (make it real, not simulated)
- **Entra ID / Okta OIDC** (via Cognito broker or API Gateway/ALB JWT authorizer). Replace the hardcoded "Workshop Admin".
- **AgentCore Identity** workload identities; **on-behalf-of** token exchange so the end-user identity propagates all the way to Unity Catalog (UC grants apply per real user).
- Replace the regex evaluator with **real AgentCore Policy (Cedar at gateway)** + **Amazon Verified Permissions (Cedar in-tool)**. Keep the simulator only as a clearly-labeled, non-authoritative **Playground preview**.

### P0.3 Tenant isolation enforcement
- **Server-side tenant context derived from the token** (never a client header) on every request.
- **Pool:** IAM session tags / DynamoDB `LeadingKeys` / UC row filters. **Silo:** dedicated tables/catalogs/gateways keyed by `resourcePool`.
- Make `TierConfig` **executable**: enforce `maxAgents` etc. at write time; `monthlyTokenBudget` at inference via the LLM gateway; **AWS Budgets** + cost-allocation tags per tenant.

### P0.4 GxP / GDPR / PHI compliance
- **Immutable, attributable audit:** DynamoDB (no-delete) + **S3 Object Lock (WORM)** + CloudTrail + AgentCore Observability, tied to verified identity (**21 CFR Part 11**).
- **Data residency:** region pinning (EU / Japan) per BU.
- **Guardrails:** Amazon Bedrock Guardrails + AgentCore policy controls.
- **Secrets:** AWS Secrets Manager + **per-tenant KMS CMK** (crypto-shredding for GDPR erasure).
- **PII/PHI masking** driven by IDMC classification, applied as UC column masks / row filters.

---

## P1 — Supportable production

- **P1.1 Observability:** AgentCore Observability → CloudWatch GenAI observability + CloudTrail + OpenTelemetry/X-Ray distributed tracing with **tenant correlation IDs** and per-tenant alarms.
- **P1.2 Reliability/scale:** stateless API on **ECS Fargate / EKS** or **Lambda + API Gateway** (state externalized per P0.1); **ElastiCache** (tenant-namespaced keys); per-tier rate limiting via API Gateway usage plans / WAF (`ModelProvider.rateLimitRpm`); multi-AZ + DR/backup sized to GxP RTO/RPO.
- **P1.3 CI/CD & IaC:** **CDK or Terraform** for all AWS + AgentCore + Databricks + Informatica resources; plus the **saas-workloads KRO + ArgoCD GitOps** pattern where a tenant = a `ResourceGraphDefinition` committed to Git (auditable GxP change control).
- **P1.4 Testing:** first-class **cross-tenant isolation suite** (incl. org-tree inheritance edges); **real AgentCore Policy/AVP decision tests** covering the permit/forbid/budget matrix; **OBO→UC propagation** tests.

---

## P2 — Maturity

- Self-service tier upgrades with automated **pool→silo migration** via the KRO/ArgoCD graph.
- Per-tenant **FinOps/chargeback** + cost-optimized Bedrock routing (Haiku vs Opus via `ModelRoute` aliases).
- AgentCore **quality evaluations** + red-team / prompt-injection / drift harness.
- Chaos / SLO / DR drills; **authz-denial anomaly detection** as a security signal.

---

## Service mapping (concern → demo artifact → platform)

| Concern | In the demo today | Production service |
|---|---|---|
| State | `store.ts` in-memory | DynamoDB / Aurora (tenant-partitioned) |
| Governed data | (none) | Databricks Unity Catalog (per-tenant catalog) |
| Catalog/lineage/DQ/masking | Registry metadata | Informatica IDMC (CDGC/CDI/CAI/DQ) |
| Identity | hardcoded admin | Entra/Okta OIDC + AgentCore Identity (OBO) |
| Authz (perimeter) | `evaluator.ts` (regex sim) | AgentCore Policy (Cedar at gateway) |
| Authz (in-tool) | `evaluator.ts` (regex sim) | Amazon Verified Permissions (Cedar) |
| Tenant isolation | `TierConfig` (cosmetic) | session tags / dedicated catalogs + enforced limits |
| Budgets | `monthlyTokenBudget` (display) | LLM gateway + AWS Budgets + cost tags |
| Audit | in-memory `audit[]` | DynamoDB + S3 Object Lock + CloudTrail |
| Observability | (none) | AgentCore Observability + CloudWatch + X-Ray |
| Deploy | `next start` | ECS/EKS/Lambda + CDK/Terraform + KRO/ArgoCD |

---

## What this repo's demo already gets right (keep)
- Clean domain model that maps 1:1 to the above services (the `lib/types.ts` seam).
- Correct two-layer authz *shape* (gateway + AVP), default-deny, lifecycle states.
- Registry approval lifecycle, declarative agents, hierarchical Takeda tenant tree with tier/isolation.
- The README's "Wiring to real AWS" section is the intended integration seam — production work replaces implementations behind the same contracts.

*Prepared from delegated research. No production code written yet; this is the plan to review and sequence.*
