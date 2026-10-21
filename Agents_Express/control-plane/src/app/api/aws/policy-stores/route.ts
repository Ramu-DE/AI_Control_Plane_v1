import { handle } from "@/lib/aws/http";
import { listPolicyStores } from "@/lib/aws/discovery";

export const dynamic = "force-dynamic";

// Live Verified Permissions policy store discovery (read-only).
export async function GET() {
  return handle(async () => {
    const policyStores = await listPolicyStores();
    return { policyStores };
  });
}
