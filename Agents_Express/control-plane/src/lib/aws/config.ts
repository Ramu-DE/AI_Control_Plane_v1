// Central AWS configuration for the real-AWS execution slice.
//
// Design rules (all enforced here):
//  (1) No credentials in code/logs/files — we NEVER construct a client with
//      explicit credentials. The AWS SDK default credential provider chain is
//      used (env, SSO, shared config, instance/Pod/ECS role, etc.).
//  (2) Execution mode is driven by AWS_EXECUTION_MODE=local|aws, default local.
//  (3) Region comes ONLY from AWS_REGION or AWS_DEFAULT_REGION. There is NO
//      hardcoded fallback — if neither is set in aws mode we raise a clear
//      configuration error.
//  (5) Nothing in this module (or its callers) creates or mutates AWS
//      resources — only describe/list/read/authorization-check operations.
//
// This module is server-only (used from Route Handlers). It must never be
// imported into a client component.

import { STSClient } from "@aws-sdk/client-sts";
import { BedrockAgentClient } from "@aws-sdk/client-bedrock-agent";
import { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";
import { VerifiedPermissionsClient } from "@aws-sdk/client-verifiedpermissions";

export type ExecutionMode = "local" | "aws";

/** Resolve the execution mode. Defaults to "local" when unset or unrecognized. */
export function getExecutionMode(): ExecutionMode {
  const raw = (process.env.AWS_EXECUTION_MODE || "").trim().toLowerCase();
  return raw === "aws" ? "aws" : "local";
}

export function isAwsMode(): boolean {
  return getExecutionMode() === "aws";
}

/** A typed configuration error surfaced to callers as an honest 4xx/412. */
export class AwsConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AwsConfigError";
    this.code = code;
  }
}

/**
 * Resolve the region strictly from AWS_REGION or AWS_DEFAULT_REGION.
 * No hardcoded fallback. Throws AwsConfigError when neither is set.
 */
export function resolveRegion(): string {
  const region =
    (process.env.AWS_REGION || "").trim() ||
    (process.env.AWS_DEFAULT_REGION || "").trim();
  if (!region) {
    throw new AwsConfigError(
      "REGION_UNSET",
      "AWS region is not configured. Set AWS_REGION or AWS_DEFAULT_REGION " +
        "(no hardcoded fallback is used)."
    );
  }
  return region;
}

/**
 * Guard used by every real-AWS code path: requires aws mode AND a region.
 * Returns the resolved region, or throws AwsConfigError with a clear code.
 */
export function requireAwsConfig(): { region: string } {
  if (!isAwsMode()) {
    throw new AwsConfigError(
      "MODE_LOCAL",
      "Execution mode is 'local'. Set AWS_EXECUTION_MODE=aws to enable live " +
        "AWS calls."
    );
  }
  return { region: resolveRegion() };
}

// ---------------------------------------------------------------------------
// Client factories. All clients are created WITHOUT explicit credentials so
// the SDK default credential provider chain is used. Clients are cached per
// region for reuse across invocations.
// ---------------------------------------------------------------------------

const _cache: {
  region?: string;
  sts?: STSClient;
  bedrockAgent?: BedrockAgentClient;
  bedrockAgentRuntime?: BedrockAgentRuntimeClient;
  verifiedPermissions?: VerifiedPermissionsClient;
} = {};

function ensureRegionCache(region: string) {
  if (_cache.region !== region) {
    // Region changed (e.g. env updated in dev) — drop cached clients.
    _cache.region = region;
    _cache.sts = undefined;
    _cache.bedrockAgent = undefined;
    _cache.bedrockAgentRuntime = undefined;
    _cache.verifiedPermissions = undefined;
  }
}

export function stsClient(): STSClient {
  const { region } = requireAwsConfig();
  ensureRegionCache(region);
  if (!_cache.sts) _cache.sts = new STSClient({ region });
  return _cache.sts;
}

export function bedrockAgentClient(): BedrockAgentClient {
  const { region } = requireAwsConfig();
  ensureRegionCache(region);
  if (!_cache.bedrockAgent) _cache.bedrockAgent = new BedrockAgentClient({ region });
  return _cache.bedrockAgent;
}

export function bedrockAgentRuntimeClient(): BedrockAgentRuntimeClient {
  const { region } = requireAwsConfig();
  ensureRegionCache(region);
  if (!_cache.bedrockAgentRuntime)
    _cache.bedrockAgentRuntime = new BedrockAgentRuntimeClient({ region });
  return _cache.bedrockAgentRuntime;
}

export function verifiedPermissionsClient(): VerifiedPermissionsClient {
  const { region } = requireAwsConfig();
  ensureRegionCache(region);
  if (!_cache.verifiedPermissions)
    _cache.verifiedPermissions = new VerifiedPermissionsClient({ region });
  return _cache.verifiedPermissions;
}
