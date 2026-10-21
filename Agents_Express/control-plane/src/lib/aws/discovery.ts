// Real-AWS discovery + authorization operations (server-only).
//
// Every function here performs ONLY read / describe / list / authorization-check
// calls — no create/update/delete. All go through the client factories in
// ./config, which use the SDK default credential provider chain (no creds in
// code) and strict region resolution. Errors are classified honestly so the
// API layer can report empty vs access-denied vs error without guessing.

import { GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  ListKnowledgeBasesCommand,
  ListAgentsCommand,
} from "@aws-sdk/client-bedrock-agent";
import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import {
  ListPolicyStoresCommand,
  IsAuthorizedCommand,
} from "@aws-sdk/client-verifiedpermissions";

import {
  bedrockAgentClient,
  bedrockAgentRuntimeClient,
  stsClient,
  verifiedPermissionsClient,
} from "./config";
import {
  AuthorizationResult,
  BedrockAgentSummary,
  KnowledgeBaseSummary,
  PolicyStoreSummary,
  RetrievalResult,
  normalizeAgents,
  normalizeAuthorization,
  normalizeKnowledgeBases,
  normalizePolicyStores,
  normalizeRetrievalResults,
} from "./normalize";

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

/** STS GetCallerIdentity — proves the credential chain resolves and who we are. */
export async function getCallerIdentity(): Promise<CallerIdentity> {
  const res = await stsClient().send(new GetCallerIdentityCommand({}));
  return {
    account: res.Account ?? "",
    arn: res.Arn ?? "",
    userId: res.UserId ?? "",
  };
}

/** Live Bedrock Knowledge Base discovery (paginated, capped). */
export async function listKnowledgeBases(
  max = 100
): Promise<KnowledgeBaseSummary[]> {
  const client = bedrockAgentClient();
  const out: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListKnowledgeBasesCommand({ maxResults: 50, nextToken })
    );
    for (const s of res.knowledgeBaseSummaries ?? [])
      out.push(s as unknown as Record<string, unknown>);
    nextToken = res.nextToken;
  } while (nextToken && out.length < max);
  return normalizeKnowledgeBases(out).slice(0, max);
}

/** Live Bedrock agent discovery (paginated, capped). */
export async function listBedrockAgents(
  max = 100
): Promise<BedrockAgentSummary[]> {
  const client = bedrockAgentClient();
  const out: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListAgentsCommand({ maxResults: 50, nextToken })
    );
    for (const s of res.agentSummaries ?? [])
      out.push(s as unknown as Record<string, unknown>);
    nextToken = res.nextToken;
  } while (nextToken && out.length < max);
  return normalizeAgents(out).slice(0, max);
}

/** Live Verified Permissions policy store discovery (paginated, capped). */
export async function listPolicyStores(
  max = 100
): Promise<PolicyStoreSummary[]> {
  const client = verifiedPermissionsClient();
  const out: Record<string, unknown>[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new ListPolicyStoresCommand({ maxResults: 50, nextToken })
    );
    for (const s of res.policyStores ?? [])
      out.push(s as unknown as Record<string, unknown>);
    nextToken = res.nextToken;
  } while (nextToken && out.length < max);
  return normalizePolicyStores(out).slice(0, max);
}

/** Real Bedrock KB Retrieve — read-only semantic retrieval against a KB. */
export async function retrieveFromKnowledgeBase(
  knowledgeBaseId: string,
  query: string,
  numberOfResults = 5
): Promise<RetrievalResult[]> {
  if (!knowledgeBaseId) throw new Error("knowledgeBaseId is required");
  if (!query || !query.trim()) throw new Error("query is required");
  const res = await bedrockAgentRuntimeClient().send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: Math.min(Math.max(numberOfResults, 1), 25),
        },
      },
    })
  );
  return normalizeRetrievalResults(
    (res.retrievalResults ?? []) as unknown as Record<string, unknown>[]
  );
}

export interface IsAuthorizedInput {
  policyStoreId: string;
  principalType: string;
  principalId: string;
  actionType: string;
  actionId: string;
  resourceType: string;
  resourceId: string;
}

/**
 * AVP IsAuthorized adapter with minimal, validated identifiers. This is a
 * read-only authorization *check* — it does not create or mutate any policy or
 * resource. Entity types/ids are validated non-empty before the call.
 */
export async function isAuthorized(
  input: IsAuthorizedInput
): Promise<AuthorizationResult> {
  const required: [keyof IsAuthorizedInput, string][] = [
    ["policyStoreId", input.policyStoreId],
    ["principalType", input.principalType],
    ["principalId", input.principalId],
    ["actionType", input.actionType],
    ["actionId", input.actionId],
    ["resourceType", input.resourceType],
    ["resourceId", input.resourceId],
  ];
  for (const [field, value] of required) {
    if (!value || !String(value).trim()) {
      throw new Error(`${field} is required`);
    }
  }
  const res = await verifiedPermissionsClient().send(
    new IsAuthorizedCommand({
      policyStoreId: input.policyStoreId,
      principal: {
        entityType: input.principalType,
        entityId: input.principalId,
      },
      action: { actionType: input.actionType, actionId: input.actionId },
      resource: { entityType: input.resourceType, entityId: input.resourceId },
    })
  );
  return normalizeAuthorization(res as unknown as Record<string, unknown>);
}
