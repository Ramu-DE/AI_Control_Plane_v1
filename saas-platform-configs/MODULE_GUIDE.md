# saas-platform-configs — module guide

## What it is for and why it is in this repository

`saas-platform-configs` is the **platform half** of a KRO + ArgoCD GitOps setup for
provisioning per-tenant infrastructure on EKS. It holds the KRO
`ResourceGraphDefinition`s (RGDs) that define the custom kinds `Tenant`,
`TenantBasicPackage`, `TenantProPackage`, `TenantIAMRole`, `GamingApplication` and
`SharedResourcesPackage`, plus the ArgoCD `ApplicationSet` that installs those
RGDs on every data-plane cluster. The tenant *instances* that use these kinds live
in the sibling `saas-workloads/` folder.

Why it is here: the root `README.md` lists it as the "KRO ResourceGraphs (tenant
provisioning) reference" and says (section 7) that `saas-platform-configs/` and
`saas-workloads/` "contain the KRO + ArgoCD GitOps reference for provisioning
per-tenant infrastructure if you adopt that pattern." It is **reference only**:
nothing in `Agents_Express/control-plane` reads or applies these files. The
control plane copied the *concepts* — basic = pooled/shared, pro =
siloed/dedicated, tier-scoped model access (`src/lib/tiers.ts`, `src/lib/types.ts`
note they are replicated from `saas-gaming-app`/`saas-workloads`) — but its own
runtime is pooled: `SETUP.md` §3b says "Runtime, gateway | pooled | one process;
`compute.agentRuntimeId` declares intent but does not provision." These RGDs are
what real per-tenant provisioning would look like.

The workload these RGDs deploy is the `saas-gaming-app` container (Node app on
port 8080 with `/health`); the env vars they inject (`TENANT_ID`, `TENANT_NAME`,
`TENANT_TIER`, `PORT`, `S3_BUCKET`, `DYNAMODB_TABLE`, `AWS_REGION`,
`AI_HOST_ENABLED`, `BEDROCK_MODEL_ID`) are the ones that app reads.

## Flow (provisioning path)

1. **ArgoCD installs the RGDs.** `applicationsets/platform-configs.yaml` uses a
   `clusters` generator selecting clusters labelled
   `cluster.saas.aws/type: data-plane`. For each it creates Application
   `<cluster>-platform` that syncs repo
   `https://git-codecommit.<aws-region label>.amazonaws.com/v1/repos/saas-platform-configs`
   (branch `main`, path `.`, recursive, excluding `applicationsets/*` and
   `examples/*`), so only `resourceGraphs/*.yaml` get applied. Auto-sync with
   prune + selfHeal, `CreateNamespace`, `ServerSideApply`, `RenderHelm`.
2. **KRO registers the kinds.** Each RGD becomes a CRD in group `kro.run`,
   version `v1alpha1`.
3. **Shared pool (basic tier prerequisite).** A `SharedResourcesPackage`
   instance creates the pool namespace, a shared ACK S3 `Bucket`
   (`gaming-shared-bucket`), a shared ACK DynamoDB `Table`
   (`gaming-shared-table`, PK/SK + `LeaderboardIndex`/`PlayerGamesIndex`) and the
   Karpenter `NodePool` `basic-tier` (tainted `tenant-pool=basic-tier`).
4. **Tenant instance -> `Tenant` RGD** (`tenant-main.yaml`). Reads the external
   ConfigMap `default/kro-config` (`ecr_repo`, `region`, `account_id`), creates
   the tenant namespace (labels `tenant-id`, `tenant-tier`,
   `saas-platform/tenant-namespace: "true"`, PSS enforce `baseline`,
   warn/audit `restricted`), then with `includeWhen` on `tier` creates either a
   `TenantBasicPackage` or a `TenantProPackage` in that namespace, passing
   `image: kroConfig.data.ecr_repo`.
5. **Tier package.**
   - Basic: `externalRef`s the shared bucket/table in `tenantPool`, then creates
     `TenantIAMRole` (prefix `avatars/<tenantId>/`), `ApplicationNetworkPolicy`,
     small `ResourceQuota`/`LimitRange`, and a `GamingApplication` (1 replica,
     nodePool `basic-tier`, model `us.amazon.nova-micro-v1:0`).
   - Pro: creates a dedicated ACK S3 bucket and DynamoDB table
     (`gaming-app-tenant-<tenantId>`), a dedicated `NodePool`
     `pro-<tenantId>`, `TenantIAMRole`, network policy, larger quota, and a
     `GamingApplication` (3 replicas, model `us.amazon.nova-lite-v1:0`).
