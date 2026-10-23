import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/store";
import { filterAuditForTenant, usageByTenant } from "@/lib/tenancy";

/**
 * GET /api/audit                       every event (platform admin view)
 * GET /api/audit?tenant=<id>           that tenant's events plus its descendants'
 * GET /api/audit?tenant=<id>&platform=1  …and the untenanted platform events
 * GET /api/audit?usage=1               per-tenant token/cost rollup
 *
 * The unfiltered response stays an ARRAY, because that is what the Audit page
 * already consumes. Adding a tenant filter must not reshape the default
 * response and break a page that was working.
 */
export async function GET(req: NextRequest) {
  const tenantId = req.nextUrl.searchParams.get("tenant");
  const wantUsage = req.nextUrl.searchParams.get("usage") === "1";
  const includePlatform = req.nextUrl.searchParams.get("platform") === "1";

  if (wantUsage) {
    // Cost attribution starts from the run records, not the audit log: a run
    // carries the authoritative token total, while an audit entry is a
    // description of something that happened.
    return NextResponse.json({
      usageByTenant: usageByTenant(store.workflowRuns),
      tenants: store.tenants.map((t) => ({
        id: t.id,
        tenantId: t.tenantId,
        tenantName: t.tenantName,
      })),
    });
  }

  if (!tenantId) return NextResponse.json(store.audit);

  const tenant = store.tenants.find(
    (t) => t.id === tenantId || t.tenantId === tenantId
  );
  if (!tenant) {
    return NextResponse.json({ error: `unknown tenant '${tenantId}'` }, { status: 404 });
  }
  const scoped = filterAuditForTenant(store.audit, tenant.id, store.tenants, {
    includePlatform,
  });
  return NextResponse.json({
    tenantId: tenant.id,
    tenantName: tenant.tenantName,
    // The subtree that was expanded, so a caller can see WHY an event is here.
    includedTenantIds: scoped.includedTenantIds,
    // Reported rather than silently dropped: a log that omits entries without
    // saying so is worse than one that admits it.
    platformEventsExcluded: includePlatform ? 0 : scoped.platformEvents,
    count: scoped.events.length,
    events: scoped.events,
  });
}
