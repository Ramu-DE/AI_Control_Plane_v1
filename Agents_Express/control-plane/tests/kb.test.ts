// Offline tests for the Knowledge Base retrieval path.
//
// The Qdrant adapter takes an injectable `HttpTransport`, so these tests drive
// it against FAITHFUL Qdrant wire shapes with no network: the modern
// `/points/query` response ({result:{points:[…]}}), the legacy `/points/search`
// response ({result:[…]}), auth failures, and 404 fallback.
//
// Covers: SSRF enforcement, descriptor-driven field mapping, filter
// translation, dimension pre-flight, credential resolution (reference only),
// two-stage Cedar authorization, and the record lifecycle gate.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QdrantRetriever,
  buildFilter,
  describeNetworkError,
  extractPoints,
  normalizePoint,
  resolveTextField,
  TEXT_FIELD_CANDIDATES,
} from "../src/lib/kb/qdrant.ts";
import { resolveApiKey } from "../src/lib/kb/secrets.ts";
import {
  KB_ACTION,
  KB_PERIMETER_TOOL,
  authorizeRetrieval,
  recordScopedPolicyExists,
  recordScopedTool,
  resolveKbRecord,
} from "../src/lib/kb/service.ts";
import { KbConfigError, KbTransportError } from "../src/lib/kb/types.ts";
import type { HttpTransport } from "../src/lib/kb/types.ts";
import type { KnowledgeConfig } from "../src/lib/types.ts";
import { store } from "../src/lib/store.ts";

const URL_OK = "https://abc123.sa-east-1-0.aws.cloud.qdrant.io";

/** A transport that records calls and replays canned responses. */
function fakeTransport(
  responses: Array<{ status: number; body: unknown }>
): { transport: HttpTransport; calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string> }> = [];
  let i = 0;
  const transport: HttpTransport = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers,
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)),
    };
  };
  return { transport, calls };
}

function retriever(
  responses: Array<{ status: number; body: unknown }>,
  cfg: Partial<ConstructorParameters<typeof QdrantRetriever>[0]> = {}
) {
  const { transport, calls } = fakeTransport(responses);
  const r = new QdrantRetriever({
    url: URL_OK,
    collection: "product_docs",
    apiKey: "test-key",
    allowedHosts: ["cloud.qdrant.io"],
    transport,
    ...cfg,
  });
  return { r, calls };
}

// --------------------------------------------------------------------------- //
// Construction + SSRF
// --------------------------------------------------------------------------- //

test("qdrant: rejects non-https, private, metadata and placeholder URLs", () => {
  for (const url of [
    "http://abc.cloud.qdrant.io",
    "https://127.0.0.1:6333",
    "https://169.254.169.254",
    "https://10.0.0.5",
    "https://REPLACE-ME.cloud.qdrant.io",
  ]) {
    assert.throws(
      () => new QdrantRetriever({ url, collection: "c", apiKey: "k" }),
      KbConfigError,
      `should reject ${url}`
    );
  }
});

test("qdrant: enforces the allowlist when one is configured", () => {
  assert.throws(
    () =>
      new QdrantRetriever({
        url: URL_OK,
        collection: "c",
        apiKey: "k",
        allowedHosts: ["example.com"],
      }),
    KbConfigError
  );
  // matching suffix is accepted
  assert.ok(
    new QdrantRetriever({
      url: URL_OK,
      collection: "c",
      apiKey: "k",
      allowedHosts: ["cloud.qdrant.io"],
    })
  );
});

test("qdrant: requires url, collection and a resolved key", () => {
  assert.throws(() => new QdrantRetriever({ url: "", collection: "c", apiKey: "k" }), KbConfigError);
  assert.throws(() => new QdrantRetriever({ url: URL_OK, collection: "", apiKey: "k" }), KbConfigError);
  assert.throws(() => new QdrantRetriever({ url: URL_OK, collection: "c", apiKey: "" }), KbConfigError);
});

