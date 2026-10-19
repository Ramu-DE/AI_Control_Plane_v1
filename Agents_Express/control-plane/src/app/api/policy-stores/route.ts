import { NextResponse } from "next/server";
import { store } from "@/lib/store";

// Policy Stores (Amazon Verified Permissions) are pre-created by the seed;
// this part of the workshop is read/inspect only.
export async function GET() {
  return NextResponse.json({ stores: store.policyStores });
}
