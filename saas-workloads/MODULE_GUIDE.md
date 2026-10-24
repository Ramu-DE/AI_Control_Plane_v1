# saas-workloads — module guide

## What it is for and why it is in this repository

`saas-workloads` is the **tenant half** of the KRO + ArgoCD GitOps reference. The
custom kinds are defined in `saas-platform-configs/resourceGraphs`. This repo
holds:
- the ArgoCD `ApplicationSet` that syncs tenant objects to every data-plane
  cluster,
- the `tenants/` folder, where a tenant is onboarded by committing a `Tenant`
  YAML,
- cluster-wide tenant network policies,
- examples: KRO instances, a standalone `full-app-stack` RGD, raw ACK
  manifests, plain app manifests, and intentionally failing security demos.

Why it is here: the root `README.md` lists it as "ArgoCD ApplicationSets + KRO
tenant examples reference" and calls `saas-platform-configs/` + `saas-workloads/`
"the KRO + ArgoCD GitOps reference for provisioning per-tenant infrastructure if
you adopt that pattern." The control plane does not apply or import anything
from here. `Agents_Express/control-plane/src/lib/types.ts` says its multi-tenancy
types are "replicated from saas-gaming-app/saas-workloads". The control plane's
runtime is pooled and does not provision (`SETUP.md` §3b). This folder shows the
GitOps flow that would do the provisioning.

Note: the task brief mentions Kyverno. The folder has no Kyverno policies. The
cluster policies here are AWS VPC CNI `ClusterNetworkPolicy` objects, and the
runtime guardrails come from Pod Security Standards labels and ResourceQuota (set
by the RGDs).

## Flow (tenant onboarding path)

1. **Commit a tenant.** Add a `kind: Tenant` (`kro.run/v1alpha1`) file under
   `tenants/` (`tenants/README.md`). Copy one of `examples/kro/tenant-*.yaml`
   to start.
2. **ArgoCD syncs it.** `applicationsets/tenant-config.yaml` (ApplicationSet
   `tenants`) creates `<cluster>-tenants` for each cluster labelled
   `cluster.saas.aws/type: data-plane`. It syncs CodeCommit repo `saas-workloads`
   (`main`, path `.`, recursive). `applicationsets/*` and `examples/*` are
   **excluded**, so only `tenants/` (the Tenant files plus
   `cluster-policies.yaml`) reaches the cluster. Auto-sync uses prune +
   selfHeal, `CreateNamespace`, and `ServerSideApply`.
3. **KRO expands it.** The `Tenant` kind is the `tenant-main` RGD installed by
   `saas-platform-configs`. It creates the tenant namespace and then a
   `TenantBasicPackage` or a `TenantProPackage`. These in turn create
   `TenantIAMRole` and `GamingApplication`, which produce the ACK
   IAM/S3/DynamoDB/PodIdentity resources and the Deployment, Service, and
   Ingress for the `saas-gaming-app` image.
4. **Basic prerequisite.** Basic tenants `externalRef` the shared bucket and
   table. A `SharedResourcesPackage` for their `tenantPool` must therefore exist
   (example: `examples/kro/shared-resources.yaml`, pool `pool-resources-001`).
   It sits under `examples/`, which the ApplicationSet skips, so it has to be
   applied separately or copied into `tenants/`.
5. **Isolation baseline.** `tenants/cluster-policies.yaml` denies ingress
   between namespaces labelled `saas-platform/tenant-namespace: "true"`. It also
   allows the DNS and Pod Identity Agent egress that the per-namespace
   `ApplicationNetworkPolicy` would otherwise block.
6. **Pruning.** Removing a Tenant file deletes the Tenant through ArgoCD prune.
   KRO then removes the resources it owns, and the ACK `policyRefs` keep the
   delete order correct.

## Files