// --------------------------------------------------------------------------- //
// Modern Query API
// --------------------------------------------------------------------------- //

const QUERY_RESPONSE = {
  result: {
    points: [
      { id: 1, score: 0.91, payload: { text: "Qdrant stores vectors.", doc: "a.pdf", page: 3 } },
      { id: 2, score: 0.77, payload: { text: "Collections hold points.", doc: "b.pdf" } },
    ],
  },
  status: "ok",
  time: 0.004,
};

test("qdrant: queries /points/query and normalizes passages", async () => {
  const { r, calls } = retriever([{ status: 200, body: QUERY_RESPONSE }]);
  const out = await r.retrieveWithVector([0.1, 0.2, 0.3], { query: "vectors", topK: 2 });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/collections\/product_docs\/points\/query$/);
  assert.equal(calls[0].method, "POST");
  const sent = calls[0].body as Record<string, unknown>;
  assert.deepEqual(sent.query, [0.1, 0.2, 0.3]);
  assert.equal(sent.limit, 2);
  assert.equal(sent.with_payload, true);

  assert.equal(out.provider, "Qdrant");
  assert.equal(out.target, "product_docs");
  assert.equal(out.passages.length, 2);
  assert.equal(out.passages[0].id, "1");
  assert.equal(out.passages[0].text, "Qdrant stores vectors.");
  assert.equal(out.passages[0].score, 0.91);
  assert.equal(out.passages[0].source, "qdrant:product_docs");
  // text field is excluded from metadata; everything else passes through
  assert.deepEqual(out.passages[0].metadata, { doc: "a.pdf", page: 3 });
});

test("qdrant: sends the api-key header and never the key in the body", async () => {
  const { r, calls } = retriever([{ status: 200, body: QUERY_RESPONSE }]);
  await r.retrieveWithVector([0.1], { query: "q", topK: 1 });
  assert.equal(calls[0].headers["api-key"], "test-key");
  assert.equal(JSON.stringify(calls[0].body).includes("test-key"), false);
});

test("qdrant: clamps topK into [1,100]", async () => {
  const { r, calls } = retriever([{ status: 200, body: QUERY_RESPONSE }]);
  await r.retrieveWithVector([0.1], { query: "q", topK: 10_000 });
  assert.equal((calls[0].body as Record<string, unknown>).limit, 100);
});

test("qdrant: passes score_threshold and named vector when set", async () => {
  const { r, calls } = retriever([{ status: 200, body: QUERY_RESPONSE }], {
    vectorName: "dense",
  });
  await r.retrieveWithVector([0.1], { query: "q", topK: 3, scoreThreshold: 0.5 });
  const sent = calls[0].body as Record<string, unknown>;
  assert.equal(sent.score_threshold, 0.5);
  assert.equal(sent.using, "dense");
});

// --------------------------------------------------------------------------- //
// Legacy fallback + errors
// --------------------------------------------------------------------------- //

test("qdrant: falls back to /points/search on 404 and notes it", async () => {
  const { r, calls } = retriever([
    { status: 404, body: { status: { error: "Not found" } } },
    { status: 200, body: { result: [{ id: "x1", score: 0.6, payload: { text: "legacy hit" } }] } },
  ]);
  const out = await r.retrieveWithVector([0.1], { query: "q", topK: 1 });
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/points\/search$/);
  // legacy endpoint uses `vector`, not `query`
  assert.deepEqual((calls[1].body as Record<string, unknown>).vector, [0.1]);
  assert.equal(out.passages[0].text, "legacy hit");
  assert.ok(out.notes.some((n) => n.includes("/points/search")));
});

test("qdrant: named vector uses the legacy {name,vector} shape on fallback", async () => {
  const { r, calls } = retriever(
    [
      { status: 404, body: {} },
      { status: 200, body: { result: [] } },
    ],
    { vectorName: "dense" }
  );
  await r.retrieveWithVector([0.1], { query: "q", topK: 1 });
  assert.deepEqual((calls[1].body as Record<string, unknown>).vector, {
    name: "dense",
    vector: [0.1],
  });
});

