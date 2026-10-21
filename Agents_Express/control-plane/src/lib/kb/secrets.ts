// Credential resolution for Knowledge Base providers.
//
// A registry record NEVER stores a key — only a reference. This module turns a
// reference into a value, server-side, at retrieval time, and returns it only
// to the adapter that is about to make the call. Nothing here is logged, echoed
// in an API response, or written back onto the record.
//
// Resolution order (first hit wins):
//   1. auth.apiKeyEnvVar      — explicit per-record env var (best for local dev)
//   2. auth.apiKeySecretRef   — AWS Secrets Manager (production)
//   3. <PROVIDER>_API_KEY     — conventional platform-wide fallback
//
// The Secrets Manager client is created lazily so this module imports cleanly
// (and makes no network call) in local mode and in tests.

import { KbConfigError } from "./types";
import type { KnowledgeConfig } from "../types";

/** Conventional fallback env var per provider. */
function fallbackEnvVar(provider: string): string {
  if (provider === "Qdrant") return "QDRANT_API_KEY";
  if (provider === "MongoDB Atlas Vector Search") return "MONGODB_API_KEY";
  if (provider === "OpenSearch") return "OPENSEARCH_API_KEY";
  return "KB_API_KEY";
}

let _client: unknown;

async function secretsClient() {
  if (!_client) {
    const region =
      (process.env.AWS_REGION || "").trim() ||
      (process.env.AWS_DEFAULT_REGION || "").trim();
    if (!region) {
      throw new KbConfigError(
        "resolving a Secrets Manager reference requires AWS_REGION or AWS_DEFAULT_REGION"
      );
    }
    // Lazy import: keeps this module free of AWS at import time.
    const { SecretsManagerClient } = await import("@aws-sdk/client-secrets-manager");
    // No explicit credentials — the SDK default provider chain only.
    _client = new SecretsManagerClient({ region });
  }
  return _client as import("@aws-sdk/client-secrets-manager").SecretsManagerClient;
}

/**
 * Read a secret from Secrets Manager. A JSON payload is unwrapped using
 * `jsonKey` (default "apiKey"); a plain-string secret is returned as-is.
 */
export async function readSecret(ref: string, jsonKey = "apiKey"): Promise<string> {
  const { GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = await secretsClient();
  let raw: string | undefined;
  try {
    const res = await client.send(new GetSecretValueCommand({ SecretId: ref }));
    raw = res.SecretString;
  } catch (e) {
    // Surface the SDK error NAME only — never the payload.
    const name = (e as { name?: string }).name ?? "Error";
    throw new KbConfigError(
      `could not read Secrets Manager reference '${ref}' (${name})`
    );
  }
  if (!raw) {
    throw new KbConfigError(`Secrets Manager reference '${ref}' has no string value`);
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const value = parsed[jsonKey];
      if (typeof value === "string" && value) return value;
      throw new KbConfigError(
        `Secrets Manager reference '${ref}' JSON has no string key '${jsonKey}'`
      );
    } catch (e) {
      if (e instanceof KbConfigError) throw e;
      throw new KbConfigError(`Secrets Manager reference '${ref}' is not valid JSON`);
    }
  }
  return trimmed;
}

/**
 * Resolve the provider API key for a Knowledge Base record.
 *
 * Throws KbConfigError when no reference resolves, so a misconfiguration is an
 * explicit failure rather than an unauthenticated call.
 */
export async function resolveApiKey(
  provider: string,
  config: KnowledgeConfig
): Promise<string> {
  const auth = config.auth ?? {};

  if (auth.apiKeyEnvVar) {
    const value = process.env[auth.apiKeyEnvVar];
    if (value) return value;
    throw new KbConfigError(
      `auth.apiKeyEnvVar '${auth.apiKeyEnvVar}' is not set in the server environment`
    );
  }

  if (auth.apiKeySecretRef) {
    return readSecret(auth.apiKeySecretRef, auth.secretJsonKey ?? "apiKey");
  }

  const fallback = fallbackEnvVar(provider);
  const value = process.env[fallback];
  if (value) return value;

  throw new KbConfigError(
    `no credential reference for provider '${provider}'. Set knowledgeConfig.auth.apiKeyEnvVar ` +
      `or auth.apiKeySecretRef on the record, or provide ${fallback} in the server environment.`
  );
}

/** Test hook — drops the cached client so a region change is picked up. */
export function __resetSecretsClient(): void {
  _client = undefined;
}
