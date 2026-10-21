// Inbound authentication simulation — "who is calling the agent/gateway?"
//
//  - IAM SigV4: verify the caller principal ARN matches a configured pattern.
//    (OFFLINE: we do NOT verify a real SigV4 signature; we match the asserted
//    principal against the allowed pattern — a config/validation simulation.)
//  - OIDC JWT: validate issuer, audience, required scopes, and expiry on a
//    SIMULATED decoded token. We NEVER verify a cryptographic signature and we
//    never fetch JWKS; the token is unsigned and marked SIMULATED.
//
// Pure, deterministic, no I/O.

import type {
  InboundAuthConfig,
  InboundValidationResult,
  SimulatedDecodedJwt,
} from "./types";
import { globMatch } from "./util";

/** Simulate inbound IAM SigV4: match the asserted principal ARN to the pattern. */
export function simulateSigV4(
  principalArn: string,
  pattern: string
): InboundValidationResult {
  const reasons: string[] = [];
  const trimmed = (principalArn || "").trim();
  if (!trimmed) {
    reasons.push("no principal ARN presented");
  } else if (!trimmed.startsWith("arn:aws:")) {
    reasons.push("principal is not an AWS ARN");
  } else if (!globMatch(pattern, trimmed)) {
    reasons.push(`principal ARN '${trimmed}' does not match allowed pattern '${pattern}'`);
  }
  const valid = reasons.length === 0;
  return {
    kind: "sigv4",
    valid,
    reasons: valid ? ["principal ARN matched the allowed pattern (signature check simulated)"] : reasons,
    principal: valid ? trimmed : undefined,
  };
}

function tokenScopes(t: SimulatedDecodedJwt): string[] {
  if (Array.isArray(t.scopes)) return t.scopes;
  if (typeof t.scope === "string") return t.scope.split(/\s+/).filter(Boolean);
  return [];
}

/** Validate a SIMULATED decoded OIDC JWT against the inbound config. */
export function validateOidcJwt(
  decoded: SimulatedDecodedJwt,
  cfg: Extract<InboundAuthConfig, { kind: "oidc" }>,
  now: Date = new Date()
): InboundValidationResult {
  const reasons: string[] = [];

  if (decoded.iss !== cfg.issuer) {
    reasons.push(`issuer mismatch: expected '${cfg.issuer}', got '${decoded.iss}'`);
  }

  const auds = Array.isArray(decoded.aud) ? decoded.aud : [decoded.aud];
  if (!auds.includes(cfg.audience)) {
    reasons.push(`audience mismatch: expected '${cfg.audience}', got '${auds.join(",")}'`);
  }

  const present = new Set(tokenScopes(decoded));
  const missing = cfg.requiredScopes.filter((s) => !present.has(s));
  if (missing.length > 0) {
    reasons.push(`missing required scope(s): ${missing.join(", ")}`);
  }

  const nowSec = Math.floor(now.getTime() / 1000);
  if (typeof decoded.exp === "number" && decoded.exp <= nowSec) {
    reasons.push("token expired (exp)");
  }
  if (typeof decoded.nbf === "number" && decoded.nbf > nowSec) {
    reasons.push("token not yet valid (nbf)");
  }

  const valid = reasons.length === 0;
  return {
    kind: "oidc",
    valid,
    reasons: valid
      ? ["issuer, audience, scopes and expiry validated (signature verification simulated)"]
      : reasons,
    principal: valid ? decoded.sub : undefined,
  };
}

/** Dispatch on the configured inbound kind. */
export function validateInbound(
  cfg: InboundAuthConfig,
  presented: { principalArn?: string; jwt?: SimulatedDecodedJwt },
  now: Date = new Date()
): InboundValidationResult {
  if (cfg.kind === "sigv4") {
    return simulateSigV4(presented.principalArn ?? "", cfg.principalArnPattern);
  }
  if (!presented.jwt) {
    return { kind: "oidc", valid: false, reasons: ["no JWT presented"] };
  }
  return validateOidcJwt(presented.jwt, cfg, now);
}
