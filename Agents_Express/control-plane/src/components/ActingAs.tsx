"use client";

// "Acting as" — which persona is taking a lifecycle action (submit, approve,
// reject, deprecate) in the console. Every such action is maker-checker
// governed (lib/approvals.ts), so the console has to say who is acting. The
// choice is remembered across pages for the session.

import { useEffect, useState } from "react";
import { getJSON } from "@/lib/api";

export interface ActingPersona {
  id: string;
  name: string;
  memberships?: { tenantId: string; role: string }[];
}

const KEY = "cp.actingPersonaId";

export function useActingPersona(): {
  personaId: string;
  setPersonaId: (id: string) => void;
  personas: ActingPersona[];
} {
  const [personas, setPersonas] = useState<ActingPersona[]>([]);
  const [personaId, setId] = useState("");
  useEffect(() => {
    getJSON<{ personas: ActingPersona[] }>("/api/personas")
      .then((d) => {
        setPersonas(d.personas);
        const saved = typeof window !== "undefined" ? window.localStorage.getItem(KEY) : null;
        if (saved && d.personas.some((p) => p.id === saved)) setId(saved);
      })
      .catch(() => setPersonas([]));
  }, []);
  const setPersonaId = (id: string) => {
    setId(id);
    if (typeof window !== "undefined") window.localStorage.setItem(KEY, id);
  };
  return { personaId, setPersonaId, personas };
}

export function roles(p: ActingPersona): string {
  return (p.memberships ?? []).map((m) => `${m.role}@${m.tenantId}`).join(", ") || "unscoped";
}

export function ActingAsSelect({
  personaId,
  setPersonaId,
  personas,
  hint = "Submitting needs analyst+; approving, rejecting or deprecating needs approver+ in the resource's tenant, and not the submitter.",
}: {
  personaId: string;
  setPersonaId: (id: string) => void;
  personas: ActingPersona[];
  hint?: string;
}) {
  return (
    <label className="block text-xs text-slate-600" title={hint}>
      <span className="font-medium">Acting as</span>
      <select
        className="input mt-1 min-w-[16rem]"
        value={personaId}
        onChange={(e) => setPersonaId(e.target.value)}
      >
        <option value="">Select persona…</option>
        {personas.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} — {roles(p)}
          </option>
        ))}
      </select>
    </label>
  );
}
