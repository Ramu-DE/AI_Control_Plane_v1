# saas-gaming-app — module guide

## What it is for and why it is in this repository

`saas-gaming-app` is a multi-tenant SaaS reference application from the AWS "EKS Platform Engineering" workshop (`package.json` author "AWS Workshop"). It is an Express + TypeScript number-guessing game (1-100, 10 guesses, starting score 1000) backed by DynamoDB, S3, CloudWatch and, optionally, Amazon Bedrock. One container image serves exactly one tenant; tenant identity and tier come from environment variables (`TENANT_ID`, `TENANT_NAME`, `TENANT_TIER`).

It is here because it is **the source of the tenant-tier and middleware patterns adopted by the AgentControl control plane**. The control plane does not import or run this code. It copies the ideas:

- `Agents_Express/control-plane/src/lib/tiers.ts` says it is "replicated from saas-gaming-app/src/middleware/tierMiddleware.ts". It keeps the `basic | pro` tiers and a `getTierConfig(tier)` that returns limits plus feature flags. The fields were changed for agents (`maxAgents`, `maxToolsPerAgent`, `monthlyTokenBudget`, `enableAnalytics`, `enableAuditExport`, ...), where this app uses `avatarSizeLimit`, `leaderboardLimit`, `enableAnalytics`, and so on.
- `isolationForTier()` in `tiers.ts` maps basic to `pool` and pro to `silo`. Its comment says this "mirrors the shared-table vs dedicated-table strategy in tenantContextMiddleware" (basic tenants share `gaming-app-shared`; each pro tenant gets `gaming-app-tenant-{id}`).
- `control-plane/src/lib/types.ts` has a section titled "SaaS multi-tenancy (replicated from saas-gaming-app/saas-workloads)". It defines `TenantTier`, `IsolationModel` and `TierConfig` ("mirrors tierMiddleware.getTierConfig"). The control plane also adds a tenant tree (`parentId`, `type`), which this app does not have.
- The control plane has a `requireProTier`-style gate: requests are refused when they go over tier limits, and the response includes upgrade information (`nextPlan()`/`planLabel()` in `tiers.ts`, compared with the `upgrade` payload from `requireProTier` here).

This app is also the workload that the KRO/ArgoCD reference in `saas-platform-configs/` and `saas-workloads/` deploys. Those ResourceGraphDefinitions inject the tenant env vars, `DYNAMODB_TABLE` and (in `gaming-application.yaml`) `BEDROCK_MODEL_ID` into the container.

## Flow

Request path (`src/server.ts`):

1. `cors()`, then `express.json()`, then `urlencoded`.
2. `injectTenantContext` (tenantContextMiddleware) reads `TENANT_ID`/`TENANT_NAME`/`TENANT_TIER` on **every request**. Both id and name are lower-cased, and they default to `anycompany-01`/`Any Company`. It resolves the table name: explicit `DYNAMODB_TABLE` wins, otherwise pro gets `gaming-app-tenant-{id}` and basic gets `gaming-app-shared`. The result is attached as `req.tenantContext`.
3. `injectTier` (tierMiddleware) sets `req.tenantTier`. An invalid value falls back to `basic` with a warning.
4. Static UI is served from `src/public`, then a request logger runs.
5. Routers: `/health`, `/api/game`, `/api/player`, `/api/analytics` (every route behind `requireProTier`, which returns 403 with an `upgrade` payload), `/api/config`. After that come the 500 error handler and the 404 handler.
6. Routes call services, passing `tenantContext`:
   - `gameLogic` uses `dynamoService` (or `mockDataService` when `DYNAMODB_TABLE` is unset) and `bedrockClueService`.
   - `player` uses `s3Service` (or mock in-memory data URLs when `S3_BUCKET` is unset).
   - `analyticsService` uses `dynamoService` or mock data.
7. Tenant isolation in data. On the shared table, basic tenants get keys prefixed `TENANT#{id}#...` (`PLAYER#`, `SESSION#`, `LEADERBOARD`). Pro tenants use unprefixed keys in their dedicated table. Leaderboard queries GSI1 and per-player games query GSI2. S3 avatars are keyed `avatars/{tenantId}/{playerId}/avatar.png`.
8. Every DynamoDB and S3 call records per-tenant usage metrics (`TenantId` and `TenantTier` dimensions) into a buffer. The buffer is flushed to CloudWatch namespace `SaaSGaming/TenantUsage` every 10 s, or as soon as it holds 20 entries.
9. AI Game Host: on a wrong guess while the game is still active, `buildMoveResult` calls `generateClue(guess, target, tier)`. That builds deterministic facts (direction, distance, parity, prime, digit sum, range band) and sends them to Bedrock `ConverseCommand`. Pro gets a riddle style and basic gets a single fact. The call uses `maxAttempts: 1` and a timeout (`AI_HOST_TIMEOUT_MS`, default 5000). On any failure it returns `null`, and the client shows plain higher/lower feedback. The clue never changes score or outcome.

