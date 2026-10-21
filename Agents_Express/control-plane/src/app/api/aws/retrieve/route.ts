import { NextRequest } from "next/server";
import { handle } from "@/lib/aws/http";
import { retrieveFromKnowledgeBase } from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

// Real Bedrock KB Retrieve (read-only semantic query). Requires a KB id and a
// non-empty query; validated in the discovery helper. Does not generate — pure
// retrieval, so it never calls a model or mutates anything.
export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = (await req.json().catch(() => ({}))) as {
      knowledgeBaseId?: string;
      query?: string;
      numberOfResults?: number;
    };
    const results = await retrieveFromKnowledgeBase(
      String(body.knowledgeBaseId ?? ""),
      String(body.query ?? ""),
      typeof body.numberOfResults === "number" ? body.numberOfResults : 5
    );
    return { results };
  });
}
