// RAG Factory API: corpora of finalized documents → pattern → approval → build → query.
//
//   GET  ?health=1                                  -> factory reachability + pattern catalog
//   GET  ?personaId=…[&tenantId=…]                  -> corpora the persona may view
//   GET  ?personaId=…&corpusId=…                    -> one corpus (+ its KB record id)
//   GET  ?personaId=…&eligible=<tenantId>           -> finalized documents that can enter a corpus
//   POST { op: "create" | "update" | "submit" | "approve" | "reject" | "rebuild" | "query", ... }
//
// All decisions are made in lib/ragfactory/service.ts.

import { NextRequest, NextResponse } from "next/server";
import { RagFactoryError, ragConfig, ragHealth } from "@/lib/ragfactory/client";
import { PATTERNS, profileCorpus, recommendPattern } from "@/lib/ragfactory/patterns";
import {
  RagCorpusError,
  createCorpus,
  decideCorpus,
  eligibleDocuments,
  getCorpus,
  listCorpora,
  queryCorpus,
  rebuildCorpus,
  submitCorpus,
  updateCorpus,
} from "@/lib/ragfactory/service";
import { store } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 120;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof RagCorpusError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  if (e instanceof RagFactoryError) {
    const status = e.code === "RAG_NOT_CONFIGURED" ? 503 : 502;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  return NextResponse.json({ error: (e as Error).message ?? "internal error" }, { status: 500 });
}

const strings = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    if (q.get("health")) {
      return NextResponse.json({
        factory: { configured: Boolean(ragConfig()), ...(await ragHealth()) },
        qdrant: { configured: Boolean(process.env.QDRANT_URL) },
        patterns: PATTERNS,
      });
    }
    const personaId = q.get("personaId") ?? "";
    const eligible = q.get("eligible");
    if (eligible) return NextResponse.json({ documents: eligibleDocuments(personaId, eligible) });
    const corpusId = q.get("corpusId");
    if (corpusId) {
      const c = getCorpus(corpusId, personaId);
      const kb = c.kbRecordId ? store.records.find((r) => r.id === c.kbRecordId) : undefined;
      return NextResponse.json({ corpus: c, kbRecord: kb ? { id: kb.id, name: kb.name, status: kb.status } : null });
    }
    return NextResponse.json({ corpora: listCorpora(personaId, q.get("tenantId") || undefined) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const personaId = String(body.personaId ?? "");
    const corpusId = String(body.corpusId ?? "");
    const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
    switch (body.op) {
      case "preview": {
        // Profile + recommendation for a selection, before anything is created.
        const ids = strings(body.finalizedDocumentIds) ?? [];
        const docs = store.finalizedDocuments.filter((r) => ids.includes(r.doc.finalizedDocumentId)).map((r) => r.doc);
        eligibleDocuments(personaId, String(body.tenantId ?? "")); // authorizes viewCorpus in the tenant
        const profile = profileCorpus(docs.filter((d) => d.tenantId === body.tenantId));
        return NextResponse.json({ profile, recommendation: recommendPattern(profile) });
      }
      case "create":
        return NextResponse.json({ corpus: createCorpus({
          tenantId: String(body.tenantId ?? ""), personaId, name: String(body.name ?? ""),
          description: typeof body.description === "string" ? body.description : undefined,
          finalizedDocumentIds: strings(body.finalizedDocumentIds) ?? [],
          patternId: typeof body.patternId === "string" && body.patternId ? body.patternId : undefined,
          followNewVersions: typeof body.followNewVersions === "boolean" ? body.followNewVersions : undefined,
        }) }, { status: 201 });
      case "update":
        return NextResponse.json({ corpus: updateCorpus({
          corpusId, personaId,
          name: typeof body.name === "string" ? body.name : undefined,
          description: typeof body.description === "string" ? body.description : undefined,
          finalizedDocumentIds: strings(body.finalizedDocumentIds),
          patternId: typeof body.patternId === "string" ? body.patternId : undefined,
          followNewVersions: typeof body.followNewVersions === "boolean" ? body.followNewVersions : undefined,
        }) });
      case "submit":
        return NextResponse.json({ corpus: submitCorpus(corpusId, personaId) });
      case "approve":
      case "reject":
        return NextResponse.json({ corpus: decideCorpus(corpusId, personaId, body.op, note) }, { status: body.op === "approve" ? 202 : 200 });
      case "rebuild":
        return NextResponse.json({ corpus: rebuildCorpus(corpusId, personaId) }, { status: 202 });
      case "query": {
        const filters: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries((body.filters ?? {}) as Record<string, unknown>)) {
          if (typeof v === "string" ? v !== "" : typeof v === "number" || typeof v === "boolean") filters[k] = v as string | number | boolean;
        }
        return NextResponse.json(await queryCorpus({ corpusId, personaId, question: String(body.question ?? ""), filters }));
      }
      default:
        throw new RagCorpusError("BAD_REQUEST", `unknown op '${String(body.op)}'`);
    }
  } catch (e) {
    return errorResponse(e);
  }
}
