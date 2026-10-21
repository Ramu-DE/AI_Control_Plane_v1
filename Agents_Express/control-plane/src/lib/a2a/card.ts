// Agent Card discovery — fetch and normalize a peer's published capabilities.
//
// `normalizeCard` is PURE (no I/O) and is the trust boundary: a card arrives
// from an external agent, so every field is validated, coerced, clamped, and
// copied onto a known shape. Unrecognized fields are dropped — never spread
// into our types — so a hostile card cannot inject content into the UI or audit.
//
// `fetchCard` performs the only network call, and only after the SSRF policy in
// lib/graph/logic.ts has approved the URL.

import { validateOutboundUrl } from "../graph/logic";
import { A2AConfigError, A2ATransportError } from "./types";
import type { A2AAgentCard, A2ASkill } from "./types";

/**
 * Well-known paths, newest spec first. The A2A spec moved the card from
 * `agent.json` to `agent-card.json`; we try both so peers on either version
 * are discoverable.
 */
export const WELL_KNOWN_PATHS = [
  "/.well-known/agent-card.json",
  "/.well-known/agent.json",
] as const;

const MAX_SKILLS = 50;
const MAX_TEXT = 2_000;
const MAX_CARD_BYTES = 256 * 1024;

type AnyRecord = Record<string, unknown>;

function str(v: unknown, fallback = ""): string {
  if (typeof v !== "string") return fallback;
  return v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v;
}

function bool(v: unknown): boolean {
  return v === true;
}

function strArray(v: unknown, cap = 20): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string").slice(0, cap);
}

/** Join an endpoint and a well-known path without producing a double slash. */
export function wellKnownUrl(endpoint: string, path: string): string {
  return `${endpoint.replace(/\/+$/, "")}${path}`;
}

function normalizeSkills(v: unknown): A2ASkill[] {
  if (!Array.isArray(v)) return [];
  const out: A2ASkill[] = [];
  for (const raw of v.slice(0, MAX_SKILLS)) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as AnyRecord;
    const id = str(s.id);
    if (!id) continue; // a skill with no id is not addressable — drop it
    out.push({
      id,
      name: str(s.name, id),
      description: str(s.description),
      tags: strArray(s.tags, 10),
    });
  }
  return out;
}

/**
 * Normalize a raw Agent Card document onto our internal shape.
 *
 * Accepts both the camelCase wire form (`defaultInputModes`) and the snake_case
 * form some SDK versions emit (`default_input_modes`), because peers in the wild
 * use both.
 */
export function normalizeCard(
  raw: unknown,
  fetchedFrom: string,
  now: Date = new Date()
): A2AAgentCard {
  if (!raw || typeof raw !== "object") {
    throw new A2ATransportError("Agent Card is not a JSON object");
  }
  const c = raw as AnyRecord;
  const caps = (c.capabilities && typeof c.capabilities === "object"
    ? c.capabilities
    : {}) as AnyRecord;

  const name = str(c.name);
  if (!name) {
    throw new A2ATransportError("Agent Card is missing the required 'name' field");
  }

  return {
    name,
    description: str(c.description),
    url: str(c.url),
    version: str(c.version, "unknown"),
    capabilities: {
      streaming: bool(caps.streaming),
      pushNotifications: bool(caps.pushNotifications ?? caps.push_notifications),
    },
    skills: normalizeSkills(c.skills),
    defaultInputModes: strArray(c.defaultInputModes ?? c.default_input_modes),
    defaultOutputModes: strArray(c.defaultOutputModes ?? c.default_output_modes),
    fetchedFrom,
    fetchedAt: now.toISOString(),
  };
}

export interface FetchCardResult {
  card: A2AAgentCard;
  /** Which well-known path answered. */
  path: string;
}

/**
 * Fetch and normalize a peer's Agent Card.
 *
 * The endpoint must pass the shared SSRF policy (HTTPS, not private/loopback/
 * metadata, and present in `allowedHosts` when one is configured) before any
 * request is made. Each candidate path is tried in order; the first valid card
 * wins. Responses are size-capped.
 */
export async function fetchCard(
  endpoint: string,
  allowedHosts: string[] | undefined,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {}
): Promise<FetchCardResult> {
  const policy = validateOutboundUrl(endpoint, allowedHosts);
  if (!policy.ok) {
    throw new A2AConfigError(
      policy.placeholder
        ? "peer endpoint is a placeholder — configure it before discovery"
        : `peer endpoint rejected: ${policy.reason}`
    );
  }

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 1_000), 30_000);
  const failures: string[] = [];

  for (const path of WELL_KNOWN_PATHS) {
    const url = wellKnownUrl(endpoint, path);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json", ...(opts.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      if (!res.ok) {
        failures.push(`${path} -> HTTP ${res.status}`);
        continue;
      }
      const text = (await res.text()).slice(0, MAX_CARD_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        failures.push(`${path} -> response was not valid JSON`);
        continue;
      }
      return { card: normalizeCard(parsed, url), path };
    } catch (e) {
      failures.push(`${path} -> ${(e as Error).message}`);
    }
  }

  throw new A2ATransportError(
    `could not retrieve an Agent Card from ${endpoint} (${failures.join("; ")})`
  );
}