test("qdrant: 404 from BOTH endpoints is a clear missing-collection error", async () => {
  const { r } = retriever([
    { status: 404, body: {} },
    { status: 404, body: {} },
  ]);
  await assert.rejects(
    () => r.retrieveWithVector([0.1], { query: "q", topK: 1 }),
    (e: Error) => e instanceof KbTransportError && /not found/i.test(e.message)
  );
});

test("qdrant: 401/403 reports a credential problem, not an empty result", async () => {
  for (const status of [401, 403]) {
    const { r } = retriever([{ status, body: { status: { error: "Unauthorized" } } }]);
    await assert.rejects(
      () => r.retrieveWithVector([0.1], { query: "q", topK: 1 }),
      (e: Error) => e instanceof KbTransportError && /API key/i.test(e.message)
    );
  }
});

test("qdrant: a 5xx surfaces as a transport error", async () => {
  const { r } = retriever([{ status: 500, body: "upstream boom" }]);
  await assert.rejects(
    () => r.retrieveWithVector([0.1], { query: "q", topK: 1 }),
    KbTransportError
  );
});

test("qdrant: non-JSON response is reported honestly", () => {
  assert.throws(() => extractPoints("<html>nope</html>"), KbTransportError);
});

test("qdrant: an opaque 'fetch failed' is unwrapped into an actionable message", () => {
  // Node hides the real reason in error.cause; a bare "fetch failed" makes a
  // down cluster indistinguishable from a typo'd URL.
  const reset = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  });
  const msg = describeNetworkError(reset, URL_OK);
  assert.match(msg, /ECONNRESET/);
  assert.match(msg, /not running yet|provisioning|middlebox/);
  assert.match(msg, new RegExp(URL_OK.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(
    describeNetworkError(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      }),
      URL_OK
    ),
    /DNS did not resolve/
  );
  assert.match(
    describeNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" }), URL_OK),
    /timed out/
  );
});

test("qdrant: a transport throw during the call becomes KbTransportError", async () => {
  const boom: HttpTransport = async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
  };
  const r = new QdrantRetriever({
    url: URL_OK,
    collection: "c",
    apiKey: "k",
    allowedHosts: ["cloud.qdrant.io"],
    transport: boom,
  });
  await assert.rejects(
    () => r.retrieveWithVector([0.1], { query: "q", topK: 1 }),
    (e: Error) => e instanceof KbTransportError && /ECONNRESET/.test(e.message)
  );
});

// --------------------------------------------------------------------------- //
// Dimension pre-flight — the top cause of silent empty RAG
// --------------------------------------------------------------------------- //

test("qdrant: refuses a vector whose size differs from the collection", async () => {
  const { r } = retriever([{ status: 200, body: QUERY_RESPONSE }], { dimension: 1024 });
  await assert.rejects(
    () => r.retrieveWithVector([0.1, 0.2], { query: "q", topK: 1 }),
    (e: Error) => e instanceof KbConfigError && /dimensions but collection/.test(e.message)
  );
});

test("qdrant: rejects an empty query vector", async () => {
  const { r } = retriever([{ status: 200, body: QUERY_RESPONSE }]);
  await assert.rejects(() => r.retrieveWithVector([], { query: "q", topK: 1 }), KbConfigError);
});

test("qdrant: describeCollection reads the vector size and point count", async () => {
  const { r } = retriever([
    {
      status: 200,
      body: { result: { config: { params: { vectors: { size: 1024, distance: "Cosine" } } }, points_count: 42 } },
    },
  ]);
  assert.deepEqual(await r.describeCollection(), { dimension: 1024, pointsCount: 42 });
});

// --------------------------------------------------------------------------- //
// Descriptor-driven field mapping
// --------------------------------------------------------------------------- //

