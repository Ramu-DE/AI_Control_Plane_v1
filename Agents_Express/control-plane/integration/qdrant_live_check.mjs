// Live check for the Qdrant RAG path, using the app's own modules.
//
// Runs four stages and reports each independently, so a failure tells you WHICH
// half is broken:
//   1. reachability   — TLS/TCP to the cluster (the usual failure)
//   2. collection     — vector size + point count, compared to the record
//   3. embedding      — a REAL Bedrock call, dimension verified
//   4. retrieval      — the real adapter against the real cluster
//
// Stage 3 is independent of Qdrant, so it still proves the embedding half works
// while a cluster is provisioning.
//
// Run:
//   QDRANT_URL=... QDRANT_API_KEY=... QDRANT_COLLECTION=product_docs \
//   AWS_REGION=us-west-2 node --import ./tests/register.mjs integration/qdrant_live_check.mjs
//
// The API key is read from the environment only and is never printed.

import { QdrantRetriever } from "../src/lib/kb/qdrant.ts";
import { embedQuery, DEFAULT_EMBED_MODEL } from "../src/lib/kb/embed.ts";

const URL_ = process.env.QDRANT_URL;
const KEY = process.env.QDRANT_API_KEY;
const COLLECTION = process.env.QDRANT_COLLECTION || "product_docs";
const QUERY = process.argv[2] || "contract fees for oncology suppliers";
const MODEL = process.env.KB_EMBED_MODEL || DEFAULT_EMBED_MODEL;
const DIM = Number(process.env.KB_EMBED_DIMENSION || 1024);

function head(n) {
  console.log(`\n=== ${n} ===`);
}
let failures = 0;
function fail(stage, e) {
  failures += 1;
  console.log(`  FAIL ${stage}: ${e.message}`);
}

async function main() {
  if (!URL_ || !KEY) {
    console.error("QDRANT_URL and QDRANT_API_KEY must be set");
    process.exit(2);
  }
  console.log(`cluster    : ${URL_}`);
  console.log(`collection : ${COLLECTION}`);
  console.log(`embedding  : ${MODEL} (${DIM} dims)`);

  const retriever = new QdrantRetriever({
    url: URL_,
    collection: COLLECTION,
    apiKey: KEY,
    allowedHosts: ["cloud.qdrant.io"],
  });

  // ---- 1. reachability ----
  head("1. reachability");
  let reachable = false;
  try {
    const res = await fetch(`${URL_.replace(/\/+$/, "")}/collections`, {
      method: "GET",
      headers: { "api-key": KEY, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    console.log(`  GET /collections -> HTTP ${res.status}`);
    if (res.ok) {
      const body = await res.json();
      const names = (body.result?.collections ?? []).map((c) => c.name);
      console.log(`  collections: ${names.length ? names.join(", ") : "(none)"}`);
      reachable = true;
      if (!names.includes(COLLECTION)) {
        console.log(`  NOTE: '${COLLECTION}' does not exist yet — create it and load points.`);
      }
    } else {
      failures += 1;
      console.log(`  FAIL: cluster responded ${res.status} (check the API key)`);
    }
  } catch (e) {
    failures += 1;
    const cause = e.cause?.code ?? e.cause?.message ?? e.message;
    console.log(`  FAIL: ${cause}`);
    console.log("  → TCP may be open while TLS is reset: that is an AWS NLB with no healthy");
    console.log("    targets, i.e. the cluster is still provisioning, suspended, or deleted.");
    console.log("    Check the cluster state at https://cloud.qdrant.io");
  }

  // ---- 2. collection shape ----
  head("2. collection");
  if (!reachable) {
    console.log("  SKIPPED (cluster unreachable)");
  } else {
    try {
      const info = await retriever.describeCollection();
      console.log(`  vector size : ${info.dimension ?? "unknown"}`);
      console.log(`  points      : ${info.pointsCount ?? "unknown"}`);
      if (info.dimension && info.dimension !== DIM) {
        failures += 1;
        console.log(
          `  FAIL: collection is ${info.dimension}-dim but the record declares ${DIM}. ` +
            "Similarity would be meaningless — re-embed or fix knowledgeConfig.embedding.dimension."
        );
      }
      if (info.pointsCount === 0) {
        console.log("  NOTE: collection is empty — retrieval will return 0 passages.");
      }
    } catch (e) {
      fail("collection", e);
    }
  }

  // ---- 3. embedding (independent of Qdrant) ----
  head("3. embedding (real Bedrock call)");
  let vector = null;
  try {
    const { vector: v, info } = await embedQuery(QUERY, { modelId: MODEL, dimension: DIM });
    vector = v;
    console.log(`  model     : ${info.modelId}`);
    console.log(`  dimension : ${info.dimension}`);
    console.log(`  preview   : [${v.slice(0, 3).map((x) => x.toFixed(4)).join(", ")}, …]`);
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    console.log(`  L2 norm   : ${norm.toFixed(4)}`);
  } catch (e) {
    fail("embedding", e);
  }

  // ---- 4. retrieval ----
  head("4. retrieval");
  if (!reachable || !vector) {
    console.log("  SKIPPED (needs a reachable cluster and an embedding)");
  } else {
    try {
      const out = await retriever.retrieveWithVector(vector, { query: QUERY, topK: 5 });
      console.log(`  passages  : ${out.passages.length} in ${out.latencyMs}ms`);
      for (const n of out.notes) console.log(`  note      : ${n}`);
      for (const p of out.passages.slice(0, 3)) {
        console.log(`   [${p.score.toFixed(4)}] ${p.text.slice(0, 90)}`);
        console.log(`             id=${p.id} metadata=${JSON.stringify(p.metadata)}`);
      }
    } catch (e) {
      fail("retrieval", e);
    }
  }

  console.log(failures === 0 ? "\nQDRANT LIVE CHECK PASSED" : `\nQDRANT LIVE CHECK: ${failures} stage(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("UNEXPECTED:", e);
  process.exit(1);
});
