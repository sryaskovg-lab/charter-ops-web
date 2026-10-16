import { getSupabaseAdmin } from "./supabaseAdmin";
import { accessToken, mailConfigured, gmailGet } from "./gmailApi";
import { headerOf, extractText, stripNulls } from "./permit-mail";
import { applyMovementText } from "./movementApply";

// Server-only. Reads (never changes) Gmail messages carrying the label (default "Movements"), takes the
// MVT messages out of the body and stores the actual times on the flights. Same Google connection as the
// permit and schedule mail.
const MAX_PER_RUN = 60;
export { mailConfigured };

export async function syncMovementMail() {
  if (!mailConfigured()) return { configured: false, error: "Gmail is not connected yet: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are not all set in Vercel." };
  const admin = getSupabaseAdmin();
  const label = (process.env.MOVEMENT_MAIL_LABEL || "Movements").trim().replace(/\s+/g, "-");
  const token = await accessToken();
  const ids = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ q: `label:${label} newer_than:3d`, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const j = await gmailGet(token, `messages?${q}`);
    (j.messages || []).forEach(m => ids.push(m.id));
    pageToken = j.nextPageToken || "";
  } while (pageToken && ids.length < 300);

  const known = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("movement_messages").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 100));
    if (error) throw new Error(`Database error (is migration 00039 applied?): ${error.message}`);
    (data || []).forEach(r => known.add(r.gmail_message_id));
  }
  const fresh = ids.filter(id => !known.has(id));
  const batch = fresh.slice(0, MAX_PER_RUN);
  const result = { configured: true, found: ids.length, applied: 0, unmatched: 0, ignored: 0, failed: 0, remaining: Math.max(0, fresh.length - batch.length), errors: [] };
  for (const id of batch) {
    try {
      const msg = await gmailGet(token, `messages/${id}?format=full`);
      const payload = msg.payload || {};
      const meta = { gmailMessageId: id, fromAddr: stripNulls(headerOf(payload, "From")), subject: stripNulls(headerOf(payload, "Subject")), receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null };
      const r = await applyMovementText(admin, stripNulls(extractText(payload, 200000)), meta);
      if (r.notMvt) {
        // recorded so that it is not fetched again every run
        await admin.from("movement_messages").insert({ gmail_message_id: id, part: "body", from_addr: meta.fromAddr, subject: meta.subject, received_at: meta.receivedAt, status: "ignored", note: "No MVT found" });
        result.ignored++;
      } else { result.applied += r.applied; result.unmatched += r.unmatched; if (r.errors.length) { result.failed++; result.errors.push(...r.errors.slice(0, 1)); } }
    } catch (e) { result.failed++; result.errors.push(`${id}: ${e.message}`); }
  }
  return result;
}
