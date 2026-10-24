#!/usr/bin/env node
/**
 * LIVE calibration batch: generate documents with KNOWN values, run them
 * through the real platform (IDP on Bedrock, consensus, validation incl.
 * Unity Catalog), then review -> submit -> finalize with the true values, so
 * every finalized field is a correct label. Finally train the candidate
 * calibrators and print measured accuracy.
 *
 *   node integration/calibration_batch_live.mjs [--n 12] [--base http://127.0.0.1:3000/proxy/3000]
 *        [--tenant fn-rnd] [--maker persona-priya] [--checker persona-daniel] [--seed 7]
 *
 * The "reviewer" here is the generator's ground truth: it corrects exactly the
 * values the system got wrong, as a careful human would against the source.
 */
const arg = (k, d) => (process.argv.includes(`--${k}`) ? process.argv[process.argv.indexOf(`--${k}`) + 1] : d);
const BASE = arg("base", "http://127.0.0.1:3000/proxy/3000").replace(/\/$/, "");
const N = Number(arg("n", "12"));
const TENANT = arg("tenant", "fn-rnd");
const MAKER = arg("maker", "persona-priya");
const CHECKER = arg("checker", "persona-daniel");
let seed = Number(arg("seed", "7"));
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n) => String(n).padStart(2, "0");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(y, m, d, style) {
  if (style === 0) return `${y}-${pad(m)}-${pad(d)}`;
  if (style === 1) return `${pad(d)}.${pad(m)}.${y}`;
  return `${pad(d)} ${MON[m - 1]} ${y}`;
}

