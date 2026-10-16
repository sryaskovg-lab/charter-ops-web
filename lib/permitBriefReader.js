import { getSupabaseAdmin } from "./supabaseAdmin";
import { buildBriefPrompt, parseModelJson, normalizeBrief, matchProposal } from "./permit-brief";
import { normState } from "./permit-utils";
import { readReplyBody } from "./permit-reply";
import { readRequestMail, requestItems, threadBlocks } from "./permit-request-read";

// proposals read from an e-mail's own text use this in place of an attachment path
export const BODY_PATH = "body";

// Server-only. Reads PDF / TXT attachments of filed e-mails (already stored in the permit-docs
// bucket by the mail sync) with the Claude API and stores what it found as a *proposal* per
// attachment. Nothing about a permit changes until a person confirms the proposal.
const MODEL = "claude-sonnet-5";
const MAX_PDF_BYTES = 10 * 1024 * 1024;

async function askClaude(content) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error("ANTHROPIC_API_KEY is not set for this deployment (Vercel → Settings → Environment Variables), so attachments cannot be read."), { config: true });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 45000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, messages: [{ role: "user", content }] }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error(`Claude API refused the key (${res.status}).`), { config: true });
    if (!res.ok) throw new Error(`Claude API error (${res.status}): ${j.error?.message || "unknown"}`);
    return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
  } finally { clearTimeout(timer); }
}

export function briefReaderConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

