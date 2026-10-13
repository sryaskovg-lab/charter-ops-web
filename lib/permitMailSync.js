import { getSupabaseAdmin } from "./supabaseAdmin";
import { accessToken, mailConfigured } from "./gmailApi";
import { headerOf, extractText, listAttachments, safeFileName, stripNulls, matchEmailToPermit, noteTextForEmail } from "./permit-mail";

// Server-only. Reads (never changes) the Gmail messages that carry the configured label and files
// them: matched to a permit -> note + documents on that permit; otherwise -> Inbox for a person.
// Uses Gmail's REST API with a long-lived refresh token (scope gmail.readonly), no extra packages.
const MAX_NEW_PER_RUN = 25;

async function gmail(token, path) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail error (${res.status}): ${j.error?.message || "unknown"}`);
  return j;
}

export { mailConfigured };

export async function syncPermitMail() {
  if (!mailConfigured()) return { configured: false, error: "Gmail is not connected yet: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN are not all set in Vercel." };
  const admin = getSupabaseAdmin();
  const label = (process.env.PERMIT_MAIL_LABEL || "Permits").trim().replace(/\s+/g, "-");
  const token = await accessToken();

  // newest first, last 60 days, up to 200 ids
  const ids = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({ q: `label:${label} newer_than:60d`, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const j = await gmail(token, `messages?${q}`);
    (j.messages || []).forEach(m => ids.push(m.id));
    pageToken = j.nextPageToken || "";
  } while (pageToken && ids.length < 200);

  let known = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await admin.from("permit_emails").select("gmail_message_id").in("gmail_message_id", ids.slice(i, i + 100));
    if (error) throw new Error(`Database error (is migration 00029 applied?): ${error.message}`);
    (data || []).forEach(r => known.add(r.gmail_message_id));
  }
  const fresh = ids.filter(id => !known.has(id));
  const batch = fresh.slice(0, MAX_NEW_PER_RUN);

  const { data: permits, error: pErr } = await admin.from("overfly_permits").select("id,state,status,permit_number,authority_ref");
  if (pErr) throw new Error(`Database error: ${pErr.message}`);
  const permitList = (permits || []).map(p => ({ id: p.id, state: p.state, status: p.status, permitNumber: p.permit_number, authorityRef: p.authority_ref }));

  const result = { configured: true, found: ids.length, capped: ids.length >= 200, added: 0, filed: 0, unassigned: 0, failed: 0, remaining: Math.max(0, fresh.length - batch.length), errors: [] };
  for (const id of batch) {
    try {
      const msg = await gmail(token, `messages/${id}?format=full`);
      const payload = msg.payload || {};
      const subject = stripNulls(headerOf(payload, "Subject"));
      const from = stripNulls(headerOf(payload, "From"));
      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
      const body = stripNulls(extractText(payload));

      // index in the path: two attachments can share a name, or become identical after
      // non-ASCII characters are replaced
      const stored = [];
      let n = 0;
      for (const a of listAttachments(payload)) {
        n++;
        const att = await gmail(token, `messages/${id}/attachments/${a.attachmentId}`);
        const buf = Buffer.from(String(att.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
        const path = `mail/${id}/${n}-${safeFileName(a.name)}`;
        const up = await admin.storage.from("permit-docs").upload(path, buf, { upsert: true });
        if (up.error) { result.errors.push(`${a.name}: ${up.error.message}`); continue; }
        stored.push({ name: a.name, path, size: buf.length });
      }

      const m = matchEmailToPermit(subject, body, permitList);
      // Always stored as 'unassigned' first; only flipped to 'filed' once the note and every
      // document link succeeded. Any failure leaves it in the inbox for a person to file.
      const row = { gmail_message_id: id, thread_id: msg.threadId, from_addr: from, subject, received_at: receivedAt, body_text: body,
        attachments: stored, permit_id: null, match_reason: m.reason, status: "unassigned" };
      const { error: insErr } = await admin.from("permit_emails").insert(row);
      if (insErr) throw new Error(insErr.message);
      result.added++;
      if (!m.permitId) { result.unassigned++; continue; }

      let problem = null;
      const { error: nErr } = await admin.from("permit_notes").insert({ permit_id: m.permitId, body: noteTextForEmail(row), created_by_name: `E-mail · ${from}`.slice(0, 200) });
      if (nErr) problem = `note: ${nErr.message}`;
      for (const s of stored) {
        if (problem) break;
        const { error: dErr } = await admin.from("permit_documents").insert({ permit_id: m.permitId, path: s.path, file_name: s.name, size_bytes: s.size });
        if (dErr && dErr.code !== "23505") problem = `document ${s.name}: ${dErr.message}`;
      }
      if (problem) {
        result.unassigned++;
        result.errors.push(`${subject || id}: could not file automatically (${problem}); it is waiting in the inbox`);
        await admin.from("permit_emails").update({ match_reason: `matched a permit but filing failed (${problem}) - file it by hand` }).eq("gmail_message_id", id);
      } else {
        const { error: uErr } = await admin.from("permit_emails").update({ permit_id: m.permitId, status: "filed" }).eq("gmail_message_id", id);
        if (uErr) result.errors.push(`${subject || id}: filed but status not updated: ${uErr.message}`); else result.filed++;
      }
    } catch (e) {
      // record the failure so this message is not retried forever and cannot starve the queue
      result.failed++;
      result.errors.push(`${id}: ${e.message}`);
      await admin.from("permit_emails").upsert({ gmail_message_id: id, status: "error", match_reason: String(e.message).slice(0, 300), subject: "(could not be imported)" }, { onConflict: "gmail_message_id", ignoreDuplicates: true });
    }
  }
  return result;
}
