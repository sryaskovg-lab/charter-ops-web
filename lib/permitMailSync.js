import { getSupabaseAdmin } from "./supabaseAdmin";
import { headerOf, extractText, listAttachments, safeFileName, matchEmailToPermit, noteTextForEmail } from "./permit-mail";

// Server-only. Reads (never changes) the Gmail messages that carry the configured label and files
// them: matched to a permit -> note + documents on that permit; otherwise -> Inbox for a person.
// Uses Gmail's REST API with a long-lived refresh token (scope gmail.readonly), no extra packages.
const MAX_NEW_PER_RUN = 25;

async function accessToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}. The refresh token may have expired or been revoked.`);
  return j.access_token;
}

async function gmail(token, path) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail error (${res.status}): ${j.error?.message || "unknown"}`);
  return j;
}

export function mailConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

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

  const result = { configured: true, found: ids.length, added: 0, filed: 0, unassigned: 0, remaining: Math.max(0, fresh.length - batch.length), errors: [] };
  for (const id of batch) {
    try {
      const msg = await gmail(token, `messages/${id}?format=full`);
      const payload = msg.payload || {};
      const subject = headerOf(payload, "Subject");
      const from = headerOf(payload, "From");
      const receivedAt = msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null;
      const body = extractText(payload);

      const stored = [];
      for (const a of listAttachments(payload)) {
        const att = await gmail(token, `messages/${id}/attachments/${a.attachmentId}`);
        const buf = Buffer.from(String(att.data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
        const path = `mail/${id}/${safeFileName(a.name)}`;
        const up = await admin.storage.from("permit-docs").upload(path, buf, { upsert: true });
        if (up.error) { result.errors.push(`${a.name}: ${up.error.message}`); continue; }
        stored.push({ name: a.name, path, size: buf.length });
      }

      const m = matchEmailToPermit(subject, body, permitList);
      const row = { gmail_message_id: id, thread_id: msg.threadId, from_addr: from, subject, received_at: receivedAt, body_text: body,
        attachments: stored, permit_id: m.permitId, match_reason: m.reason, status: m.permitId ? "filed" : "unassigned" };
      const { error: insErr } = await admin.from("permit_emails").insert(row);
      if (insErr) { result.errors.push(`${subject || id}: ${insErr.message}`); continue; }
      result.added++;
      if (m.permitId) {
        result.filed++;
        const { error: nErr } = await admin.from("permit_notes").insert({ permit_id: m.permitId, body: noteTextForEmail(row), created_by_name: `E-mail · ${from}`.slice(0, 200) });
        if (nErr) result.errors.push(`note: ${nErr.message}`);
        for (const s of stored) {
          const { error: dErr } = await admin.from("permit_documents").insert({ permit_id: m.permitId, path: s.path, file_name: s.name, size_bytes: s.size });
          if (dErr) result.errors.push(`document ${s.name}: ${dErr.message}`);
        }
      } else result.unassigned++;
    } catch (e) {
      result.errors.push(`${id}: ${e.message}`);
    }
  }
  return result;
}
