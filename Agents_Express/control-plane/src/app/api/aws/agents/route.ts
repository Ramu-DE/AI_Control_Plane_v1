import { handle } from "@/lib/aws/http";
import { listBedrockAgents } from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

// Live Bedrock agent discovery (read-only). Honest empty list when none exist.
export async function GET() {
  return handle(async () => {
    const agents = await listBedrockAgents();
    return { agents };
  });
}
