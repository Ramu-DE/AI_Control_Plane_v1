import { durableSingleton } from "./persist";
import type { GraphSourceRecord } from "./types";

function seedGraphSources(): GraphSourceRecord[] {
  const now = new Date().toISOString();
  return [
    {
      graphSourceId: "contract-iq",
      bu: "market-access",
      displayName: "Contract IQ (Market Access)",
      description:
        "Ontology-mediated access to governed contract data in Unity Catalog.",
      ontology: {
        type: "neptune",
        sparqlUrl: "https://REPLACE-ME-neptune-endpoint:8182/sparql",
        graphUri: "http://example.com/graph/market-access",
        namespace: "http://example.com/ontology/market-access#",
        auth: "sigv4-assume-role",
        region: process.env.AWS_REGION || undefined,
      },
      backend: {
        type: "databricks-uc",
        catalog: "usdev_corp",
        schema: "corp_us_mart",
        registryTable: "usdev_corp.corp_us_mart.omda_ontology_mapping",
        universalJoinKey: "contract_key",
        vectorIndex: "usdev_corp.corp_us_mart.contract_chunk_index",
        vectorEndpoint: "vector_demo",
      },
      llmEndpoint: "databricks-meta-llama-3-3-70b-instruct",
      queryEngineUrl:
        "https://REPLACE-ME-databricks-host/serving-endpoints/contract_iq_omda/invocations",
      tags: { region: "US", sensitivity: "confidential", tier: "pro" },
      version: "1.0.0",
      status: "Approved",
      owner: "market-access",
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// Durable: an approved Graph Source with its credentials wired is exactly the
// state nobody wants to rebuild. Two smoke-test checks skip today for want of
// "an Approved neo4j source" — losing that on every restart is why.
const durable = durableSingleton<GraphSourceRecord[]>({
  cacheKey: "__graphSources",
  fileSuffix: ".graph",
  label: "graph-sources",
  seed: seedGraphSources,
});

export const graphSources = durable.state;
export const flushGraphSources = durable.flush;
