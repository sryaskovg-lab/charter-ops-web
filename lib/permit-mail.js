// ---------- permit-mail ----------
// Pure helpers for turning Gmail API messages into inbox rows and for matching an e-mail to a
// permit. No network, no Supabase: testable on its own.

export function decodeB64Url(data) {
  if (!data) return "";
  return Buffer.from(String(data).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export function headerOf(payload, name) {
  const h = (payload?.headers || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
}

function walk(part, fn) { if (!part) return; fn(part); (part.parts || []).forEach(p => walk(p, fn)); }

// Plain-text body (preferred) or tags-stripped HTML, truncated.
export function extractText(payload, maxChars = 20000) {
  let plain = "", html = "";
  walk(payload, p => {
    if (p.filename) return;
    if (p.mimeType === "text/plain" && p.body?.data) plain += decodeB64Url(p.body.data) + "\n";
    else if (p.mimeType === "text/html" && p.body?.data) html += decodeB64Url(p.body.data) + "\n";
  });
  const text = (plain.trim() || htmlToText(html)).trim();
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text;
}

const ALLOWED_EXT = /\.(pdf|png|jpe?g|docx?|xlsx?|txt|eml)$/i;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Attachments we are willing to store: allowed types, <= 10 MB.
export function listAttachments(payload) {
  const out = [];
  walk(payload, p => {
    if (p.filename && p.body?.attachmentId && ALLOWED_EXT.test(p.filename) && (p.body.size || 0) <= MAX_ATTACHMENT_BYTES) {
      out.push({ name: p.filename, attachmentId: p.body.attachmentId, size: p.body.size || 0 });
    }
  });
  return out;
}

export function safeFileName(name) { return String(name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 120); }

const norm = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// A reference only counts if it is long enough and contains a digit, so a stray "TM" or "2026"
// cannot match everything.
function usableKey(s) { const n = norm(s); return n.length >= 5 && /\d/.test(n) ? n : null; }

// permits: [{ id, state, status, permitNumber, authorityRef }]
// -> { permitId, reason }   permitId is null when nothing (or more than one permit) matches.
export function matchEmailToPermit(subject, body, permits) {
  const hay = norm(`${subject}\n${body}`);
  const hits = new Map();
  (permits || []).forEach(p => {
    if (p.status === "cancelled") return;
    [["permit number", p.permitNumber], ["reference", p.authorityRef]].forEach(([label, v]) => {
      const key = usableKey(v);
      if (key && hay.includes(key) && !hits.has(p.id)) hits.set(p.id, `${label} ${v} found`);
    });
  });
  if (hits.size === 1) { const [[permitId, reason]] = [...hits.entries()]; return { permitId, reason }; }
  if (hits.size > 1) return { permitId: null, reason: "ambiguous: matches several permits" };
  return { permitId: null, reason: "no permit number or reference found" };
}

export function noteTextForEmail({ from_addr, subject, received_at, body_text }) {
  const head = `E-mail from ${from_addr || "unknown"}${received_at ? ` · ${new Date(received_at).toISOString().slice(0, 16).replace("T", " ")}Z` : ""}\nSubject: ${subject || "(no subject)"}\n(filed from the mailbox — sender not verified)\n\n`;
  const body = String(body_text || "");
  return head + (body.length > 3000 ? body.slice(0, 3000) + "\n…[see Inbox for the full text]" : body);
}
