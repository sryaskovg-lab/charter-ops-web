import { fleetTypeKey } from "./ssim";

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


// ---------- Building blocks for agent requests (schedule, aircraft, route) ----------
export const OPERATOR_NAME = "JSC Aircompany SCAT";
export const DEFAULT_SIGNATURE = ["Stanislav Ryaskov", "Deputy Head of OCC", "JSC \"Aircompany \"SCAT\"", "Tel: 8/7252/99 88 80 (ext 206), 45 50 90", "Mob:+77713848769"].join("\n");
const TYPE_NAMES = { B39M: "B737 MAX 9", B38M: "B737 MAX 8", B738: "B737-800", B739: "B737-900", B752: "B757-200", B753: "B757-300", B763: "B767-300", A320: "A320", A20N: "A320neo", A321: "A321", A21N: "A321neo", A319: "A319", A333: "A330-300" };
export function aircraftTypesText(resources) {
  const by = new Map();
  [...resources].sort((a, b) => String(a.code).localeCompare(String(b.code))).forEach(r => {
    const k = fleetTypeKey(r.variant);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r.code);
  });
  return [...by.entries()].map(([k, codes]) => `${TYPE_NAMES[k] || k} REG. ${codes.join(" / ")}`).join("\n");
}
// IATA-style season of a period: W26 = winter starting October 2026 (Oct to Mar), S26 = summer 2026 (Apr to Sep)
export function seasonOf(fromStr, toStr) {
  const d = fromStr || toStr; if (!d) return "";
  const y = +d.slice(0, 4), m = +d.slice(5, 7);
  return m >= 10 ? `W${String(y).slice(2)}` : m <= 3 ? `W${String(y - 1).slice(2)}` : `S${String(y).slice(2)}`;
}
export function routesText(flights) {
  const pairs = new Set(flights.map(f => `${f.origin}-${f.destination}`));
  const out = [], seen = new Set();
  [...pairs].sort().forEach(p => {
    if (seen.has(p)) return;
    const [o, d] = p.split("-"); seen.add(p);
    if (pairs.has(`${d}-${o}`)) { seen.add(`${d}-${o}`); out.push(`${o}-${d}-${o}`); } else out.push(p);
  });
  return out.join(", ");
}
const dm = ds => `${ds.slice(8, 10)}.${ds.slice(5, 7)}`;
const isoDow = ds => { const w = new Date(ds + "T00:00:00Z").getUTCDay(); return w === 0 ? 7 : w; };
const dayGap = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
// Flights -> "5316  ALA-PQC  21:00  04:00  5 DAY FROM 30.10 TO 26.03" lines (times UTC, dates dd.mm).
// A weekday that repeats weekly at least 3 times becomes a period line; weekdays with the same period share a line;
// anything else is listed date by date.
export function scheduleLines(flights) {
  const groups = new Map();
  flights.forEach(f => {
    const no = String(f.ref).replace(/^[A-Za-z]{2}(?=\d)/, "");
    const dep = hhmmUtc(f.start), arr = f.arrivalAt ? hhmmUtc(f.arrivalAt) : "--:--";
    const key = `${no}|${f.origin}|${f.destination}|${dep}|${arr}`;
    if (!groups.has(key)) groups.set(key, { no, route: `${f.origin}-${f.destination}`, dep, arr, dates: new Set() });
    groups.get(key).dates.add(dayUtc(f.start));
  });
  const entries = [];
  groups.forEach(g => {
    const head = `${g.no.padEnd(6)}${g.route.padEnd(10)}${g.dep.padEnd(7)}${g.arr.padEnd(7)}`;
    const byDow = new Map();
    [...g.dates].sort().forEach(d => { const w = isoDow(d); if (!byDow.has(w)) byDow.set(w, []); byDow.get(w).push(d); });
    const periods = new Map(); // "from|to" -> weekdays
    const singles = [];
    byDow.forEach((dates, w) => {
      let run = [dates[0]];
      const flush = () => { if (run.length >= 3) { const k = `${run[0]}|${run[run.length - 1]}`; periods.set(k, [...(periods.get(k) || []), w]); } else singles.push(...run); run = []; };
      for (let i = 1; i < dates.length; i++) { if (dayGap(dates[i - 1], dates[i]) === 7) run.push(dates[i]); else { flush(); run = [dates[i]]; } }
      flush();
    });
    periods.forEach((days, k) => { const [a, b] = k.split("|"); const dd = days.sort().join(""); entries.push({ first: a, line: `${head}${dd === "1234567" ? "DAILY" : dd + " DAY"} FROM ${dm(a)} TO ${dm(b)}`.trimEnd() }); });
    singles.forEach(d => entries.push({ first: d, line: `${head}${dm(d)}.`.trimEnd() }));
  });
  return entries.sort((x, y) => x.first.localeCompare(y.first) || x.line.localeCompare(y.line)).map(e => e.line);
}