6. **`TenantIAMRole`** creates tier-specific ACK IAM `Policy`s (S3, DynamoDB,
   Bedrock), an ACK IAM `Role` trusted by `pods.eks.amazonaws.com`, an ACK EKS
   `PodIdentityAssociation` (cluster `saas-data-plane`, SA `<tenantId>-sa`) and
   the `ServiceAccount`.
7. **`GamingApplication`** creates the ConfigMap, `Deployment`
   (`image:version`, Pod Identity token volume, nodeSelector + toleration for the
   nodePool, hardened securityContext, `/health` probes), `Service`, ALB
   `Ingress`, and (pro only) an `HPA`.

Cross-tenant network isolation (`ClusterNetworkPolicy`) is not in this repo; it
lives in `saas-workloads/tenants/cluster-policies.yaml` and targets the
`saas-platform/tenant-namespace` label set here.

## Files

| File | What it is for (why) | Key contents | Connects to |
|---|---|---|---|
| `applicationsets/platform-configs.yaml` | Deliver the RGDs to every data-plane cluster via GitOps | `ApplicationSet platform-configs` in `argocd`; clusters generator on `cluster.saas.aws/type: data-plane`; CodeCommit repo `saas-platform-configs`, `main`; excludes `applicationsets/*,examples/*`; dest ns `tenants`; automated prune/selfHeal; `ServerSideApply`, `RenderHelm` | All `resourceGraphs/*.yaml`; twin of `saas-workloads/applicationsets/tenant-config.yaml` |
| `resourceGraphs/tenant-main.yaml` | Top-level entry kind: one `Tenant` object per customer | RGD `tenant-main` -> kind `Tenant` (`tenantId`, `tenantName`, `tier` enum basic/pro, `tenantPool` default `pool-resources-001`, `version`, `bucketName`, `tableName`, `albScheme`); `externalRef` ConfigMap `kro-config`; namespace with PSS labels; conditional `basicPackage`/`proPackage` | `TenantBasicPackage`, `TenantProPackage`; instances in `saas-workloads/examples/kro/tenant-*.yaml` |
| `resourceGraphs/shared-resources.yaml` | Pooled infrastructure shared by all basic tenants | RGD `shared-resources-package` -> kind `SharedResourcesPackage` (`tenantPool`, `tableName` default `saas-gaming-shared`); namespace; ACK `Bucket gaming-shared-bucket` (name `<pool>-<account>`); ACK `Table gaming-shared-table` (`TENANT#<id>#...` key design, 2 GSIs); Karpenter `NodePool basic-tier` (cpu 10, 20Gi) | Referenced by `tenant-basic-tier.yaml` via `externalRef`; instance `saas-workloads/examples/kro/shared-resources.yaml` |
| `resourceGraphs/tenant-basic-tier.yaml` | Pool-model tenant: shared data stores, per-tenant identity and limits | RGD `tenant-basic-package` -> kind `TenantBasicPackage`; `externalRef` shared bucket/table; `TenantIAMRole` with `s3Prefix: avatars/<id>/`; `ApplicationNetworkPolicy tenant-isolation` (ingress 8080; egress S3/DynamoDB/STS/bedrock-runtime 443); `ResourceQuota` (500m/512Mi req, 5 pods); `LimitRange`; `GamingApplication` replicas 1, `nodePool: basic-tier`, `modelId: us.amazon.nova-micro-v1:0`, env `S3_BUCKET`, `S3_PREFIX`, `DYNAMODB_TABLE`, `DYNAMODB_PARTITION_KEY_PREFIX`, Pod Identity vars | `tenant-main`, `shared-resources`, `tenant-iam-role`, `gaming-application` |
| `resourceGraphs/tenant-pro-tier.yaml` | Silo-model tenant: dedicated data stores and nodes | RGD `tenant-pro-package` -> kind `TenantProPackage`; ACK `Bucket` (`<bucketName>-<account>`) and `Table gaming-app-tenant-<id>`; `NodePool pro-<id>` (cpu 20, 40Gi, tainted); network policy as basic; `ResourceQuota` (4 CPU/8Gi req, 20 pods); `GamingApplication` replicas 3, `modelId: us.amazon.nova-lite-v1:0` | `tenant-main`, `tenant-iam-role`, `gaming-application` |
| `resourceGraphs/tenant-iam-role.yaml` | Least-privilege AWS identity per tenant, scoped by tier | RGD `tenant-iam-role` -> kind `TenantIAMRole`; Bedrock `InvokeModel` policy: basic = Claude Haiku / Nova Micro, pro = Claude Sonnet / Nova Lite; basic S3 policy prefix-scoped + DynamoDB `dynamodb:LeadingKeys` `TENANT#<id>#*`; pro full access to own bucket/table; ACK `Role` (`<id>-app-role`, `policyRefs` for delete ordering); `PodIdentityAssociation` (cluster `saas-data-plane`); `ServiceAccount <id>-sa` | Created by both tier packages; SA used by `gaming-application` Deployment |
| `resourceGraphs/gaming-application.yaml` | Generic K8s workload for the saas-gaming-app container | RGD `gaming-application` -> kind `GamingApplication` (`image`, `version`, `replicas`, ports, `resources`, `env []EnvVar`, `nodePool`, `albScheme`, `aiHostEnabled`, `modelId`); ConfigMap with `TENANT_ID/NAME/TIER`, `PORT`, `AI_HOST_ENABLED`, `BEDROCK_MODEL_ID`; Deployment (non-root uid 1000, drop ALL, seccomp, `/health` probes, Pod Identity projected token); ClusterIP Service; ALB Ingress tagged per tenant; HPA (pro only, 70% CPU / 80% mem, max 10) | Created by tier packages; runs `saas-gaming-app` image |

