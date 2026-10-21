import { handle } from "@/lib/aws/http";
import { listKnowledgeBases } from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

// Live Bedrock Knowledge Base discovery. Returns an honest empty list when the
// account has none; access-denied / errors are mapped by `handle`.
export async function GET() {
  return handle(async () => {
    const knowledgeBases = await listKnowledgeBases();
    return { knowledgeBases };
  });
}