test("mapping: configured textField wins over the probe candidates", () => {
  const { field, probed } = resolveTextField({ text: "a", body: "b" }, "body");
  assert.equal(field, "body");
  assert.equal(probed, false);
});

test("mapping: probes conventional keys when nothing is configured", () => {
  assert.equal(resolveTextField({ page_content: "x" }).field, "page_content");
  assert.equal(resolveTextField({ chunk: "x" }).field, "chunk");
  assert.equal(resolveTextField({ nothing_useful: 1 }).field, null);
  assert.ok(TEXT_FIELD_CANDIDATES.includes("text"));
});

test("mapping: idField and metadataFields are honoured", () => {
  const { passage } = normalizePoint(
    { id: 7, score: 0.5, payload: { body: "hello", sku: "S-1", secretish: "drop me" } },
    { textField: "body", idField: "sku", metadataFields: ["sku"] },
    "c"
  );
  assert.equal(passage?.id, "S-1");
  assert.equal(passage?.text, "hello");
  assert.deepEqual(passage?.metadata, { sku: "S-1" });
});

test("mapping: a point with no readable text is dropped and reported", async () => {
  const { r } = retriever([
    {
      status: 200,
      body: { result: { points: [{ id: 1, score: 0.9, payload: { irrelevant: 5 } }] } },
    },
  ]);
  const out = await r.retrieveWithVector([0.1], { query: "q", topK: 1 });
  assert.equal(out.passages.length, 0);
  assert.ok(out.notes.some((n) => /no readable text field/.test(n)));
});

test("filters: equality map becomes a Qdrant must-clause", () => {
  assert.deepEqual(buildFilter({ doc: "a.pdf", page: 2 }), {
    must: [
      { key: "doc", match: { value: "a.pdf" } },
      { key: "page", match: { value: 2 } },
    ],
  });
  assert.equal(buildFilter(undefined), undefined);
  assert.equal(buildFilter({}), undefined);
  assert.equal(buildFilter({ a: undefined }), undefined);
});

// --------------------------------------------------------------------------- //
// Credential resolution — references only
// --------------------------------------------------------------------------- //

function kbConfig(over: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
  return {
    provider: "Qdrant",
    connection: { qdrantUrl: URL_OK, qdrantCollection: "product_docs" },
    retrieval: { topK: 5, scoreThreshold: 0.4, mode: "hybrid", citations: true },
    ...over,
  };
}

test("secrets: resolves from the record's env var reference", async () => {
  const name = "KB_TEST_KEY_" + Math.random().toString(36).slice(2, 8);
  process.env[name] = "resolved-value";
  try {
    const key = await resolveApiKey("Qdrant", kbConfig({ auth: { apiKeyEnvVar: name } }));
    assert.equal(key, "resolved-value");
  } finally {
    delete process.env[name];
  }
});

test("secrets: a named env var that is unset fails loudly", async () => {
  await assert.rejects(
    () => resolveApiKey("Qdrant", kbConfig({ auth: { apiKeyEnvVar: "KB_DEFINITELY_UNSET_VAR" } })),
    (e: Error) => e instanceof KbConfigError && /is not set/.test(e.message)
  );
});

test("secrets: falls back to the provider-conventional env var", async () => {
  const prev = process.env.QDRANT_API_KEY;
  process.env.QDRANT_API_KEY = "fallback-value";
  try {
    assert.equal(await resolveApiKey("Qdrant", kbConfig()), "fallback-value");
  } finally {
    if (prev === undefined) delete process.env.QDRANT_API_KEY;
    else process.env.QDRANT_API_KEY = prev;
  }
});

test("secrets: with no reference at all, the error names what to configure", async () => {
  const prev = process.env.QDRANT_API_KEY;
  delete process.env.QDRANT_API_KEY;
  try {
    await assert.rejects(
      () => resolveApiKey("Qdrant", kbConfig()),
      (e: Error) =>
        e instanceof KbConfigError &&
        /apiKeyEnvVar/.test(e.message) &&
        /apiKeySecretRef/.test(e.message) &&
        /QDRANT_API_KEY/.test(e.message)
    );
  } finally {
    if (prev !== undefined) process.env.QDRANT_API_KEY = prev;
  }
});