## How to run / apply

The files contain no shell commands; they are applied by ArgoCD:

- Push this folder to a CodeCommit repo named `saas-platform-configs` (branch
  `main`) in the region given by the cluster's `aws-region` label.
- Register data-plane clusters in ArgoCD with label
  `cluster.saas.aws/type: data-plane` and an `aws-region` label, and apply
  `applicationsets/platform-configs.yaml` in the `argocd` namespace. ArgoCD then
  auto-syncs `resourceGraphs/`.
- Prerequisites the files assume but do not create: KRO, ACK controllers
  (S3, DynamoDB, IAM, EKS), Karpenter / EKS Auto Mode `NodeClass default`, the
  AWS Load Balancer Controller (`ingressClassName: alb`), the VPC CNI network
  policy CRDs (`networking.k8s.aws`), an EKS cluster named `saas-data-plane`,
  and ConfigMap `default/kro-config` with keys `ecr_repo`, `region`,
  `account_id`.

## Connections to other modules

- **saas-workloads**: holds the instances (`Tenant`, `SharedResourcesPackage`)
  of the kinds defined here, the tenant ApplicationSet, and the
  `ClusterNetworkPolicy` baseline that uses the `saas-platform/tenant-namespace`
  label from `tenant-main`.
- **saas-gaming-app**: the container these RGDs deploy. It reads `TENANT_*`,
  `S3_BUCKET`, `DYNAMODB_TABLE`, `AI_HOST_ENABLED`, `BEDROCK_MODEL_ID`. It
  writes avatars to `avatars/<tenantId>/<playerId>/...` (matches the IAM
  `s3Prefix`) and uses `TENANT#<tenantId>#...` keys (matches `LeadingKeys`).
  Its `tenantContextMiddleware` default pro table name
  `gaming-app-tenant-<tenantId>` matches the pro RGD.
- **Agents_Express/control-plane**: conceptual reuse only (tier = pooled vs
  siloed, per-tier model allowlists, tier limits). No file is imported or
  applied.

Observed inconsistencies (as written in the files):
- Basic tier sets `S3_PREFIX=tenants/<id>/` and `DYNAMODB_PARTITION_KEY_PREFIX`,
  but `saas-gaming-app/src` does not read either; the IAM prefix is
  `avatars/<id>/`.
- Trailing comments in `tenant-basic-tier.yaml` name a `saas-gaming-shared`
  bucket and `shared-resources/*.yaml` files that do not exist here. The actual
  bucket is `<tenantPool>-<account_id>`.
- The RGDs set Nova Micro/Lite model IDs, while `saas-gaming-app/README.md`
  describes Claude Haiku/Sonnet global profiles. The IAM policies allow both
  families per tier.
- A comment in `tenant-main.yaml` says the ClusterNetworkPolicies are in a
  "cluster-policies RGD"; in this repo they are plain manifests in
  `saas-workloads/tenants/cluster-policies.yaml`.
