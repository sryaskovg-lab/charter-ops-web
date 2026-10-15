// Pure helpers for permit e-mails: the request to an authority, the daily alert, and the raw
// MIME message Gmail's API wants. No React / Supabase so they can be unit-tested.

export function extractEmails(text) {
  return [...new Set((String(text || "").match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || []).map(e => e.toLowerCase()))];
}

const hhmmUtc = d => new Date(d).toISOString().slice(11, 16);
const dayUtc = d => new Date(d).toISOString().slice(0, 10);

// flights: [{ ref, origin, destination, start(Date) , aircraft }]
export function buildRequestEmail({ state, kind = "overfly", airports = [], validFrom, validTo, aircraft = [], flights = [], authority, operator, signature }) {
  const ac = aircraft.length ? aircraft.join(", ") : "all company aircraft";
  const period = validFrom && validTo ? `${validFrom} to ${validTo}` : validFrom ? `from ${validFrom}` : validTo ? `until ${validTo}` : "(dates to be confirmed)";
  const what = kind === "landing" ? "Landing" : "Overfly";
  const subject = `${what} permit request – ${String(state).toUpperCase()} – ${period} – ${aircraft.length ? aircraft.join(", ") : "all aircraft"}`;
  const lines = [];
  lines.push(authority ? `Dear ${authority},` : "Dear Sir / Madam,", "");
  lines.push(`${operator || "We"} kindly request ${kind === "landing" ? `landing permission in ${String(state).toUpperCase()}${airports.length ? ` (${airports.join(", ")})` : ""}` : `overfly permission for the airspace of ${String(state).toUpperCase()}`} for the following operations.`, "");
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

// ---------- Predefined request forms (templates) ----------
// Placeholders are written {{name}}. Unknown ones are left visible so a typo is noticed, never silently blanked.
export const TEMPLATE_VARS = [
  ["country", "Country name (e.g. Turkmenistan)"], ["state", "Country code as used in the app (e.g. TM)"],
  ["type", "Overfly or Landing"], ["request", "One sentence stating what is requested"],
  ["period", "Validity requested"], ["aircraft", "Aircraft registrations or 'all company aircraft'"],
  ["airports", "Landing airports (landing requests)"], ["flights", "List of planned flights, times UTC"],
  ["flight_count", "Number of flights listed"], ["authority", "Authority or agent name for the greeting"],
  ["agent", "Handling agent name"], ["operator", "Your airline name"], ["signature", "Your signature"], ["today", "Today's date (UTC)"],
];

export const BUILTIN_TEMPLATES = {
  authority: {
    subject: "{{type}} permit request – {{state}} – {{period}} – {{aircraft}}",
    body: "Dear {{authority}},\n\n{{request}}\n\nAircraft: {{aircraft}}\nValidity requested: {{period}}\n\nPlanned flights (times UTC):\n{{flights}}\n\nPlease confirm the permit number and validity at your earliest convenience.\n\nBest regards,\n{{signature}}",
  },
  agent: {
    subject: "{{type}} permit request – {{country}} ({{state}}) – {{period}} – {{aircraft}}",
    body: "Dear {{agent}},\n\nPlease obtain the following permit for us from the authorities of {{country}}.\n\n{{request}}\n\nAircraft: {{aircraft}}\nValidity requested: {{period}}\n\nPlanned flights (times UTC):\n{{flights}}\n\nPlease send us the permit number and validity as soon as they are issued, together with your quotation if any fees apply.\n\nBest regards,\n{{signature}}",
  },
};

export function renderTemplate(text, vars) {
  return String(text || "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => {
    const key = k.toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : m;
  });
}
export function unknownPlaceholders(text) {
  const known = new Set(TEMPLATE_VARS.map(v => v[0]));
  return [...new Set([...String(text || "").matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map(m => m[1].toLowerCase()))].filter(k => !known.has(k));
}

// Which form applies. A form saved for the country wins; otherwise the agent's own form (agent channel) or the
// general form (direct channel); otherwise the built-in wording. templates: rows of permit_templates.
export function pickTemplate({ templates = [], state, agentId, kind = "overfly", channel = "authority" }) {
  const st = String(state || "").trim().toUpperCase();
  const byKind = templates.filter(t => (t.kind || "overfly") === kind);
  const own = byKind.find(t => t.scope === "state" && String(t.state || "").toUpperCase() === st);
  if (own) return { subject: own.subject, body: own.body, source: `form for ${st}` };
  if (channel === "agent" && agentId) {
    const a = byKind.find(t => t.scope === "agent" && t.agent_id === agentId);
    if (a) return { subject: a.subject, body: a.body, source: "agent's form" };
  }
  if (channel !== "agent") {
    const d = byKind.find(t => t.scope === "default");
    if (d) return { subject: d.subject, body: d.body, source: "general form" };
  }
  const b = BUILTIN_TEMPLATES[channel === "agent" ? "agent" : "authority"];
  return { subject: b.subject, body: b.body, source: "built-in form" };
}

// flights: [{ ref, origin, destination, start(Date), aircraft }]
export function requestVars({ state, country, kind = "overfly", airports = [], validFrom, validTo, aircraft = [], flights = [], authority, agent, operator, signature, today }) {
  const st = String(state || "").toUpperCase();
  const where = country || st;
  const period = validFrom && validTo ? `${validFrom} to ${validTo}` : validFrom ? `from ${validFrom}` : validTo ? `until ${validTo}` : "(dates to be confirmed)";
  const request = kind === "landing"
    ? `${operator || "We"} kindly request landing permission in ${where}${airports.length ? ` (${airports.join(", ")})` : ""} for the following operations.`
    : `${operator || "We"} kindly request overfly permission for the airspace of ${where} for the following operations.`;
  const lines = flights.slice(0, 200).map(f => `  ${dayUtc(f.start)}  ${hhmmUtc(f.start)}  ${f.ref}  ${f.origin}-${f.destination}${f.aircraft ? `  ${f.aircraft}` : ""}`);
  if (flights.length > 200) lines.push(`  … and ${flights.length - 200} more`);
  return {
    country: where, state: st, type: kind === "landing" ? "Landing" : "Overfly", request, period,
    aircraft: aircraft.length ? aircraft.join(", ") : "all company aircraft", airports: airports.join(", "),
    flights: lines.length ? lines.join("\n") : "  (to be confirmed)", flight_count: flights.length,
    authority: authority || agent || "Sir / Madam", agent: agent || "", operator: operator || "", signature: signature || operator || "", today: today || new Date().toISOString().slice(0, 10),
  };
}
export function buildFromTemplate(tpl, vars) {
  return { subject: renderTemplate(tpl.subject, vars).replace(/\s+/g, " ").trim(), body: renderTemplate(tpl.body, vars).trim() + "\n" };
}

export function buildAlertEmail({ uncovered, unmapped, todayStr, days, codeOf = id => id }) {
  const n = uncovered.length + unmapped.length;
  const subject = `PERMIT ALERT ${todayStr}: ${uncovered.length} flight/State pair(s) in the next ${days} days without an approved permit`;
  const lines = [`Flights departing within ${days} days (UTC) that lack an approved overfly permit.`, ""];
  if (uncovered.length) {
    lines.push("NO APPROVED PERMIT:");
    uncovered.forEach(u => lines.push(`  ${u.day} ${hhmmUtc(u.start)}Z  ${u.ref}  ${u.origin}-${u.destination}  ${codeOf(u.resourceId)}  ${u.state}${u.kind === "landing" ? " (landing)" : ""}: ${u.text}`));
    lines.push("");
  }
  if (unmapped.length) {
    lines.push("CANNOT BE CHECKED (route or airport not mapped to a State):");
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