// --------------------------------------------------------------------------- //
// Governance: lifecycle gate + two-stage Cedar
// --------------------------------------------------------------------------- //

test("record gate: only an Approved Knowledge Base resolves", () => {
  // Seeded: rec-kb-bedrock-policies is Approved, rec-kb-databricks-clinical is Draft.
  const approved = resolveKbRecord("rec-kb-bedrock-policies");
  assert.equal(approved.record.type, "Knowledge Base");
  assert.equal(approved.record.status, "Approved");

  assert.throws(() => resolveKbRecord("rec-kb-databricks-clinical"), (e: Error) =>
    e instanceof KbConfigError && /only an Approved/.test(e.message)
  );
  // A non-KB record is refused even though it is Approved.
  assert.throws(() => resolveKbRecord("rec-expense-tool"), (e: Error) =>
    e instanceof KbConfigError && /not 'Knowledge Base'/.test(e.message)
  );
  assert.throws(() => resolveKbRecord("nope"), (e: Error) => e.name === "KbNotFoundError");
});

test("authz: perimeter permits a seeded persona, stage 2 not evaluated by default", () => {
  assert.equal(KB_ACTION, "queryKnowledgeBase");
  assert.equal(KB_PERIMETER_TOOL, "kb");
  assert.equal(recordScopedPolicyExists(store.policies, "rec-kb-bedrock-policies"), false);

  const a = authorizeRetrieval("rec-kb-bedrock-policies", "persona-john");
  assert.equal(a.perimeter.allowed, true);
  assert.equal(a.perimeter.matchedPolicyId, "pol-gw-kb-perimeter");
  assert.equal(a.recordScoped.evaluated, false);
  assert.equal(a.allowed, true);
});

test("authz: a record-scoped policy becomes authoritative and can deny", () => {
  const recordId = "rec-kb-bedrock-policies";
  store.policies.unshift({
    id: "pol-test-kb-scoped",
    name: "Test: only directors may query this KB",
    layer: "gateway",
    description: "test-only",
    enabled: true,
    createdAt: new Date().toISOString(),
    cedar: `permit(
  principal,
  action == Action::"queryKnowledgeBase",
  resource == Tool::"${recordScopedTool(recordId)}"
) when { principal.role == "director" };`,
  });
  try {
    assert.equal(recordScopedPolicyExists(store.policies, recordId), true);

    // Manager: perimeter ok, record-scoped denies.
    const mgr = authorizeRetrieval(recordId, "persona-john");
    assert.equal(mgr.perimeter.allowed, true);
    assert.equal(mgr.recordScoped.evaluated, true);
    assert.equal(mgr.allowed, false);

    // Director: both stages allow.
    const dir = authorizeRetrieval(recordId, "persona-mary");
    assert.equal(dir.allowed, true);
    assert.equal(dir.recordScoped.evaluated, true);
  } finally {
    store.policies = store.policies.filter((p) => p.id !== "pol-test-kb-scoped");
  }
});

test("authz: an unknown persona is denied and stage 2 is skipped", () => {
  const a = authorizeRetrieval("rec-kb-bedrock-policies", "persona-nope");
  assert.equal(a.allowed, false);
  assert.equal(a.recordScoped.evaluated, false);
});

// --------------------------------------------------------------------------- //
// Offline guarantee
// --------------------------------------------------------------------------- //

test("kb modules: only the adapter/embed layers may reach the network", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "lib", "kb");
  // types.ts holds the default fetch transport; qdrant.ts uses the injected one.
  const allowed = new Set(["types.ts", "qdrant.ts"]);
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    if (!allowed.has(f)) {
      assert.ok(!/\bfetch\s*\(/.test(src), `${f} must not call fetch() directly`);
    }
  }
});
