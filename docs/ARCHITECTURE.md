# Architecture and flows

All diagrams are Mermaid and render on GitHub. For a file-by-file explanation of
each module, see [`docs/modules/`](modules/README.md).

1. [System context](#1-system-context)
2. [Control plane components](#2-control-plane-components)
3. [Authorization: every tenant-scoped request](#3-authorization-every-tenant-scoped-request)
4. [Workflow run with agents, tools and review gate](#4-workflow-run-with-agents-tools-and-review-gate)
5. [Agent graph query (Neo4j and Neptune)](#5-agent-graph-query-neo4j-and-neptune)
6. [Knowledge Graph page: build spec decides the flow](#6-knowledge-graph-page-build-spec-decides-the-flow)
7. [Ontology-first build job (control plane to graph-utility)](#7-ontology-first-build-job-control-plane-to-graph-utility)
8. [graph-utility build pipeline](#8-graph-utility-build-pipeline)
9. [Mapping proposals and approval profiles](#9-mapping-proposals-and-approval-profiles)
10. [Maker-checker lifecycles](#10-maker-checker-lifecycles)
11. [Tenants, personas and regulatory attributes](#11-tenants-personas-and-regulatory-attributes)
12. [Knowledge-base (RAG) grounding](#12-knowledge-base-rag-grounding)
13. [Data model](#13-data-model)
14. [Deployment (workshop account)](#14-deployment-workshop-account)
15. [How the repository modules relate](#15-how-the-repository-modules-relate)

---

## 1. System context

```mermaid
flowchart LR
  user["People<br/>(personas with tenant memberships)"]
  ext["External A2A agents"]

  subgraph cp["Control plane (Next.js 15)"]
    ui["Console UI"]
    api["HTTP API /api/*"]
    lib["Domain logic src/lib"]
  end

  gu["graph-utility (Python)<br/>ontology-first KG builder"]

  subgraph data["Data and model services"]
    uc["Databricks Unity Catalog<br/>SQL warehouse"]
    dms["Databricks Model Serving<br/>Llama 3.3"]
    bed["Amazon Bedrock<br/>Claude, Titan embeddings"]
    neo["Neo4j Aura<br/>property graphs"]
    nep["Amazon Neptune<br/>RDF named graphs"]
    s3["Amazon S3<br/>N-Quads for bulk load"]
    qd["Qdrant Cloud<br/>vectors"]
  end

  user -->|browser via CloudFront| ui
  ui --> api --> lib
  ext -->|A2A JSON-RPC| api
  lib -->|model calls via broker| bed
  lib -->|model calls via broker| dms
  lib -->|uc_* tools, derive| uc
  lib -->|graph_query Cypher| neo
  lib -->|graph_sparql SPARQL| nep
  lib -->|KB retrieval| qd
  lib -->|spawns build job| gu
  gu -->|discover and read data| uc
  gu -->|MERGE property graph| neo
  gu -->|upload N-Quads| s3
  s3 -->|bulk loader| nep
```

---

## 2. Control plane components

```mermaid
flowchart TB
  subgraph pages["UI pages src/app"]
    pReg["Registry"]
    pAg["Agents"]
    pWf["Workflows"]
    pGs["Graph Sources"]
    pKg["Knowledge Graph"]
    pTen["Tenants"]
    pSet["Settings / Personas"]
    pApp["Approvals"]
    pPg["Playground"]
  end

  subgraph routes["API routes src/app/api"]
    rReg["/registry"]
    rAg["/agents"]
    rWf["/workflows"]
    rGr["/graph"]
    rKg["/kg"]
    rTen["/tenants"]
    rPer["/personas"]
    rPg["/playground"]
    rKb["/kb/retrieve"]
    rA2a["/a2a/*"]
  end

  subgraph authz["Authorization"]
    pers["personas.ts<br/>membership + role minimum"]
    ev["evaluator.ts<br/>Cedar gateway + AVP"]
    regu["regulatory.ts<br/>GxP + residency forbids"]
    ten["tenancy.ts<br/>tree, inheritance, attributes"]
    appr["approvals.ts<br/>maker-checker"]
  end

  subgraph exec["Execution"]
    wfr["workflow/resolve + govern"]
    mb["modelBroker.ts"]
    bedr["bedrock.ts<br/>Converse + tool loop"]
    dbx["databricks.ts<br/>chat + tool loop"]
    tools["tools/registry.ts<br/>uc_*, graph_*, kg_derive"]
  end

  subgraph graph["Graphs"]
    gq["graph/query.ts<br/>governed agent queries"]
    cy["graph/cypher.ts + neo4j.ts"]
    sp["graph/sparql.ts<br/>scoped SELECT/ASK"]
    spec["kg/spec.ts<br/>build specs"]
    jobs["kg/jobs.ts<br/>graph-utility runner"]
    sread["kg/sourceRead.ts<br/>scoped explore"]
    mat["kg/materialize.ts<br/>legacy derived build"]
  end

  subgraph state["State"]
    store["store.ts<br/>Proxy-tracked store + migrations"]
    persist["persist.ts<br/>JSON snapshot .data/"]
    gctl["graph/service + local/dynamo store"]
    audit["audit log"]
  end

  pages --> routes
  rWf --> wfr --> mb
  mb --> bedr
  mb --> dbx
  bedr --> tools
  dbx --> tools
  tools --> gq
  gq --> cy
  gq --> sp
  rGr --> gq
  rKg --> spec
  rKg --> jobs
  rKg --> sread
  rKg --> mat
  rReg --> appr
  rGr --> appr
  rWf --> appr
  appr --> ev
  wfr --> ev
  gq --> ev
  rPg --> ev
  ev --> pers
  ev --> regu
  ev --> ten
  routes --> store
  store --> persist
  rGr --> gctl
  routes --> audit
```

---

## 3. Authorization: every tenant-scoped request

```mermaid
sequenceDiagram
  autonumber
  participant C as Caller (route or tool)
  participant E as evaluator.evaluate
  participant P as personas.ts
  participant T as tenancy.ts
  participant G as Gateway policies
  participant R as Regulatory forbids
  participant A as AVP layer

  C->>E: personaId, agentId, action, tool, resource, tenantId
  E->>E: persona exists and is not disabled?
  alt request carries a tenant
    E->>P: personaTenantDecision(persona, tenant)
    P->>T: tenantChain(tenant)
    T-->>P: tenant, parent, ..., root
    P-->>E: nearest membership and role (or deny)
    E->>P: roleAllows(role, action)
    P-->>E: viewer / analyst / approver minimum met?
  end
  E->>T: tenantPolicyAttributes(tenant)
  T-->>E: gxp, region, regionBound (inherited)
  E->>G: matching permits and forbids
  G->>R: GxP: forbid unless principal.gxpTrained<br/>Residency: forbid unless region matches or GLOBAL
  R-->>E: forbid wins over any permit
  opt an AVP policy targets this tool
    E->>A: second layer (e.g. approval limit)
    A-->>E: permit or deny
  end
  E-->>C: allowed + decisions with reasons
```

The order matters: **membership, then role, then policy**. No permit can let a
stranger into a tenant, and no BU permit can open GxP data to untrained staff.

---

## 4. Workflow run with agents, tools and review gate

```mermaid
sequenceDiagram
  autonumber
  actor U as Starter persona
  actor V as Reviewer persona
  participant W as /api/workflows
  participant RS as workflow/resolve
  participant GV as workflow/govern
  participant KB as kb/service
  participant MB as modelBroker
  participant LLM as Bedrock or Databricks
  participant TR as tools/registry
  participant EV as evaluator

  U->>W: start(workflowId, personaId, input)
  W->>W: persona is a member of the workflow tenant?
  W->>RS: resolve step (agent, model, approved tools, KBs)
  RS-->>W: executable tools, knowledge refs, plane
  W->>GV: authorizeAgentStep(agent, persona)
  GV->>EV: runAgent in the agent's tenant
  EV-->>GV: allow or deny
  W->>KB: ground step in approved knowledge bases
  KB-->>W: passages with citations
  W->>MB: invokeStep(step, tools, caller context)
  MB->>MB: model on the tenant allowlist, plane matches runtime
  loop bounded tool loop
    MB->>LLM: messages + tool specs
    LLM-->>MB: tool call request
    MB->>TR: executeToolCall(name, args, caller, offered)
    TR->>TR: refuse tools not offered to this step
    TR-->>MB: result or error payload
  end
  LLM-->>MB: final answer
  MB-->>W: output, tool calls, tokens
  W-->>U: step awaiting review
  V->>W: decision(approve, reviewerPersonaId)
  W->>W: reviewer is not the starter (four eyes)
  W->>EV: approveReviewGate in the run tenant (approver+, GxP)
  EV-->>W: allow
  W-->>V: run continues or completes, reviewer recorded
```

---

## 5. Agent graph query (Neo4j and Neptune)

```mermaid
flowchart TD
  call["Agent requests graph_query / graph_sparql / graph_schema"] --> ctx{"Caller context?<br/>persona, tenant, agent"}
  ctx -- missing --> d0["NO_CALLER"]
  ctx -- present --> src{"Graph Source exists<br/>and is Approved?"}
  src -- no --> d1["NOT_FOUND / NOT_APPROVED"]
  src -- yes --> vis{"Source tenant visible<br/>to caller tenant?<br/>own or ancestor"}
  vis -- sibling or child --> d2["TENANT_DENIED"]
  vis -- yes --> ced{"Cedar queryGraphSource<br/>as this agent + persona"}
  ced -- deny --> d3["POLICY_DENIED"]
  ced -- permit --> be{"Backend"}
  be -- neo4j --> g1{"Read-only Cypher?"}
  g1 -- no --> d4["UNSAFE_CYPHER"]
  g1 -- yes --> q1["runReadQuery<br/>READ session, row cap"]
  be -- neptune --> g2{"SELECT/ASK only<br/>no FROM, GRAPH, SERVICE, updates"}
  g2 -- no --> d5["UNSAFE_QUERY"]
  g2 -- yes --> inj["Inject FROM for each<br/>of the source's named graphs"]
  inj --> q2["POST /sparql to Neptune"]
  q1 --> au["Audit with persona, tenant, agent"]
  q2 --> au
  au --> res["Rows back to the model"]
```

---

## 6. Knowledge Graph page: build spec decides the flow

```mermaid
flowchart TD
  pick["Pick a Graph Source + Acting as persona"] --> spec{"Source kgSpec.mode"}
  spec -- none --> setspec["Set a build spec<br/>(tenant admin only)"]
  spec -- native --> nat["Explore only<br/>nodes with the spec's labels"]
  nat --> nbuild["Build refused: NATIVE_SOURCE"]
  spec -- ontology-first --> of["Build from ontology"]
  of --> authb{"Cedar buildKnowledgeGraph<br/>analyst+ in source tenant, GxP"}
  authb -- deny --> kd["KG_DENIED"]
  authb -- permit --> prof{"gxp-strict?"}
  prof -- yes --> appr{"Persona is approver+?"}
  appr -- no --> pd["PUBLISHER_NOT_PERMITTED"]
  appr -- yes --> job["Start graph-utility job"]
  prof -- no --> job
  job --> run["BuildRun pending to running<br/>page polls log"]
  run --> done{"Succeeded?"}
  done -- yes --> latest["Explore latest build<br/>KGEntity kg_source = id"]
  done -- no --> fail["Run failed, last log lines shown"]
  spec -- derived --> der["Legacy: derive ontology from UC metadata<br/>location from the spec"]
  der --> dbuild["Materialize into the source DB<br/>stamped graphSourceId"]
  dbuild --> dexp["Explore this source's derived builds"]
  nat --> rd{"Explore: Cedar queryGraphSource<br/>viewer+, GxP, residency"}
  latest --> rd
  dexp --> rd
  rd -- permit --> canvas["Graph canvas: classes, instances, edges<br/>double-click to expand"]
```

---

## 7. Ontology-first build job (control plane to graph-utility)

```mermaid
sequenceDiagram
  autonumber
  actor P as Persona
  participant K as /api/kg build
  participant J as kg/jobs.ts
  participant S as Graph control store
  participant B as build_graph_live.py
  participant UC as Unity Catalog
  participant N4 as Source Neo4j DB
  participant S3 as S3 bucket
  participant NP as Neptune

  P->>K: build(graphSourceId, personaId)
  K->>K: spec is ontology-first, Cedar allows
  K->>J: startOntologyBuild(source, spec, persona)
  J->>S: no build already running for this source
  J->>S: create BuildRun (pending)
  J->>B: spawn python with arg list<br/>ontology, namespace, dataset, tenant, profile
  Note over J,B: env = THIS source's credentials<br/>(Neo4j URI/user/db/password or Neptune endpoint)
  J-->>K: BuildRun (running)
  K-->>P: 202 Accepted
  B->>UC: discover tables, keys, joins
  B->>UC: profile uniqueness and containment
  B->>UC: read rows for published mappings
  alt Neo4j source
    B->>N4: MERGE KGEntity nodes and edges, KGBuild node
    B->>N4: count and verify
  else Neptune source
    B->>S3: put N-Quads
    B->>NP: start bulk load, poll
    B->>NP: SPARQL count per named graph, verify
  end
  B-->>J: exit 0 + output
  J->>S: BuildRun succeeded, message, externalRef
  opt Neptune source
    J->>S: re-point source namedGraphs to the new build
  end
  P->>K: explore
  K-->>P: latest build graph
```

---

## 8. graph-utility build pipeline

```mermaid
flowchart LR
  subgraph inputs["Inputs"]
    ont["Ontology .ttl<br/>classes, properties,<br/>skos synonyms, owl:hasKey"]
    ds["Dataset"]
  end

  subgraph adapters["Data adapters"]
    uca["uc_adapter<br/>Unity Catalog"]
    csva["csv_adapter<br/>CSV directory"]
    mem["data_adapter<br/>in-memory fixtures"]
  end

  ds --> uca
  ds --> csva
  ds --> mem

  ofile["ontology_file<br/>RdfFileOntologyClient"]
  ont --> ofile

  disc["discover()<br/>tables, columns, declared keys, joins"]
  uca --> disc
  csva --> disc
  mem --> disc

  prop["mapping.propose_mappings<br/>term_match: name / label / partial<br/>class, property, relationship,<br/>value-class, value relationship"]
  ofile --> prop
  disc --> prop

  ovl["overlap<br/>owl:hasKey probe, uniqueness,<br/>join containment"]
  prop --> ovl

  auto["mapping.auto_approve<br/>approval profile"]
  ovl --> auto

  pub["publish_mappings<br/>approved + valid only"]
  auto --> pub

  matz["materialize_graph<br/>typed nodes, literals, edges,<br/>value entities"]
  pub --> matz

  rsn["reason<br/>entail + validate constraints"]
  matz --> rsn

  gates{"Gates<br/>conflation, dangling,<br/>truncation, violations"}
  rsn --> gates
  gates -- refused --> stop["BuildRefused"]
  gates -- pass or waived --> nq["N-Quads<br/>data, :inferred, :prov"]

  nq --> n4l["neo4j_load<br/>plan + MERGE + verify"]
  nq --> npl["neptune_load<br/>S3 + bulk loader + verify"]
  nq --> file["--out file"]
  n4l --> reg["--register<br/>Draft Graph Source in control plane"]
  npl --> reg
```

---

## 9. Mapping proposals and approval profiles

```mermaid
flowchart TD
  pr["Proposal"] --> st{"Already decided<br/>or blocking issue?"}
  st -- yes --> def["Deferred to a human"]
  st -- no --> hard{"Measured evidence?<br/>key-metadata, type-compatibility,<br/>uniqueness-verified, categorical-column,<br/>value-reference"}
  hard -- no --> def
  hard -- yes --> ex{"Exact match?<br/>name-exact, or label-exact<br/>if profile accepts synonyms"}
  ex -- no --> def
  ex -- yes --> dom{"Ontology domain<br/>disagrees with table?"}
  dom -- yes --> def
  dom -- no --> inf{"Inferred identity?<br/>value-class or value edge"}
  inf -- "yes and profile forbids" --> def
  inf -- "no, or profile allows" --> kind{"Kind-specific checks<br/>class: subject key<br/>property: type + confidence<br/>relationship: join key"}
  kind -- fail --> def
  kind -- pass --> ok["Auto-approved<br/>approver = auto:profile"]

  subgraph profiles["Approval profiles"]
    gx["gxp-strict<br/>own names only, no inferred identity,<br/>human publisher required"]
    sd["standard<br/>synonyms and inferred identity allowed"]
    xp["exploratory<br/>same rules as standard"]
  end
```

---

## 10. Maker-checker lifecycles

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Draft
  Draft --> PendingApproval: submit<br/>named analyst+ in tenant
  PendingApproval --> Approved: decide<br/>approver+, not the submitter, Cedar approveRecord
  PendingApproval --> Rejected: decide<br/>approver+, not the submitter
  Approved --> Deprecated: decide<br/>approver+
  Rejected --> Draft: return to draft
  Deprecated --> [*]
```

Registry records and Graph Sources use this lifecycle. Records with no tenant
are decided at the org root (`takeda`).

```mermaid
stateDiagram-v2
  direction LR
  [*] --> Running: start<br/>persona member of workflow tenant
  Running --> AwaitingReview: step with review gate
  AwaitingReview --> Running: approve or revise<br/>reviewer approver+, not the starter
  AwaitingReview --> Denied: deny
  Running --> Completed: last step done
  Running --> Error: step refused or failed
  Completed --> [*]
  Denied --> [*]
  Error --> [*]
```

---

## 11. Tenants, personas and regulatory attributes

```mermaid
flowchart TB
  takeda["takeda (org root)"]
  rnd["fn-rnd<br/>GxP"]
  rndr["fn-rnd-research<br/>inherits GxP"]
  sup["fn-supply<br/>GxP"]
  med["fn-medical<br/>GxP"]
  jp["bu-japan<br/>region JP"]
  onj["bu-onc-japan<br/>region JP"]
  pl["bu-plasma<br/>GxP"]
  bl["bu-plasma-biolife<br/>inherits GxP"]
  fin["fn-finance"]

  takeda --> rnd --> rndr
  takeda --> sup
  takeda --> med
  takeda --> jp
  takeda --> pl --> bl
  takeda --> fin
  jp -.-> onj

  priya(["Priya: analyst @ fn-rnd<br/>US, GxP trained"])
  lena(["Lena: analyst @ fn-supply<br/>EU, GxP trained"])
  kenji(["Kenji: approver @ bu-japan<br/>JP"])
  sofia(["Sofia: viewer @ bu-plasma-biolife<br/>EU, not trained"])
  mary(["Mary: admin @ takeda<br/>org-wide test identity"])

  priya -.member.-> rnd
  lena -.member.-> sup
  kenji -.member.-> jp
  sofia -.member.-> bl
  mary -.member.-> takeda
```

The rules this diagram encodes:
- **Membership flows down:** a membership covers the tenant and every tenant beneath it, never a sibling or a parent.
- **The nearest membership sets the role** when several cover a tenant.
- **Regulatory attributes are inherited:** `gxp` and `dataRegion` come from the nearest tenant that sets them.

---

## 12. Knowledge-base (RAG) grounding

```mermaid
sequenceDiagram
  autonumber
  participant W as Workflow step
  participant K as kb/service
  participant EV as evaluator
  participant SM as Secrets / env
  participant E as Bedrock Titan v2
  participant Q as Qdrant collection

  W->>K: retrieve(recordId, personaId, question)
  K->>K: record is an Approved Knowledge Base
  K->>EV: queryKnowledgeBase (tenant, GxP, residency)
  EV-->>K: allow
  K->>SM: resolve API key by reference
  K->>E: embed question (1024 dims)
  E-->>K: vector
  K->>Q: points/query top-K with filters
  Q-->>K: scored payloads
  K-->>W: passages + citations injected into the prompt
```

---

## 13. Data model

```mermaid
erDiagram
  TENANT ||--o{ TENANT : "parent of"
  TENANT ||--o{ AGENT : owns
  TENANT ||--o{ WORKFLOW : owns
  TENANT ||--o{ GRAPH_SOURCE : owns
  TENANT ||--o{ REGISTRY_RECORD : "owns (optional)"
  PERSONA ||--o{ MEMBERSHIP : has
  TENANT ||--o{ MEMBERSHIP : grants
  REGISTRY ||--o{ REGISTRY_RECORD : contains
  AGENT }o--o{ REGISTRY_RECORD : "toolRefs / knowledgeRefs"
  AGENT }o--|| CATALOG_MODEL : uses
  WORKFLOW ||--o{ WORKFLOW_STEP : has
  WORKFLOW_STEP }o--o| AGENT : "bound to"
  WORKFLOW ||--o{ WORKFLOW_RUN : runs
  WORKFLOW_RUN }o--|| PERSONA : "started by"
  WORKFLOW_RUN ||--o{ STEP_RUN : records
  STEP_RUN }o--o| PERSONA : "reviewed by"
  GRAPH_SOURCE ||--o| KG_SPEC : declares
  GRAPH_SOURCE ||--o{ BUILD_RUN : tracks
  POLICY }o--o{ PERSONA : "evaluated for"

  TENANT {
    string id
    string parentId
    bool gxp
    string dataRegion
  }
  PERSONA {
    string id
    string provider
    string region
    string gxpTrained
    bool disabled
  }
  MEMBERSHIP {
    string tenantId
    string role
  }
  GRAPH_SOURCE {
    string graphSourceId
    string status
    string backend
    string submittedBy
    string decidedBy
  }
  KG_SPEC {
    string mode
    string ontology
    string dataset
    string approvalProfile
  }
  REGISTRY_RECORD {
    string id
    string type
    string status
    string submittedBy
    string decidedBy
  }
```

---

## 14. Deployment (workshop account)

```mermaid
flowchart LR
  browser["Browser"] --> cf["CloudFront<br/>d3ffzlzt3bv3lq.cloudfront.net"]
  cf --> nginx["nginx :80<br/>/proxy/3000 passthrough"]

  subgraph vpc["VPC 172.31.0.0/16, account 751885241433, us-east-1"]
    subgraph ec2["Code-editor EC2 instance"]
      nginx
      next["Next.js control plane :3000<br/>BASE_PATH=/proxy/3000"]
      py["graph-utility venv<br/>spawned build jobs"]
      data[(".data/ JSON snapshots")]
    end
    nep["Neptune cluster agentcontrol-kg<br/>db.t3.medium, SG allows :8182 from EC2"]
    s3e["S3 gateway endpoint"]
  end

  nginx --> next
  next --> data
  next --> py
  next --> nep
  py --> nep
  py --> s3e --> s3[("S3 bucket<br/>agentcontrol-kg-...")]
  s3 --> nep
  next --> bedrock["Amazon Bedrock"]
  next --> dbx["Databricks workspace"]
  py --> dbx
  next --> aura["Neo4j Aura"]
  py --> aura
  next --> qdrant["Qdrant Cloud eu-west-2"]
```

---

## 15. How the repository modules relate

```mermaid
flowchart TB
  cp["Agents_Express/control-plane<br/>the platform"]
  gu["graph-utility<br/>KG builder + query engine"]
  a2a["a2a-demo<br/>reference A2A peers (Python)"]
  game["saas-gaming-app<br/>multi-tenant reference app"]
  cfg["saas-platform-configs<br/>KRO resource graphs"]
  wl["saas-workloads<br/>ArgoCD + tenant examples"]
  docs["docs/<br/>runbooks, designs, module guides"]

  cp -- "spawns build jobs, registers sources" --> gu
  gu -- "--register Draft Graph Sources" --> cp
  a2a -. "same Sales / Supply Chain scenario,<br/>not imported" .-> cp
  game -. "tier + tenant-context patterns<br/>adopted in tiers.ts / tenancy" .-> cp
  cfg -- "deploys" --> game
  wl -- "tenant instances of" --> cfg
  docs --- cp
  docs --- gu
```

Solid arrows are runtime connections. Dotted arrows are design lineage: patterns
that were adopted, but code that is not imported.