// limit: documents per run; budgetMs: stop starting new documents after this long
export async function analyzePermitBriefs({ limit = 3, budgetMs = 35000 } = {}) {
  const started = Date.now();
  const admin = getSupabaseAdmin();
  const result = { configured: briefReaderConfigured(), read: 0, withPermits: 0, empty: 0, failed: 0, waiting: 0, errors: [] };
  result.bodies = 0;

  const [em, pr, rt, st, pm, rs, ap] = await Promise.all([
    admin.from("permit_emails").select("id,subject,from_addr,received_at,attachments,status,body_text").in("status", ["unassigned", "filed"]).order("received_at", { ascending: false }).limit(150),
    admin.from("permit_proposals").select("email_id,attachment_path").limit(2000),
    admin.from("route_overfly_states").select("states"),
    admin.from("overfly_states").select("state"),
    admin.from("overfly_permits").select("id,kind,state,status,permit_number,authority_ref,valid_from,valid_to,resource_ids,airport"),
    admin.from("resources").select("id,code"),
    admin.from("airport_states").select("airport,state"),
  ]);
  const err = em.error || pr.error || pm.error || rs.error;
  if (err) throw new Error(`Database error (is migration 00031 applied?): ${err.message}`);

  const done = new Set((pr.data || []).map(r => `${r.email_id}|${r.attachment_path}`));
  const queue = [];
  (em.data || []).forEach(m => (m.attachments || []).forEach(a => {
    if (/\.(pdf|txt)$/i.test(a.name || "") && !done.has(`${m.id}|${a.path}`)) queue.push({ m, a });
  }));
  result.waiting = Math.max(0, queue.length - limit);

  const states = [...new Set([
    ...(st.data || []).map(r => normState(r.state)), ...(ap.data || []).map(r => normState(r.state)),
    ...(rt.data || []).flatMap(r => r.states || []).map(normState), ...(pm.data || []).map(r => normState(r.state)),
  ].filter(Boolean))].sort();
  const resources = (rs.data || []).map(r => ({ id: r.id, code: r.code }));
  const permits = (pm.data || []).map(p => ({ id: p.id, kind: p.kind, state: p.state, status: p.status, permitNumber: p.permit_number, authorityRef: p.authority_ref, validFrom: p.valid_from, validTo: p.valid_to, resourceIds: p.resource_ids || [], airport: p.airport }));
  // 1. e-mail text: plain rules, no API key needed
  for (const m of em.data || []) {
    if (done.has(`${m.id}|${BODY_PATH}`) || !m.body_text) continue;
    const ctx = { subject: m.subject, states, receivedAt: m.received_at };
    // a decision in the text; in a forwarded mail the text itself is only our signature, so the first quoted block is tried next
    let found = readReplyBody(m.body_text, ctx);
    if (!found.length) { const blocks = threadBlocks(m.body_text); if (blocks.length > 1) found = readReplyBody(blocks[1], ctx); }
    // a request we sent to an agent: which countries, which flights, which dates
    const req = readRequestMail(m.body_text, ctx);
    if (req.found && req.states.length) {
      const refsByNumber = new Map();
      for (const n of [...new Set(req.flights.map(f => f.number))]) {
        const { data: fr } = await admin.from("flights").select("ref").ilike("ref", `%${n}`).limit(60);
        refsByNumber.set(n, [...new Set((fr || []).map(r => String(r.ref).replace(/\s/g, "").toUpperCase()).filter(r => new RegExp(`^[A-Z]{0,3}0*${n.replace(/^0+/, "")}$`).test(r)))]);
      }
      const unknown = req.flights.filter(f => !(refsByNumber.get(f.number) || []).length).map(f => f.number);
      const asked = requestItems(req, n => refsByNumber.get(n) || []);
      asked.forEach(it => { if (unknown.length) it.remarks += `. Not in the schedule: ${[...new Set(unknown)].join(", ")}`; if (!found.some(x => x.kind === it.kind && x.state === it.state)) found.push(it); });
    }
    const items = found.map(it => ({ ...it, match: matchProposal(it, permits, resources) }));
    const { error: insErr } = await admin.from("permit_proposals").insert({ email_id: m.id, attachment_path: BODY_PATH, file_name: "e-mail text", status: items.length ? "pending" : "empty", items, summary: items.length ? `${items.length} item(s) found in the e-mail text` : null });
    if (insErr && insErr.code !== "23505") { result.errors.push(`e-mail text: ${insErr.message}`); continue; }
    result.bodies++;
  }
  if (!result.configured) { if (queue.length) result.error = "ANTHROPIC_API_KEY is not set, so PDF/TXT attachments cannot be read (e-mail text was read)."; return result; }

  // airport codes used by the schedule (paged: PostgREST returns at most 1000 rows)
  const airportSet = new Set((ap.data || []).map(r => r.airport).filter(Boolean));
  for (let from = 0; from < 6000; from += 1000) {
    const { data: fr, error: fe } = await admin.from("flights").select("origin,destination").order("id").range(from, from + 999);
    if (fe || !fr?.length) break;
    fr.forEach(f => { if (f.origin) airportSet.add(String(f.origin).toUpperCase()); if (f.destination) airportSet.add(String(f.destination).toUpperCase()); });
    if (fr.length < 1000) break;
  }
  const airports = [...airportSet].sort().slice(0, 300);

  for (const { m, a } of queue.slice(0, limit)) {
    if (Date.now() - started > budgetMs) { result.waiting++; continue; }
    const row = { email_id: m.id, attachment_path: a.path, file_name: a.name };
    const prompt = buildBriefPrompt({ states, aircraft: resources.map(r => r.code), airports, fileName: a.name, documentDate: m.received_at ? String(m.received_at).slice(0, 10) : "" });
    try {
      const dl = await admin.storage.from("permit-docs").download(a.path);
      if (dl.error || !dl.data) throw new Error(`file not readable: ${dl.error?.message || "missing"}`);
      const buf = Buffer.from(await dl.data.arrayBuffer());
      let content;
      if (/\.pdf$/i.test(a.name)) {
        if (buf.length > MAX_PDF_BYTES) throw new Error("PDF is over 10 MB");
        content = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } }, { type: "text", text: prompt }];
      } else {
        content = [{ type: "text", text: `${prompt}\n\n--- DOCUMENT START ---\n${buf.toString("utf8").replace(/\u0000/g, "").slice(0, 60000)}\n--- DOCUMENT END ---` }];
      }
      const text = await askClaude(content);
      const parsed = normalizeBrief(parseModelJson(text), { aircraft: resources });
      const items = parsed.items.map(it => ({ ...it, match: matchProposal(it, permits, resources) }));
      const { error: insErr } = await admin.from("permit_proposals").insert({ ...row, status: items.length ? "pending" : "empty", items, summary: parsed.summary });
      if (insErr && insErr.code !== "23505") throw new Error(insErr.message);
      result.read++;
      if (items.length) result.withPermits++; else result.empty++;
    } catch (e) {
      if (e.config) { result.error = e.message; break; } // configuration problem: do not record per-document errors
      result.failed++;
      result.errors.push(`${a.name}: ${e.message}`);
      await admin.from("permit_proposals").upsert({ ...row, status: "error", items: [], error: String(e.message).slice(0, 300) }, { onConflict: "email_id,attachment_path", ignoreDuplicates: true });
    }
  }
  return result;
}
