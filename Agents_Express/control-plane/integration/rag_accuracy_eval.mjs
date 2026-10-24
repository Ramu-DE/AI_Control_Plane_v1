#!/usr/bin/env node
/**
 * Decision-grade accuracy evaluation of a RAG Factory corpus, end to end and LIVE
 * (control plane -> planner on Bedrock -> exact field query or the factory's
 * verified retrieval over Qdrant Cloud).
 *
 *   node integration/rag_accuracy_eval.mjs integration/golden/<set>.json [--base http://127.0.0.1:3000/proxy/3000]
 *
 * Scoring is strict:
 *   answerable question   correct  = answered (not abstained) AND every expectation holds
 *                         abstained = counted separately (safe, but not useful)
 *                         wrong    = answered AND an expectation fails  <- the number that matters
 *   unanswerable question correct  = abstained (or an exact "no finalized document" result)
 * Reports precision among answered questions with a one-sided 95% Clopper–Pearson lower bound.
 */
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const setPath = args.find((a) => !a.startsWith("--"));
const base = (args.includes("--base") ? args[args.indexOf("--base") + 1] : "http://127.0.0.1:3000/proxy/3000").replace(/\/$/, "");
const set = JSON.parse(readFileSync(setPath, "utf8"));

// Clopper–Pearson one-sided lower bound for k successes out of n (bisection on the binomial CDF).
function lowerBound(k, n, alpha = 0.05) {
  if (n === 0) return 0;
  if (k === 0) return 0;
  const logC = (n_, k_) => { let s = 0; for (let i = 1; i <= k_; i++) s += Math.log((n_ - k_ + i) / i); return s; };
  const tail = (p) => { let s = 0; for (let i = k; i <= n; i++) s += Math.exp(logC(n, i) + i * Math.log(p) + (n - i) * Math.log1p(-p)); return s; };
  let lo = 0, hi = k / n;
  for (let it = 0; it < 60; it++) { const mid = (lo + hi) / 2; if (tail(mid) < alpha) lo = mid; else hi = mid; }
  return lo;
}

function grade(expect, out) {
  const text = `${out.answer ?? ""}`;
  const isNoMatch = out.mode === "exact" && /^No finalized document/.test(text);
  const abstained = out.abstained || isNoMatch;
  const problems = [];
  if (expect.abstain) {
    if (!abstained) problems.push("should have abstained");
  } else {
    if (abstained) return { verdict: "abstained", problems: [out.reason ?? "abstained"] };
    for (const c of expect.contains ?? []) if (!text.toLowerCase().includes(c.toLowerCase())) problems.push(`missing "${c}"`);
    if (expect.matches && !new RegExp(expect.matches, "i").test(text)) problems.push(`does not match /${expect.matches}/`);
  }
  for (const c of expect.notContains ?? []) if (text.toLowerCase().includes(c.toLowerCase())) problems.push(`must not contain "${c}"`);
  if (expect.notMatches && new RegExp(expect.notMatches, "i").test(text)) problems.push(`must not match /${expect.notMatches}/`);
  return { verdict: problems.length ? "wrong" : "correct", problems };
}

const results = [];
for (const q of set.questions) {
  const t0 = Date.now();
  let out;
  try {
    const res = await fetch(`${base}/api/ragfactory`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "query", corpusId: set.corpusId, personaId: set.personaId, question: q.q }),
    });
    out = await res.json();
    if (!res.ok) out = { abstained: true, reason: `HTTP ${res.status}: ${out.error}`, answer: null, mode: "error", citations: [] };
  } catch (e) {
    out = { abstained: true, reason: String(e), answer: null, mode: "error", citations: [] };
  }
  const g = grade(q.expect, out);
  results.push({ ...q, mode: out.mode, verdict: g.verdict, problems: g.problems, answer: out.answer, reason: out.reason,
    citations: (out.citations ?? []).length, claims: (out.claims ?? []).map((c) => c.supported), seconds: (Date.now() - t0) / 1000 });
  const mark = g.verdict === "correct" ? "PASS " : g.verdict === "abstained" ? "ABST " : "FAIL ";
  console.log(`${mark} ${q.id.padEnd(3)} [${(out.mode ?? "?").padEnd(18)}] ${q.q}`);
  console.log(`        -> ${(out.answer ?? `(no answer: ${out.reason})`).replace(/\s+/g, " ").slice(0, 170)}${g.problems.length ? `   !! ${g.problems.join("; ")}` : ""}`);
}

const answerable = results.filter((r) => !r.expect.abstain);
const unanswerable = results.filter((r) => r.expect.abstain);
const answered = answerable.filter((r) => r.verdict !== "abstained");
const correctAnswered = answered.filter((r) => r.verdict === "correct").length;
const wrongOnUnanswerable = unanswerable.filter((r) => r.verdict !== "correct").length;
const totalAnswered = answered.length + wrongOnUnanswerable;
const correctOfAnswered = correctAnswered;
const summary = {
  set: setPath, at: new Date().toISOString(), questions: results.length,
  answerable: answerable.length, answered: answered.length, abstainedOnAnswerable: answerable.length - answered.length,
  correctOnAnswerable: correctAnswered, wrongOnAnswerable: answered.length - correctAnswered,
  unanswerable: unanswerable.length, correctlyAbstained: unanswerable.length - wrongOnUnanswerable, answeredUnanswerable: wrongOnUnanswerable,
  coverage: answerable.length ? answered.length / answerable.length : null,
  precisionOfAnswers: totalAnswered ? correctOfAnswered / totalAnswered : null,
  precisionLowerBound95: lowerBound(correctOfAnswered, totalAnswered),
  byMode: Object.fromEntries(["exact", "verified-retrieval"].map((m) => {
    const rs = results.filter((r) => r.mode === m);
    return [m, { questions: rs.length, correct: rs.filter((r) => r.verdict === "correct").length }];
  })),
};
console.log("\n" + JSON.stringify(summary, null, 2));
writeFileSync(setPath.replace(/\.json$/, `.results.json`), JSON.stringify({ summary, results }, null, 2));
process.exitCode = summary.wrongOnAnswerable + summary.answeredUnanswerable > 0 ? 1 : 0;