// ------------------------------------------------------------------ PDF writer (text only, one page)
function pdf(lines) {
  const esc = (l) => l.replace(/\\/g, "\\\\").replace(/\(/g, "[").replace(/\)/g, "]");
  const text = "BT /F1 11 Tf 50 760 Td 15 TL " + lines.map((l) => `(${esc(l)}) Tj T*`).join(" ") + " ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n";
  const offs = [];
  objs.forEach((o, i) => { offs.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out);
}

// ------------------------------------------------------------------ generators with ground truth
const PRODUCTS = ["Vonoprazan Fumarate 20 mg tablets", "Lisdexamfetamine 30 mg capsules", "Vedolizumab 300 mg powder", "Lanreotide 120 mg solution"];
const SITES = ["Takeda Pharmaceutical, Osaka Plant", "Takeda GmbH, Singen", "Takeda Ireland, Grange Castle", "Shire US Manufacturing, Lexington"];
function coa(i) {
  const style = i % 3;
  const y = 2026, m = 1 + Math.floor(rnd() * 9), d = 1 + Math.floor(rnd() * 27);
  const batch = `${pick(["VF", "LX", "VD", "LN"])}-${pad(24 + (i % 3))}-${String(1000 + Math.floor(rnd() * 8999))}`;
  const oos = i % 5 === 4;
  const assay = oos ? (93 + rnd()).toFixed(1) : (97 + rnd() * 3).toFixed(1);
  const truth = {
    product: pick(PRODUCTS),
    batch_number: batch,
    manufacturing_date: fmtDate(y, m, d, style),
    expiry_date: fmtDate(y + 2, m, d, style),
    manufacturer: pick(SITES),
    conclusion: oos ? "Batch on hold pending OOS investigation." : "The batch complies with all specifications and is released.",
  };
  const label = { batch: ["Batch Number", "Lot No.", "Batch"][style], mfg: ["Manufacturing Date", "Date of Manufacture", "Mfg. Date"][style],
    exp: ["Expiry Date", "Expiration Date", "Exp. Date"][style] };
  const lines = [
    "CERTIFICATE OF ANALYSIS",
    `Product: ${truth.product}`,
    `${label.batch}: ${truth.batch_number}`,
    ...(style === 2 ? [`${label.exp}: ${truth.expiry_date}`, `${label.mfg}: ${truth.manufacturing_date}`]
      : [`${label.mfg}: ${truth.manufacturing_date}`, `${label.exp}: ${truth.expiry_date}`]),
    `Manufacturer: ${truth.manufacturer}`,
    "Test  Specification  Result",
    `Assay (HPLC)  95.0 - 105.0 %  ${assay} %`,
    `Dissolution (30 min)  NLT 80 %  ${(85 + rnd() * 10).toFixed(0)} %`,
    `Water content (KF)  NMT 3.0 %  ${(0.5 + rnd() * 2).toFixed(1)} %`,
    `Conclusion: ${truth.conclusion}`,
    "QA Approver: Dr. H. Sato, Head of Quality Assurance",
  ];
  return { kind: "coa", file: `cal-coa-${i}.pdf`, truth, lines, expectBlock: oos };
}
const SUPPLIERS = ["ACME Lab Supplies", "Globex Reagents", "Initech Labware"];
const ITEMS = [["Pipette tips", 12.5], ["Reagent kit", 310], ["Glass vials", 1.2], ["Nitrile gloves", 8.4], ["Centrifuge tubes", 0.35], ["Buffer solution", 42]];
function invoice(i) {
  const style = i % 3;
  const supplier = SUPPLIERS[i % SUPPLIERS.length];
  const y = 2026, m = 6 + Math.floor(rnd() * 4), d = 1 + Math.floor(rnd() * 27);
  const n = 2 + Math.floor(rnd() * 3);
  const lines = [];
  let total = 0;
  const used = new Set();
  for (let k = 0; k < n; k++) {
    let it = pick(ITEMS);
    while (used.has(it[0])) it = pick(ITEMS);
    used.add(it[0]);
    const q = 1 + Math.floor(rnd() * 20);
    const amt = Math.round(q * it[1] * 100) / 100;
    total += amt;
    lines.push(`${it[0]}  ${q}  ${it[1].toFixed(2)}  ${amt.toFixed(2)}`);
  }
  const truth = {
    supplier_name: supplier,
    invoice_number: `${pick(["INV", "IN", "BILL"])}-${y}-${String(100 + i).padStart(4, "0")}`,
    invoice_date: fmtDate(y, m, d, style),
    total_due: `${total.toFixed(2)} USD`,
    payment_terms: pick(["Net 30", "Net 45", "Net 60"]),
    bill_to: pick(["Takeda R&D, Cambridge MA", "Takeda Pharmaceuticals, Lexington MA"]),
  };
  const label = { no: ["Invoice Number", "Invoice No.", "Invoice #"][style], date: ["Invoice Date", "Date", "Issue Date"][style] };
  return {
    kind: "invoice", file: `cal-inv-${i}.pdf`, truth, expectBlock: supplier === "Initech Labware",
    lines: [`${supplier} - INVOICE`, `${label.no}: ${truth.invoice_number}`, `${label.date}: ${truth.invoice_date}`,
      `Bill To: ${truth.bill_to}`, "Item  Qty  Unit Price  Amount", ...lines, `Total Due: ${truth.total_due}`, `Payment Terms: ${truth.payment_terms}`],
  };
}

// ------------------------------------------------------------------ platform calls
async function api(method, body, form) {
  const res = await fetch(`${BASE}/api/docintel`, form
    ? { method: "POST", body: form }
    : method === "GET" ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${j.error}`);
  return j;
}
const get = async (q) => (await fetch(`${BASE}/api/docintel?${q}`, { cache: "no-store" })).json();
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function processOne(doc) {
  const form = new FormData();
  form.append("file", new Blob([pdf(doc.lines)], { type: "application/pdf" }), doc.file);
  form.append("tenantId", TENANT);
  form.append("personaId", MAKER);
  const { job } = await api("POST", null, form);
  await api("POST", { op: "run", documentId: job.documentId, personaId: MAKER });
  let j = job;
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    j = (await get(`personaId=${MAKER}&documentId=${job.documentId}`)).job;
    if (!["processing", "uploaded"].includes(j.status)) break;
  }
  if (!j.review) return { doc, documentId: job.documentId, error: `no review (${j.status}: ${j.runError ?? ""})` };
  // Draft accuracy BEFORE any human correction (what the system produced).
  const draft = {};
  for (const [f, v] of Object.entries(doc.truth)) {
    const got = j.review.fields.find((x) => x.name === f)?.value;
    draft[f] = got !== undefined && (norm(got) === norm(v) || (f.includes("date") || f === "total_due") && sameish(got, v));
  }
  // Reviewer: set every schema field to the true value (only changed ones become edits).
  const fields = j.review.fields.map((x) => (x.name in doc.truth ? { ...x, value: doc.truth[x.name] } : x));
  for (const [f, v] of Object.entries(doc.truth)) if (!fields.some((x) => x.name === f)) fields.push({ name: f, value: v, edited: false });
  if (j.status !== "pending-finalization") {
    await api("POST", { op: "review", documentId: job.documentId, personaId: MAKER, edits: { fields } });
    const v = (await get(`personaId=${MAKER}&documentId=${job.documentId}`)).job.validation;
    const blocking = (v?.issues ?? []).filter((x) => x.severity === "block");
    await api("POST", { op: "submit", documentId: job.documentId, personaId: MAKER,
      ...(blocking.length ? { justification: `Verified against source; deviation handled under QA record QA-CAL-${job.documentId}` } : {}) });
  }
  const fin = await api("POST", { op: "finalize", documentId: job.documentId, personaId: CHECKER, note: "calibration batch: verified against source" });
  return { doc, documentId: job.documentId, route: j.route, draft, fd: fin.finalized.doc.finalizedDocumentId,
    methods: j.methodRuns.map((r) => `${r.method}:${r.status}`) };
}
function sameish(a, b) {
  const d = (s) => { const t = Date.parse(String(s).replace(/(\d{2})\.(\d{2})\.(\d{4})/, "$3-$2-$1")); return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10); };
  const n = (s) => { const m = /-?\d[\d,]*\.?\d*/.exec(String(s)); return m ? Number(m[0].replace(/,/g, "")) : null; };
  return (d(a) && d(a) === d(b)) || (n(a) !== null && n(a) === n(b));
}

// ------------------------------------------------------------------ run
const docs = [];
for (let i = 0; i < N; i++) { docs.push(coa(i)); docs.push(invoice(i)); }
console.log(`Processing ${docs.length} documents live in ${TENANT} (maker ${MAKER}, checker ${CHECKER})...`);
const results = [];
const queue = [...docs];
await Promise.all(Array.from({ length: 4 }, async () => {
  while (queue.length) {
    const d = queue.shift();
    try {
      const r = await processOne(d);
      results.push(r);
      const ok = r.draft ? Object.values(r.draft).filter(Boolean).length : 0;
      console.log(`  ${d.file.padEnd(16)} ${r.error ?? `${r.route?.padEnd(16)} draft ${ok}/${Object.keys(d.truth).length} correct -> ${r.fd}`}`);
    } catch (e) {
      results.push({ doc: d, error: String(e.message ?? e) });
      console.log(`  ${d.file.padEnd(16)} ERROR ${e.message}`);
    }
  }
}));

const fieldTotals = {};
for (const r of results.filter((x) => x.draft)) {
  for (const [f, ok] of Object.entries(r.draft)) {
    const k = `${r.doc.kind}.${f}`;
    fieldTotals[k] ??= { ok: 0, n: 0 };
    fieldTotals[k].n += 1;
    if (ok) fieldTotals[k].ok += 1;
  }
}
const allOk = Object.values(fieldTotals).reduce((s, x) => s + x.ok, 0);
const allN = Object.values(fieldTotals).reduce((s, x) => s + x.n, 0);
console.log(`\nDraft (consensus) field accuracy before any human correction: ${allOk}/${allN} = ${(100 * allOk / Math.max(1, allN)).toFixed(1)}%`);
for (const [k, v] of Object.entries(fieldTotals)) if (v.ok < v.n) console.log(`  ${k}: ${v.ok}/${v.n}`);

for (const typeId of ["dt-seed-coa", "dt-seed-invoice"]) {
  const { calibrator: c } = await api("POST", { op: "calibrationTrain", typeId, personaId: "persona-john" });
  console.log(`\n${typeId}: candidate v${c.version}: ${c.documents} documents, ${c.labels} labelled fields, consensus accuracy ` +
    `${c.consensusAccuracy === null ? "n/a" : (100 * c.consensusAccuracy).toFixed(1) + "%"}, best single method ` +
    `${c.bestSingleMethodAccuracy ? `${c.bestSingleMethodAccuracy.method} ${(100 * c.bestSingleMethodAccuracy.accuracy).toFixed(1)}%` : "n/a"}, ECE ${c.ece}`);
  console.log(`  auto-accept: ${c.threshold.threshold === null ? `OFF - ${c.threshold.reason}` : `P >= ${c.threshold.threshold.toFixed(3)} (${c.threshold.reason})`}`);
  const methods = [...new Set(c.methodStats.map((m) => m.method))];
  for (const m of methods) {
    const st = c.methodStats.filter((x) => x.method === m);
    const ok = st.reduce((s, x) => s + x.correct, 0), n = st.reduce((s, x) => s + x.total, 0);
    const weak = st.filter((x) => x.accuracy < 1).map((x) => `${x.field} ${x.correct}/${x.total}`).join(", ");
    console.log(`  ${m.padEnd(14)} ${ok}/${n} = ${(100 * ok / Math.max(1, n)).toFixed(1)}%${weak ? `   misses: ${weak}` : ""}`);
  }
}