| File | What it is for (why) | Key contents | Connects to |
|---|---|---|---|
| `applicationsets/tenant-config.yaml` | Sync tenant objects to every data-plane cluster | `ApplicationSet tenants` in `argocd`; clusters generator `cluster.saas.aws/type: data-plane`; CodeCommit repo `saas-workloads`, `main`; excludes `applicationsets/*,examples/*`; dest ns `tenants`; automated prune/selfHeal; `ServerSideApply` | `tenants/`; twin of `saas-platform-configs/applicationsets/platform-configs.yaml` |
| `tenants/README.md` | Onboarding instruction | "To add tenant, add a Tenant file to the folder" with `apiVersion: kro.run/v1alpha1`, `kind: Tenant` | `Tenant` RGD (`saas-platform-configs/resourceGraphs/tenant-main.yaml`) |
| `tenants/cluster-policies.yaml` | Platform-wide network baseline for all tenant namespaces | `ClusterNetworkPolicy deny-cross-tenant-ingress` (Admin tier, priority 10, Deny from other tenant namespaces); `allow-tenant-platform-egress` (priority 20: DNS 53 UDP/TCP to `172.20.0.0/16`, Pod Identity Agent `169.254.170.23/32:80`) | Namespace label from `tenant-main`; complements `ApplicationNetworkPolicy` in tier RGDs |
| `examples/kro/tenant-basic-01.yaml` | Example basic tenant | `Tenant tenant-001`, tier `basic`, `version: latest`, `tenantPool: pool-resources-001` | `Tenant` RGD -> `TenantBasicPackage`; needs shared pool |
| `examples/kro/tenant-basic-02.yaml` | Example basic tenant | `Tenant tenant-002`, same pool | as above |
| `examples/kro/tenant-basic-03.yaml` | Example basic tenant | `Tenant tenant-003`, same pool | as above |
| `examples/kro/tenant-pro-04.yaml` | Example pro tenant | `Tenant tenant-004`, tier `pro`, `bucketName: tenant-004-assets`, `tableName: gaming-app-tenant-004` | `Tenant` RGD -> `TenantProPackage` |
| `examples/kro/shared-resources.yaml` | Instance of the shared pool for basic tenants | `SharedResourcesPackage pool-resources-001` (ns `default`), `tenantPool: pool-resources-001` | `saas-platform-configs/resourceGraphs/shared-resources.yaml` |
| `examples/kro/full-app-stack.yaml` | Standalone single-app RGD (not tenant-aware), a simpler learning step before the tiered RGDs | RGD `full-app-stack` -> kind `FullAppStack` (`namespace`, `version`, `replicas`, ports, `bucketName`, `tableName`, `albScheme`); `kro-config` externalRef; Namespace, ConfigMap (`S3_BUCKET`, `DYNAMODB_TABLE`, `AWS_REGION`, Pod Identity vars), Service, ALB Ingress, ACK Bucket/Table, IAM Role + S3/DynamoDB Policies, ServiceAccount, PodIdentityAssociation, Deployment (`image: kroConfig.data.ecr_repo:version`) | Instance `gaming-app-stack.yaml`; runs `saas-gaming-app` image |
| `examples/kro/gaming-app-stack.yaml` | Example instance of `FullAppStack` | `FullAppStack gaming-app` (ns `default`), `bucketName: gaming-app-assets`, `tableName: gaming-app-table`, `albScheme: internet-facing` | `full-app-stack.yaml` |
| `examples/kro/architecture.md` | Explains how the RGDs chain | Mermaid diagram and basic/pro text flows: Tenant -> tenant-main -> tier package -> TenantIAMRole + GamingApplication; shared resources via externalRef | All `saas-platform-configs/resourceGraphs/*`. Note: it names instance files (`tenant-anycompany-basic.yaml`, `tenant-techstartup-pro.yaml`, `shared-resources-instance.yaml`) and a `saas-platform` namespace that do not match this repo's files |
| `examples/ack/gaming-dynamodb.yaml` | Raw ACK DynamoDB table for the single-app (non-KRO) step | `Table gaming-app-table` in ns `gaming`; PK/SK, `LeaderboardIndex`, `PlayerGamesIndex`; PAY_PER_REQUEST | `examples/app/gaming-aws.yaml`, `gaming-iam.yaml` |
| `examples/ack/gaming-s3.yaml` | Raw ACK S3 bucket | `Bucket gaming-app-bucket`, name `gaming-app-bucket-${AWS_ACCOUNT_ID}` | `gaming-iam.yaml`, `gaming-aws.yaml` |
| `examples/ack/gaming-iam.yaml` | App IAM identity via ACK | `Policy gaming-app-policy` (DynamoDB on `${DYNAMODB_TABLE_NAME}`, S3 `avatars/*`, Bedrock InvokeModel on `anthropic.claude-*` / `amazon.nova-*`); `Role gaming-app-role` trusted by `pods.eks.amazonaws.com`, `policyRefs` | `gaming-pod-identity.yaml` |
| `examples/ack/gaming-pod-identity.yaml` | Bind SA to role | `PodIdentityAssociation gaming-app-pod-identity`; cluster `saas-data-plane`, ns `gaming`, SA `gaming-app-sa`, `roleRef` `gaming-app-role` | `gaming-iam.yaml`; SA in `examples/app/*` |
| `examples/app/gaming-mock.yaml` | Deploy the app without AWS (mock mode) | Namespace `gaming`, SA `gaming-app-sa`, Deployment `image: ${GAMING_APP_IMAGE}` env `PORT=8080`, `NODE_ENV=development`, `AWS_REGION`; DynamoDB/S3/AI host env commented out; `/health` probes; Service; ALB Ingress | `saas-gaming-app` (falls back to mock storage when `S3_BUCKET`/`DYNAMODB_TABLE` unset) |
| `examples/app/gaming-aws.yaml` | Same app, now wired to the ACK-created AWS resources | As mock, plus `DYNAMODB_TABLE`, `S3_BUCKET`, `AI_HOST_ENABLED=true`, `BEDROCK_MODEL_ID` | `examples/ack/*`; `saas-gaming-app` |
| `examples/security/privileged-pod.yaml` | Teaching artifact meant to fail (Module 400, page 500 "Runtime Guardrails") | `privileged: true` busybox pod, rejected by PSS `baseline` in tenant namespaces | PSS labels from `tenant-main` RGD |
| `examples/security/oversized-deployment.yaml` | Teaching artifact meant to fail (same module) | Deployment requesting 2 CPU, above the basic `ResourceQuota` of 500m, so pods are never created | `ResourceQuota` in `tenant-basic-tier` RGD |

