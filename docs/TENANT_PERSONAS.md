# Tenant-scoped personas for Takeda

Settings → **Personas** (`/settings`).

## 1. The problem

A persona used to be a name, an email and a seniority group, and it applied
**platform-wide**. The tenant of a request came from the *workflow* or the
*agent*, and nothing asked whether the person belonged to it. So any identity
could run any BU's agents, query any BU's graph and read any BU's knowledge
base. The evaluator said so itself ("personas are platform-wide … a tenant
claim on a persona would be … unsupported"), and `SETUP.md` listed
"tenant-scoped personas" as a known gap.

For Takeda that breaks the basic promise of the tenant tree: an R&D clinical
scientist and a BU Japan commercial lead are different people with different
data rights, and some data is GxP or region-bound.

## 2. The model

A persona is **an identity from the IdP** (Entra ID for Takeda) that carries:

| Field | Meaning |
|---|---|
| `memberships: [{tenantId, role}]` | where the persona may act, and as what |
| `homeTenantId` | where they sit in the org chart (display, audit) |
| `groups` | IdP groups, including `TKD-<TENANT>-<ROLE>` (one per membership) plus a seniority group |
| `attributes.region` | data residency: `US` / `EU` / `JP` / `GLOBAL` |
| `attributes.gxpTrained` | `"true"` / `"false"` |
| `attributes.jobTitle` | display |

### Membership rule: the same as every other tenant rule

- A membership covers **its tenant and every descendant**: an analyst in R&D
  is an analyst in R&D Research.
- It **never reaches a sibling** (R&D ≠ Supply) and **never flows up**
  (an R&D member is not a Takeda-wide member).
- The **nearest** membership decides the role: a Takeda *viewer* who is an
  R&D *approver* is an approver in R&D Research.
- **No membership means no access.** A persona with no membership fails
  closed and is shown as *unscoped* in Settings.

### Roles: what a member may do

| Role | May |
|---|---|
| `viewer` | query graphs, knowledge bases and memory |
| `analyst` | + run agents, call peer agents, invoke tools, build knowledge graphs |
| `approver` | + approval actions (e.g. `approveExpense`) |
| `admin` | everything a member can do in the tenant |

These minimums are enforced by the platform (`ACTION_MIN_ROLE` in
`src/lib/personas.ts`). **Cedar policy then decides on top**, and can only
narrow access further.

### IdP convention

Entra ID groups are named **`TKD-<TENANT>-<ROLE>`**, for example
`TKD-FN-RND-ANALYST`, `TKD-BU-JAPAN-APPROVER` or
`TKD-BU-PLASMA-BIOLIFE-VIEWER`. A persona can be built either way:
- **from a tenant + role choice:** the group is generated;
- **from the groups a token actually carries:** the memberships are parsed.

The two always agree. A `TKD-` group that names no tenant, or no known role,
is **rejected** at creation: it is a provisioning error someone should see,
not something to drop silently.

## 3. Where it is enforced

| Point | Check |
|---|---|
| Cedar evaluator (every request that carries a tenant) | **membership first**, then the role minimum, **before any policy**. Cedar then sees `principal.tenantRole` (the role in *this* tenant), `principal.homeTenant`, `principal.region` and `principal.gxpTrained`. |
| Workflow **start** | the persona must belong to the workflow's tenant. Otherwise `403 PERSONA_NOT_IN_TENANT`, with the reason, before anything runs. |
| Agent step (`runAgent`) | evaluated in the agent's tenant |
| Graph tools (`graph_query`, `graph_sparql`, `graph_schema`) | evaluated in the caller's tenant. This is *in addition to* the Graph Source's own tenant check. |
| KB retrieval, memory, A2A | through the same evaluator whenever a tenant is present |

Requests with no tenant (the workshop's expense playground) are unaffected.

## 4. Seeded personas

All synthetic (`@takeda.example.com`).

| Persona | Tenant access | Region / GxP | Tests |
|---|---|---|---|
| Priya Raman, Clinical Data Scientist | analyst @ `fn-rnd` | US · GxP | R&D agents and graphs; refused in Supply |
| Daniel Okafor, Head of Clinical Ops | approver @ `fn-rnd`, viewer @ `fn-medical` | US · GxP | multi-tenant, different roles |
| Lena Fischer, Supply Planner | analyst @ `fn-supply` | EU · GxP | supply-chain agent and Neptune graph |
| Kenji Watanabe, BU Japan Commercial Lead | approver @ `bu-japan` | JP | region-bound BU |
| Omar Haddad, Category Manager | approver @ `fn-procurement` | GLOBAL | function |
| Sofia Rossi, BioLife Centre Analyst | **viewer** @ `bu-plasma-biolife` | EU | may read, may not run agents |
| John Stiles / Mary Major (workshop) | approver / admin @ **`takeda`** (org-wide) | — | the AnyCompany demo identities, **explicitly** org-wide so every existing demo keeps working |

On restart, the saved store was upgraded in place. John and Mary gained their
explicit org-wide membership, and the Takeda personas were added. Any other
existing persona with no membership is left *unscoped* rather than silently
granted a tenant.

## 5. Adding a persona

### UI

Settings → Personas → **+ Add Persona**:

| Field | Value |
|---|---|
| Name, Email | |
| Identity provider | Entra ID (default) |
| Tenant (BU / function) | indented Takeda tree |
| Role | viewer / analyst / approver / admin |
| Data region | US / EU / JP / GLOBAL |
| Job title | optional |
| GxP trained | checkbox |
| Seniority group | optional; drives the expense demo's approval limit |

The form previews the IdP group the persona will carry
(`TKD-FN-RND-ANALYST`).

### API

```bash
CP=http://localhost:3000/proxy/3000

# From a tenant + role
curl -s -X POST $CP/api/personas -H 'content-type: application/json' -d '{
  "name":"Marco Bianchi","email":"marco.bianchi@takeda.example.com",
  "tenantId":"fn-finance","role":"approver","region":"EU","jobTitle":"Finance Controller"}'

# From IdP group claims (several memberships at once)
curl -s -X POST $CP/api/personas -H 'content-type: application/json' -d '{
  "name":"Aiko Tanaka","email":"aiko.tanaka@takeda.example.com",
  "groups":["seniority_manager","TKD-BU-ONC-JAPAN-ANALYST","TKD-FN-MEDICAL-VIEWER"],
  "region":"JP","gxpTrained":true}'
```

## 6. Measured (live)

- **Starting the `fn-supply` workflow:**
  - **Priya (R&D)** → `PERSONA_NOT_IN_TENANT`: *"Priya Raman is not a member of 'fn-supply' or any tenant above it (member of: fn-rnd)"*
  - **Kenji (BU Japan)** → refused the same way
  - **Lena (Supply)** → ran. The agent made real Neptune SPARQL calls and paused at review.
- **Creating personas:**
  - creation from IdP groups produced `analyst@bu-onc-japan, viewer@fn-medical`;
  - a group naming a non-existent tenant (`TKD-FN-MARKETING-ANALYST`) was refused;
  - a persona with no tenant was refused.
- **Tests:** 432/432 (10 new persona tests). Smoke test: 97 pass / 0 fail / 2 skip.

## 7. Review-gate identity (four eyes)

A workflow review decision (approve / revise / deny) used to be recorded as a
hard-coded `"Workshop Admin"`. It now must name a **reviewer persona**, and is
refused unless:

| Rule | Refusal |
|---|---|
| a reviewer is named | `400 REVIEWER_REQUIRED` |
| the reviewer is not the persona who started the run | `403 SELF_REVIEW` |
| the reviewer is a member of the run's tenant, as **approver** or admin | `403 REVIEWER_NOT_PERMITTED` ("approveReviewGate needs approver") |
| Cedar permits `approveReviewGate`, so the GxP and residency rules bind approvers too | `403 REVIEWER_NOT_PERMITTED` (names the policy) |

The step records `reviewer` and `reviewerPersonaId`, and the audit entry names
the reviewer. On the Workflows page, the review panel has a **Reviewer**
picker; it excludes the run's starter and shows each persona's tenant roles.

Live, on a real paused `fn-supply` run started by Lena: no reviewer was
refused; Lena reviewing her own run was refused (four eyes); Priya (R&D) was
refused (not a member of fn-supply); Mary approved, and the step shows
`Mary Major / persona-mary`.

## 8. GxP and data-residency policies

Tenants carry two attributes, **inherited down the tree** (the nearest tenant
that sets one wins):

| Tenant | Attribute |
|---|---|
| `fn-rnd`, `fn-medical`, `fn-supply`, `bu-plasma` (and all their sub-units) | `gxp` |
| `bu-japan`, `bu-onc-japan` | region `JP` |
| `bu-onc-eucan` | region `EU` |
| `bu-us`, `bu-onc-us` | region `US` |

These are illustrative defaults for review (`TAKEDA_REGULATORY` in `lib/tenancy.ts`).

Policy reads them as `resource.gxp`, `resource.region` and
`resource.regionBound`. Two **forbid** policies are seeded (Policy Library,
gateway layer). Forbid beats any permit:

```cedar
forbid(principal, action in [Action::"runAgent", Action::"queryGraphSource",
  Action::"queryKnowledgeBase", Action::"useMemory", Action::"buildKnowledgeGraph",
  Action::"callAgent", Action::"approveReviewGate"], resource)
when { resource.gxp == "true" } unless { principal.gxpTrained == "true" };

forbid(principal, action in [ ...same actions... ], resource)
when { resource.regionBound == "true" }
unless { principal.region == resource.region || principal.region == "GLOBAL" };
```

A missing `gxpTrained` counts as untrained: it **fails closed**. The workshop
identities (John, Mary) are explicitly `gxpTrained` and `GLOBAL`.

To support these, the evaluator now understands:
- `action in [...]`, matched against the request's *action*;
- `when` and `unless` in the same policy;
- `||` alternatives;
- `principal.x == resource.y`;
- tenant resource attributes.

Existing policies evaluate exactly as before (all prior tests unchanged).

Live:

| Who | Where | Result |
|---|---|---|
| Tom Becker, R&D analyst, GxP training pending | BioMedical workflow | step refused: *Explicit forbid by 'GxP data requires GxP training'* |
| Priya, trained | same workflow | ran, 3 graph tool calls |
| Ryan Cole, US analyst in BU Japan | Playground with `tenantId` | refused by the residency policy |
| Kenji, JP | same | allowed |
| Sofia, untrained | BioLife (inherits GxP from Plasma) | refused by GxP |

The Playground API now accepts an optional `tenantId`, so these decisions can
be simulated there.

Tests: 440/440 (8 regulatory tests). Smoke test: 99 pass / 0 fail / 2 skip.

## 9. Maker-checker for Registry records and Graph Sources

Approving a tool, knowledge base or graph makes it usable by every agent in a
tenant, so it follows the review-gate rule (`src/lib/approvals.ts`):

| Transition | Who | Refusals |
|---|---|---|
| Draft → **Pending approval** (submit) | a named persona, **analyst+** in the resource's tenant; recorded as the submitter | `SUBMITTER_REQUIRED`, `SUBMITTER_NOT_PERMITTED` |
| → **Approved / Rejected / Deprecated** (decide) | a named persona, **approver+** in the resource's tenant, **not the submitter**, and Cedar `approveRecord` must permit, so the GxP and residency policies bind approvers | `REVIEWER_REQUIRED`, `SELF_REVIEW`, `REVIEWER_NOT_PERMITTED` |
| Rejected → Draft | anyone | — |

- **Platform-provided records** (no tenant) are decided at the **org root**: an approver of `takeda`.
- **A free-text tenant that doesn't exist** (for example `contract-iq`'s `market-access`) is treated the same way. Unknown never means open.
- **Recorded on the resource:** `submittedByPersonaId`, `decidedBy`, `decidedByPersonaId` and `decidedAt`, and the audit entry names the persona.
- **APIs:** `PATCH /api/registry` and `PATCH /api/graph` take `personaId`. `submitterPersonaId` and `reviewerPersonaId` are accepted as aliases.
- **UI:** Registry record details, Create Record and Graph Sources have an **Acting as** picker. It's shared, remembered for the session, and refusals show their reason.
- **Integration scripts** use `SUBMITTER_PERSONA_ID` (default John) and `REVIEWER_PERSONA_ID` (default Mary).
- **Not covered:** a registry created with `autoApproval: true` still creates records Approved without review. That is an explicit registry-level choice.

Live, for a `fn-supply` record and a `fn-supply` Graph Source:

| Attempt | Result |
|---|---|
| submit with no persona | refused |
| Priya (R&D) submits | refused |
| Lena submits | ok |
| approve with no persona | refused |
| Lena approves her own submission | `SELF_REVIEW` |
| Kenji (BU Japan) approves | refused |
| Mary approves | ok, `decidedBy=Mary Major` |

## 10. Editable regulatory attributes (Tenants page)

The tenant detail panel has a **Regulatory** card. It shows the effective GxP
and data region, and where each comes from (*set here* or *inherited from
fn-rnd*), with an editor:
- **GxP:** inherit / GxP / not GxP (override);
- **Region:** inherit / US / EU / JP.

`PATCH /api/tenants {id, gxp, dataRegion, personaId}`. `null` means inherit
again.

Changing these changes who may touch everything in the subtree, so it needs an
**admin of that tenant or one above it**, and it is audited with the before and
after values. Live: Lena (analyst) was refused, a call with no persona was
refused, and Mary set and then reverted `fn-legal`'s GxP flag.

## 11. Editing and removing personas (Settings)

Each row has **Edit** and **Remove**, governed by the **Acting as** persona.

- **Edit** (`PATCH /api/personas`): memberships, region, GxP training, job title.
  - You can only grant, change or remove access in tenants **you administer**,
    checked across both the old and the new memberships.
  - Attribute-only edits need admin of at least one of the persona's tenants.
  - Nobody can edit **their own** access (`SELF_ADMIN`).
  - IdP `TKD-` groups are regenerated to match.
- **Remove** (`DELETE /api/personas?id=&actorPersonaId=`):
  - A persona that appears in the record (started or reviewed a run, submitted
    or decided an approval) is **disabled**, not deleted, and every
    authorization then fails.
  - Only a persona nothing refers to is actually deleted.
  - Settings shows disabled personas with a badge.

Live:

| Step | Result |
|---|---|
| Tom (untrained) queries the R&D graph | refused by GxP |
| Priya tries to mark him trained | refused (not an admin of his tenant) |
| Mary marks him trained | ok; Tom is then allowed |
| Daniel (approver, not admin) grants Tom Supply access | refused |
| Mary edits herself | refused |
| Remove Ryan (never acted) | **deleted** |
| Remove Tom (has a run) | **disabled**; his next request: *"Tom Becker is disabled."* |

Tests: 446/446 (5 approval tests, 1 disabled-persona test). Smoke test: 99 pass / 0 fail / 2 skip.

## 12. Not done yet

- **Real IdP.** Personas are test identities. In production the persona *is*
  the validated Entra ID token: memberships from its `groups` claim, region
  and GxP from directory attributes, refreshed at sign-in. AgentCore Identity
  or Cognito federation with Entra would supply it. Deferred until the AWS
  resources for it are available.
- **The console session itself is not authenticated.** "Acting as" is a
  declared identity, which is right for a test harness. With a real IdP it
  becomes the signed-in user, and the picker goes away.
