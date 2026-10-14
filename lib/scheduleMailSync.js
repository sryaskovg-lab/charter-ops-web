import { getSupabaseAdmin } from "./supabaseAdmin";
import { accessToken, mailConfigured, gmailGet } from "./gmailApi";
import { headerOf, extractText, walk, stripNulls } from "./permit-mail";
import { describeScheduleText } from "./schedule-msg";

// Server-only. Reads (never changes) Gmail messages carrying the label (default "Schedule"),
// finds SSIM files and SSM/ASM messages in the body and in text attachments, and stores them for
// a person to review and apply in the app. Uses the same Google connection as the permit mail.
const MAX_NEW_PER_RUN = 25;
const MAX_TEXT_BYTES = 1.5 * 1024 * 1024;
const TEXT_NAME = /\.(txt|ssim|ssm|asm|dat|msg|tlx|telex)$/i;

export { mailConfigured };

function b64ToText(data) {
  return Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("latin1"); // SSIM is plain ASCII
}

export async function syncScheduleMail() {
  if (!mailConfigured()) return { configured: false, error: "Gmail is not connected yet: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are not all set in Vercel." };
  const admin = getSupabaseAdmin();
  const label = (process.env.SCHEDULE_MAIL_LABEL || "Schedule").trim().replace(/\s+/g, "-");
  const token = await accessToken();

  const ids = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ q: `label:${label} newer_than:30d`, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const j = await gmailGet(token, `messages?${q}`);
    (j.messages || []).forEach(m => ids.push(m.id));
    pageToken = j.nextPageToken || "";
  } while (pageToken && ids.length < 200);

  const known = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("schedule_messages").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 100));
    if (error) throw new Error(`Database error (is migration 00033 applied?): ${error.message}`);
    (data || []).forEach(r => known.add(r.gmail_message_id));
  }
  const fresh = ids.filter(id => !known.has(id));
  const batch = fresh.slice(0, MAX_NEW_PER_RUN);
  const result = { configured: true, found: ids.length, added: 0, ignored: 0, failed: 0, remaining: Math.max(0, fresh.length - batch.length), errors: [] };

  for (const id of batch) {
    try {
      const msg = await gmailGet(token, `messages/${id}?format=full`);
      const payload = msg.payload || {};
      const base = {
        gmail_message_id: id, from_addr: stripNulls(headerOf(payload, "From")), subject: stripNulls(headerOf(payload, "Subject")),
        received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
      };
      const parts = [{ part: "body", name: null, text: stripNulls(extractText(payload, MAX_TEXT_BYTES)) }];
      let n = 0;
      const atts = [];
      walk(payload, p => { if (p.filename && p.body?.attachmentId && TEXT_NAME.test(p.filename) && (p.body.size || 0) <= MAX_TEXT_BYTES) atts.push(p); });
      for (const a of atts) {
        n++;
        const att = await gmailGet(token, `messages/${id}/attachments/${a.body.attachmentId}`);
        parts.push({ part: `att${n}`, name: a.filename, text: stripNulls(b64ToText(att.data)) });
      }
      const rows = [];
      for (const p of parts) {
        const d = describeScheduleText(p.text);
        if (d) rows.push({ ...base, part: p.part, file_name: p.name, kind: d.kind, raw_text: p.text, summary: d.summary, status: "pending" });
      }
      // a message with nothing to read is still recorded, so it is not fetched again every run
      if (!rows.length) { rows.push({ ...base, part: "body", kind: "other", summary: "No SSIM, SSM or ASM found", status: "dismissed" }); result.ignored++; }
      const { error } = await admin.from("schedule_messages").insert(rows);
      if (error) throw new Error(error.message);
      result.added += rows.filter(r => r.kind !== "other").length;
    } catch (e) {
      result.failed++;
      result.errors.push(`${id}: ${e.message}`);
      await admin.from("schedule_messages").upsert({ gmail_message_id: id, part: "body", kind: "other", subject: "(could not be imported)", summary: String(e.message).slice(0, 300), status: "error" }, { onConflict: "gmail_message_id,part", ignoreDuplicates: true });
    }
  }
  return result;
}
