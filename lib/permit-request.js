// Pure helpers for permit e-mails: the request to an authority, the daily alert, and the raw
// MIME message Gmail's API wants. No React / Supabase so they can be unit-tested.

export function extractEmails(text) {
  return [...new Set((String(text || "").match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []).map(e => e.toLowerCase()))];
}

const hhmmUtc = d => new Date(d).toISOString().slice(11, 16);
const dayUtc = d => new Date(d).toISOString().slice(0, 10);

// flights: [{ ref, origin, destination, start(Date) , aircraft }]
export function buildRequestEmail({ state, validFrom, validTo, aircraft = [], flights = [], authority, operator, signature }) {
  const ac = aircraft.length ? aircraft.join(", ") : "all company aircraft";
  const period = validFrom && validTo ? `${validFrom} to ${validTo}` : validFrom ? `from ${validFrom}` : validTo ? `until ${validTo}` : "(dates to be confirmed)";
  const subject = `Overfly permit request – ${String(state).toUpperCase()} – ${period} – ${aircraft.length ? aircraft.join(", ") : "all aircraft"}`;
  const lines = [];
  lines.push(authority ? `Dear ${authority},` : "Dear Sir / Madam,", "");
  lines.push(`${operator || "We"} kindly request overfly permission for the airspace of ${String(state).toUpperCase()} for the following operations.`, "");
  lines.push(`Aircraft: ${ac}`, `Validity requested: ${period}`, "");
  if (flights.length) {
    lines.push("Planned flights (times UTC):");
    flights.slice(0, 200).forEach(f => lines.push(`  ${dayUtc(f.start)}  ${hhmmUtc(f.start)}  ${f.ref}  ${f.origin}-${f.destination}${f.aircraft ? `  ${f.aircraft}` : ""}`));
    if (flights.length > 200) lines.push(`  … and ${flights.length - 200} more`);
    lines.push("");
  }
  lines.push("Please confirm the permit number and validity at your earliest convenience.", "", "Best regards,", signature || operator || "");
  return { subject, body: lines.join("\n").trim() + "\n" };
}

export function buildAlertEmail({ uncovered, unmapped, todayStr, days, codeOf = id => id }) {
  const n = uncovered.length + unmapped.length;
  const subject = `PERMIT ALERT ${todayStr}: ${uncovered.length} flight/State pair(s) in the next ${days} days without an approved permit`;
  const lines = [`Flights departing within ${days} days (UTC) that lack an approved overfly permit.`, ""];
  if (uncovered.length) {
    lines.push("NO APPROVED PERMIT:");
    uncovered.forEach(u => lines.push(`  ${u.day} ${hhmmUtc(u.start)}Z  ${u.ref}  ${u.origin}-${u.destination}  ${codeOf(u.resourceId)}  ${u.state}: ${u.text}`));
    lines.push("");
  }
  if (unmapped.length) {
    lines.push("ROUTE NOT MAPPED TO STATES (cannot be checked):");
    unmapped.forEach(u => lines.push(`  ${u.day} ${hhmmUtc(u.start)}Z  ${u.ref}  ${u.origin}-${u.destination}  ${codeOf(u.resourceId)}`));
    lines.push("");
  }
  lines.push("Open the Permits tab in Charter Ops to request or chase these.");
  return { subject, body: lines.join("\n") + "\n", count: n };
}

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const b64url = buf => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cleanHeader = s => String(s || "").replace(/[\r\n]+/g, " ").trim(); // blocks header injection
const encWord = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

// Returns the base64url "raw" string for Gmail drafts.create / messages.send
export function buildRawMime({ to = [], cc = [], subject, text }) {
  const head = [
    to.length ? `To: ${to.map(cleanHeader).join(", ")}` : null,
    cc.length ? `Cc: ${cc.map(cleanHeader).join(", ")}` : null,
    `Subject: ${encWord(cleanHeader(subject))}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ].filter(Boolean).join("\r\n");
  const body = (b64(String(text || "")).match(/.{1,76}/g) || []).join("\r\n");
  return b64url(Buffer.from(`${head}\r\n\r\n${body}\r\n`, "utf8"));
}