## How to run / apply

The files contain no shell commands. They are meant for ArgoCD plus manual
example application:

- **GitOps:** push to a CodeCommit repo named `saas-workloads` (branch `main`).
  Register clusters with labels `cluster.saas.aws/type: data-plane` and
  `aws-region`. Apply `applicationsets/tenant-config.yaml` in `argocd`. Then add
  or remove `Tenant` files in `tenants/` to onboard or offboard tenants.
- **Prerequisite:** the RGDs from `saas-platform-configs` must already be
  installed (its own ApplicationSet), and for basic tenants a
  `SharedResourcesPackage` must exist for their pool.
- **Examples:** `examples/ack/*.yaml` and `examples/app/*.yaml` contain
  `${AWS_ACCOUNT_ID}`, `${AWS_REGION}`, `${DYNAMODB_TABLE_NAME}`,
  `${S3_BUCKET_NAME}`, `${GAMING_APP_IMAGE}`, `${BEDROCK_MODEL_ID}` placeholders
  that must be substituted before applying (the substitution tool is not named in
  the files). `examples/security/*` are applied into a tenant namespace to
  demonstrate rejection.

## Connections to other modules

- **saas-platform-configs**: defines every KRO kind used here except
  `FullAppStack` (defined locally in `examples/kro/full-app-stack.yaml`). The two
  ApplicationSets are deliberate twins: platform first (kinds), workloads second
  (instances).
- **saas-gaming-app**: the workload. The examples deploy its image
  (`${GAMING_APP_IMAGE}` or `kro-config.ecr_repo`) on port 8080 with `/health`
  probes. The env vars set here (`PORT`, `NODE_ENV`, `AWS_REGION`, `S3_BUCKET`,
  `DYNAMODB_TABLE`, `AI_HOST_ENABLED`, `BEDROCK_MODEL_ID`) are ones the app
  reads. Without `S3_BUCKET`/`DYNAMODB_TABLE` it runs in mock mode, which is what
  `gaming-mock.yaml` relies on.
- **Agents_Express/control-plane**: conceptual source only, for the tenant
  model (tenantId, basic/pro tier, pooled vs siloed). The control plane does not
  provision namespaces, IAM, or data stores per tenant.
