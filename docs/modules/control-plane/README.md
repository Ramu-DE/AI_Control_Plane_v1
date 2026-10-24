# Control plane — guide

> **Code:** [`Agents_Express/control-plane/`](../../../Agents_Express/control-plane) · **All modules:** [`docs/modules/`](../README.md)


The control plane is a Next.js 15 (App Router) application:

- **UI pages:** `src/app/**/page.tsx`
- **HTTP API:** `src/app/api/**/route.ts`, as thin handlers
- **Domain logic:** `src/lib/**`, where every rule lives
- **Durable state:** a JSON snapshot (`lib/persist.ts`) under `.data/`

| Part | Guide |
|---|---|
| Overview and request flow | this file |
| `src/lib`: domain logic, file by file | [`02-lib.md`](02-lib.md) |
| UI pages, HTTP API, components, tests, live scripts | [`03-app-api-ui-tests.md`](03-app-api-ui-tests.md) |

## How a request flows

```
browser page ──fetch(/proxy/3000/api/...)──► route.ts ──► lib/* ──► external services
     (src/lib/api.ts adds BASE_PATH)           │             │
                                               │             ├─ store.ts (durable state; Proxy marks dirty)
                                               │             ├─ evaluator.ts (Cedar) ◄─ personas.ts, tenancy.ts, regulatory.ts
                                               │             ├─ approvals.ts (maker-checker)
                                               │             ├─ modelBroker.ts ─► bedrock.ts | databricks.ts ─► tools/registry.ts
                                               │             ├─ graph/* (Neo4j, Neptune SPARQL, governed agent queries)
                                               │             ├─ kg/* (build specs, graph-utility jobs, scoped explore)
                                               │             └─ kb/*, memory/*, a2a/*, identity/*
                                               └─ logAudit(...) on every governed outcome
```

## Run it

```bash
npm install
npm run dev                       # http://localhost:3000
npm test                          # node:test over tests/**/*.test.ts
npm run typecheck
BASE_PATH=/proxy/3000 NEXT_PUBLIC_BASE_PATH=/proxy/3000 npm run build && npm run start   # behind the proxy
node integration/smoke_control_plane.mjs   # live end-to-end check (needs the services in SETUP.md)
```

Credentials come from the environment (see `../../../SETUP.md`); nothing secret
is stored in records or in the repository.