Lifecycle: graceful shutdown on SIGTERM/SIGINT, uncaught exceptions and unhandled rejections, with a forced exit after 30 s.

## Files

| File | What it is for (why) | Key contents | Connects to |
|---|---|---|---|
| `src/server.ts` | App entry point; wires middleware and routes | middleware order, `/health`, `/api/{game,player,analytics,config}` mounts, static `../src/public`, error/404 handlers, `startServer`, graceful `shutdown`; exports `app` | all routes, both middlewares |
| `src/types/tenant.ts` | Shared tenant types | `TenantTier = 'basic'\|'pro'`, `Tenant`, `TenantContext {tenantId, tenantName, tier, tableName}`, global `Express.Request.tenantContext` augmentation | middlewares, all services; mirrored by control-plane `lib/types.ts` |
| `src/middleware/tenantContextMiddleware.ts` | Per-request tenant context and DB routing (silo vs pool) | `getTableName` (explicit `DYNAMODB_TABLE`, else pro gets `gaming-app-tenant-{id}`, basic gets `gaming-app-shared`), `injectTenantContext`, `requireTenantContext` (403), `getTenantContext`, `logTenantConfiguration` | `server.ts`; pattern behind control-plane `isolationForTier` |
| `src/middleware/tierMiddleware.ts` | Tier gating and per-tier limits | `injectTier`, `requireProTier` (403 + `upgrade.features`), `getTierConfig`: basic 1MB avatar / top-3 / no analytics, history, export or GIF; pro 5MB / top-10 / all enabled | game, player, analytics, config routes; **origin of control-plane `lib/tiers.ts`** |
| `src/routes/health.ts` | Kubernetes liveness/readiness | `GET /health` returns status, uptime, and whether S3/Dynamo are configured | Dockerfile `HEALTHCHECK` |
| `src/routes/game.ts` | Game API | `POST /start`, `POST /move` (400/404 mapping), `GET /state/:sessionId`, `GET /leaderboard` (limit capped at the tier's `leaderboardLimit`) | `gameLogic`, `getTierConfig` |
| `src/routes/player.ts` | Avatars and profiles | multer in-memory storage (5MB hard cap, GIF only if `allowAnimatedAvatars`); `POST /avatar` (multipart upload with tier size check, or JSON predefined `avatarId`), `GET /avatar/:playerId` (presigned URL, 3600 s), `GET /profile/:playerId`, `GET /check-nickname` | `s3Service`, `gameLogic`, `getTierConfig` |
| `src/routes/analytics.ts` | Pro-only analytics | `GET /overview`, `/trends?days=`, `/history?limit&offset`, `/export` (JSON attachment); all behind `requireProTier` | `analyticsService` |
| `src/routes/config.ts` | Lets the UI discover tier, tenant and service state | `GET /tier` (tier + config), `GET /tenant`, `GET /status` (dynamo/s3/aiHost configured or mock, plus warnings and mock stats) | `getTierConfig`, `mockDataService`, `isAiHostEnabled` |
| `src/services/gameLogic.ts` | Deterministic game engine | `startGame` (random 1-100 target, score 1000, 10 guesses, `SESSION#` PK with `TENANT#` prefix for basic), `processMove` (correct adds remaining×100; wrong subtracts 50; out of guesses sets score 0), `buildMoveResult` (attaches the optional clue), leaderboard, streaks, profile, daily stats, `checkNicknameExists` | `dynamoService`, `mockDataService`, `bedrockClueService` |
| `src/services/dynamoService.ts` | Tenant-aware DynamoDB access | key builders (`PLAYER#` / `TENANT#{id}#PLAYER#`, `LEADERBOARD`, `SCORE#{10-digit}#PLAYER#`), `putItem`/`getItem`/`queryItems`/`updateItem`, `queryLeaderboard` (GSI1), `queryGamesByDateRange`/`queryAllPlayerGames` (GSI2), `scanItemsByPrefix`, `updateDailyStats`; table taken from `tenantContext.tableName` | `usageMetricsService`; tables provisioned by KRO RGDs / ACK examples |
| `src/services/s3Service.ts` | Avatar storage | `uploadFile` (falls back to a mock base64 data URL when `S3_BUCKET` is unset), `getPresignedUrl`, `fileExists` | `mockDataService`, `usageMetricsService` |
| `src/services/analyticsService.ts` | Pro analytics computations | `getAnalyticsOverview`, `getWinRateTrends`, `getGameHistory`, `exportPlayerData`; streak, average and day-grouping helpers; mock fallback | `dynamoService`, `mockDataService` |
| `src/services/bedrockClueService.ts` | AI Game Host: tiered Bedrock clue that never decides the outcome | env `AI_HOST_ENABLED`, `BEDROCK_MODEL_ID`, `AI_HOST_TIMEOUT_MS`; `buildTargetFacts`, `buildPrompt` (pro: riddle from 2 facts; basic: 1 fact), `generateClue` (Converse, maxTokens 100, temp 0.7, returns null on failure), `isAiHostEnabled` | `gameLogic`, `config` route; model id injected by the KRO `gaming-application.yaml` RGD |
| `src/services/usageMetricsService.ts` | Per-tenant cost/usage attribution | `recordDynamoDBUsage`, `recordS3Usage` (RequestCount, ConsumedCapacityUnits, bytes) with TenantId/TenantTier dimensions; buffer of 20 entries, 10 s `setInterval` flush to CloudWatch `SaaSGaming/TenantUsage` | `dynamoService`, `s3Service` |
| `src/services/mockDataService.ts` | Run with no AWS at all | in-memory Maps for tenants, players, sessions and avatars; `shouldUseMockData()` (true when `DYNAMODB_TABLE` is unset); mock leaderboard, analytics, history and export; `getMockDataStats`, `clearMockData`, `initializeDefaultMockTenants` (acme-corp basic, tech-startup pro; no caller in `src`) | gameLogic, analytics, s3, config |
| `src/public/index.html` | Single-page game UI | sections `onboarding-section`, `game-play`, `leaderboard-section`, `analytics-section`; `change-avatar-modal`, `upgrade-modal`; loads Chart.js from the jsDelivr CDN and `/game.js` | `game.js`, `styles.css` |
| `src/public/game.js` | Front-end logic (~1.9k lines) | `fetchTenantContext`/`detectTenantTier`/`updateUIForTier`, `checkConfigurationStatus`, onboarding steps and nickname check, `startNewGame`/`submitGuess`, avatar selection/upload, leaderboard, analytics dashboard (trend and score-distribution charts, paginated history, export), upgrade modal | all `/api/*` endpoints |
| `src/public/styles.css` | UI styling | tenant header, tier/Pro badges, upgrade banner and modal, analytics dashboard, game board, leaderboard, avatar grid, responsive rules | `index.html` |
| `test/bedrockClueService.test.ts` | Unit tests for clue facts and fallback | `buildTargetFacts` (direction, distance, parity, prime, digit sum, range band, consistency for 1-100); `generateClue` returns null when the flag is off, the model is missing, or the client throws; `isAiHostEnabled` truth table | `bedrockClueService` |
| `test/gameLogic.move.test.ts` | Checks that the clue never changes deterministic fields | runs `processMove` on the mock path (deletes `DYNAMODB_TABLE`): no clue when disabled, clue attached when enabled, no clue on a winning move | `gameLogic`, `mockDataService` |
| `Dockerfile` | Container image for EKS | 2-stage `node:22-slim` from public ECR: `npm ci`, then `npm run build`; copies `dist`, `node_modules`, `src/public`; `EXPOSE 8080`; `USER node`; `HEALTHCHECK` on `/health`; `CMD node dist/server.js` | `health.ts`; image referenced by KRO RGDs / `saas-workloads` app examples |
| `.dockerignore` | Keeps the build context small | excludes node_modules, dist, .git, `.env*`, `*.md`, coverage, `*.test.ts`, jest.config.js | Dockerfile |
| `package.json` | Scripts and dependencies | scripts `build` (tsc), `start`, `dev` (ts-node), `test` (jest), `lint`, `format`; AWS SDK v3 (dynamodb, lib-dynamodb, s3, s3-request-presigner, cloudwatch, bedrock-runtime), express, cors, multer, uuid; Node >=18 | everything |
| `package-lock.json` | Locked dependency tree for `npm ci` | generated lockfile | Dockerfile (`npm ci`) |
| `tsconfig.json` | Production compile | ES2020/commonjs, `src` compiled to `dist`, strict, declarations and source maps, excludes `*.test.ts` | `npm run build` |
| `tsconfig.jest.json` | Test compile | extends base, `rootDir: .`, includes `test/**`, turns off unused-var checks | `jest.config.js` |
| `jest.config.js` | Test runner config | `ts-jest` preset, node env, roots `test/`, `*.test.ts`, `clearMocks` | `tsconfig.jest.json` |
| `.env.example` | Local env template | `AWS_REGION`, `S3_BUCKET`, `DYNAMODB_TABLE`, `TENANT_ID`/`TENANT_NAME`/`TENANT_TIER`, `PORT`, `NODE_ENV`, commented-out AWS keys (no AI Host vars) | tenantContext/tier middleware, services |
| `.eslintrc.json` | Lint rules | `@typescript-eslint` recommended; `no-explicit-any` set to warn; unused vars are errors except names starting `_` | `npm run lint` |
| `.prettierrc` | Formatting | semicolons, single quotes, width 100, 2 spaces, trailing comma es5 | `npm run format` |
| `.gitignore` | Keeps generated and secret files out of git | node_modules, dist, `.env*`, IDE/OS files, logs, coverage | — |
| `README.md` | Product and ops documentation | features, AI Game Host design and Basic vs Pro table (Haiku 4.5 vs Sonnet 4.6 via `global.anthropic.*` profiles), IAM/Bedrock requirements, local/Docker run, endpoints, env table, DynamoDB schema, S3 layout, a pointer to the KRO `TenantBasicPackage` deploy | all of the above |

Note on README accuracy:
- The README lists `GET /api/leaderboard`, but the code mounts it at `GET /api/game/leaderboard`, which is also what `game.js` calls.
- The README example `curl -X POST /api/game/start` has no body, so the route returns 400 (it requires `playerId` and `playerName`).

## How to run / apply

From `README.md` / `package.json`:

```bash
cd saas-gaming-app
npm install
export TENANT_ID=acme-corp-001 TENANT_NAME="Acme Corporation" TENANT_TIER=basic   # or pro
# optional AWS: export S3_BUCKET=... DYNAMODB_TABLE=... AWS_REGION=us-east-1
# optional AI host: export AI_HOST_ENABLED=true BEDROCK_MODEL_ID=global.anthropic.claude-haiku-4-5-20251001-v1:0
npm run dev                 # ts-node, http://localhost:8080
npm run build && npm start  # production
npm test                    # jest (both tests use the mock path, no AWS needed)
npm run lint; npm run format
curl http://localhost:8080/health
```

Without `DYNAMODB_TABLE` or `S3_BUCKET`, the app runs fully in-memory. `GET /api/config/status` reports this and lists warnings.

Optional AWS resources (README):

```bash
aws s3 mb s3://your-test-bucket
aws dynamodb create-table --table-name your-test-table \
  --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

The README table only has PK/SK. The leaderboard and history queries also need GSI1 (`GSI1PK`/`GSI1SK`) and GSI2 (`GSI2PK`/`GSI2SK`). The KRO RGDs provision those indexes (for example `saas-platform-configs/resourceGraphs/shared-resources.yaml` creates the shared table with GSI1 and GSI2).

Docker:

```bash
docker build -t saas-gaming-app:local .
docker run -p 8080:8080 -e TENANT_ID=acme-corp-001 -e TENANT_NAME="Acme Corporation" \
  -e TENANT_TIER=basic -e PORT=8080 -e S3_BUCKET=$S3_BUCKET -e DYNAMODB_TABLE=$DYNAMODB_TABLE \
  -e AWS_REGION=$AWS_REGION -e AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID \
  -e AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY saas-gaming-app:local
```

Kubernetes deployment uses the KRO custom resources in `saas-platform-configs/` and `saas-workloads/`. This folder has no manifests of its own.

## Connections to other modules

- **Agents_Express/control-plane** (by design, no code import):
  - `src/lib/tiers.ts` copies `tierMiddleware.getTierConfig`, adapted to agent limits, and adds the plan labels "Standard"/"Expanded".
  - `isolationForTier` (pool/silo) copies the shared-table vs dedicated-table logic of `tenantContextMiddleware`.
  - The SaaS section of `src/lib/types.ts` (`TenantTier`, `IsolationModel`, `TierConfig`) is marked as replicated from here.
  - The control plane extends the single-tenant-per-pod model of this app into a tenant tree.
- **saas-platform-configs/resourceGraphs**:
  - `tenant-basic-tier.yaml`, `tenant-pro-tier.yaml` and `gaming-application.yaml` deploy this image (`schema.spec.image`).
  - The tier RGDs say `TENANT_ID/NAME/TIER` come from a ConfigMap, and they set `DYNAMODB_TABLE`.
  - `gaming-application.yaml` sets `TENANT_TIER: ${schema.spec.tier}` and `BEDROCK_MODEL_ID: ${schema.spec.modelId}`.
  - `shared-resources.yaml` defines the shared table with GSI1 and GSI2.
- **saas-workloads**:
  - `examples/app/gaming-aws.yaml` is a plain Deployment of this app (`${GAMING_APP_IMAGE}`, `DYNAMODB_TABLE`, `BEDROCK_MODEL_ID`).
  - `gaming-mock.yaml` is the same Deployment with those env vars commented out, so it runs on mock data.
  - `examples/ack/gaming-*` create its DynamoDB Table, S3 Bucket, IAM Policy/Role and PodIdentityAssociation with ACK.
- **a2a-demo / graph-utility**: no connection.