// ---------- Predefined request forms (templates) ----------
// Placeholders are written {{name}}. Unknown ones are left visible so a typo is noticed, never silently blanked.
export const TEMPLATE_VARS = [
  ["country", "Country name (e.g. Turkmenistan)"], ["state", "Country code as used in the app (e.g. TM)"],
  ["type", "Overfly or Landing"], ["permission", "overflight permission / landing permission"], ["request", "One sentence stating what is requested"],
  ["period", "Validity requested"], ["aircraft", "Aircraft registrations or 'all company aircraft'"],
  ["airports", "Landing airports (landing requests)"], ["flights", "List of planned flights, times UTC"],
  ["flight_count", "Number of flights listed"], ["routes", "Routes, e.g. ALA-PQC-ALA"], ["season", "IATA season, e.g. W26"], ["aircraft_types", "Fleet by type with registrations"], ["schedule", "Schedule table: flight, route, ETD, ETA (UTC), dates or period"], ["route_detail", "Airways by country, typed under Routes → States"], ["amendment", "Schedule changes (amendment e-mails only)"], ["authority", "Authority or agent name for the greeting"],
  ["agent", "Handling agent name"], ["operator", "Your airline name"], ["signature", "Your signature"], ["today", "Today's date (UTC)"],
];

export const BUILTIN_TEMPLATES = {
  authority: {
    subject: "{{type}} permit request – {{state}} – {{period}} – {{aircraft}}",
    body: "Dear {{authority}},\n\n{{request}}\n\nAircraft: {{aircraft}}\nValidity requested: {{period}}\n\nPlanned flights (times UTC):\n{{flights}}\n\nPlease confirm the permit number and validity at your earliest convenience.\n\nBest Regards,\n{{signature}}",
  },
  agent: {
    subject: "{{type}} permit request – {{routes}} – {{season}}",
    body: "Dear {{agent}},\n\n{{operator}} kindly request to obtain {{permission}} for {{season}} {{routes}} flights according to the request below:\n\nOn route {{routes}}\n\nType of Aircraft:\n{{aircraft_types}}\n\nSCHEDULE (times UTC)\n{{schedule}}\n\nROUTE\n{{route_detail}}\n\nPlease send us the permit numbers and validity as soon as they are issued.\n\nBest Regards,\n{{signature}}",
  },
};

export const AMENDMENT_TEMPLATE = {
  subject: "{{type}} permit request – AMENDMENT – {{routes}} – {{season}}",
  body: "Dear {{authority}},\n\nFurther to our previous request, please note the following changes to our schedule for {{routes}}:\n\n{{amendment}}\n\nPlease confirm that the permits cover the amended schedule and send us any additional permit numbers or validity.\n\nBest Regards,\n{{signature}}",
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
export function requestVars({ state, country, kind = "overfly", airports = [], validFrom, validTo, aircraft = [], flights = [], authority, agent, operator = OPERATOR_NAME, signature, today, fleet = [], routeDetail = "" }) {
  const st = String(state || "").toUpperCase();
  const where = country || st;
  const period = validFrom && validTo ? `${validFrom} to ${validTo}` : validFrom ? `from ${validFrom}` : validTo ? `until ${validTo}` : "(dates to be confirmed)";
  const request = kind === "landing"
    ? `${operator || "We"} kindly request landing permission in ${where}${airports.length ? ` (${airports.join(", ")})` : ""} for the following operations.`
    : `${operator || "We"} kindly request overfly permission for the airspace of ${where} for the following operations.`;
  const lines = flights.slice(0, 200).map(f => `  ${dayUtc(f.start)}  ${hhmmUtc(f.start)}  ${f.ref}  ${f.origin}-${f.destination}${f.aircraft ? `  ${f.aircraft}` : ""}`);
  if (flights.length > 200) lines.push(`  … and ${flights.length - 200} more`);
  return {
    country: where, state: st, type: kind === "landing" ? "Landing" : "Overfly", permission: kind === "landing" ? "landing permission" : "overflight permission", request, period,
    aircraft: aircraft.length ? aircraft.join(", ") : "all company aircraft", airports: airports.join(", "),
    flights: lines.length ? lines.join("\n") : "  (to be confirmed)", flight_count: flights.length,
    routes: routesText(flights) || "(to be confirmed)", season: seasonOf(validFrom, validTo), aircraft_types: aircraft.length || !fleet.length ? (aircraft.length ? aircraft.join(", ") : "all company aircraft") : aircraftTypesText(fleet),
    schedule: scheduleLines(flights).join("\n") || "(to be confirmed)", route_detail: routeDetail || "(route to be confirmed)",
    authority: authority || agent || "Sir / Madam", agent: agent || "", operator: operator || "", signature: signature || DEFAULT_SIGNATURE, today: today || new Date().toISOString().slice(0, 10),
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
