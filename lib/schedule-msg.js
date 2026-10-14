// IATA SSM / ASM (AIRIMP) schedule messages: NEW, CNL, TIM, RPL, EQT ... as plain text.
// The format varies between senders, so the reader is tolerant and everything it understands is
// shown for confirmation before anything changes. What it cannot interpret is listed as such.
import { minToHHMM, looksLikeSsim, parseSsim } from "./ssim.js";

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const ACTIONS = ["NEW", "CNL", "RPL", "TIM", "EQT", "CON", "RIN", "RRT", "REV", "FLT", "ADM", "SKD", "ACK", "NAC", "RSD", "ADD"];
export const APPLIES = new Set(["NEW", "CNL", "TIM"]); // the ones this app can carry out
const ACTION_RE = new RegExp(`^(${ACTIONS.join("|")})\\b`);
const DATE_RE = /^(\d{1,2})([A-Z]{3})(\d{2})?$/;
const FLIGHT_RE = /^([A-Z0-9]{2})\s*(\d{1,4})([A-Z])?(?:\/(.+))?$/;
const LEG_RE = /([A-Z]{3})\s?(\d{4})(?:\/(\d|[A-Z]))?\s+([A-Z]{3})\s?(\d{4})(?:\/(\d|[A-Z]))?/;
const AIRCRAFT_RE = /^([A-Z])\s+([A-Z0-9]{3,4})(?:\s+(\S+))?$/;

export function detectKind(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim());
  const i = lines.findIndex(l => /^(ASM|SSM)\b/.test(l.toUpperCase()));
  return i < 0 ? null : lines[i].toUpperCase().slice(0, 3).toLowerCase();
}

// "20OCT" / "20OCT26" -> Date (UTC midnight). Without a year, the nearest sensible one to `ref`.
export function resolveDate(token, ref) {
  const m = DATE_RE.exec(String(token || "").toUpperCase());
  if (!m || MONTHS[m[2]] === undefined) return null;
  const day = Number(m[1]), mon = MONTHS[m[2]];
  let y = m[3] ? 2000 + Number(m[3]) : (ref || new Date()).getUTCFullYear();
  let d = new Date(Date.UTC(y, mon, day));
  if (d.getUTCDate() !== day) return null;
  if (!m[3] && ref && d.getTime() < ref.getTime() - 60 * 86400000) d = new Date(Date.UTC(y + 1, mon, day));
  return d;
}
const hhmm = s => `${s.slice(0, 2)}:${s.slice(2, 4)}`;
const validTime = s => Number(s.slice(0, 2)) < 24 && Number(s.slice(2, 4)) < 60;

// text -> { kind, timeMode, reference, items, warnings } or null when it is not an SSM/ASM
export function parseScheduleMessage(text, opts = {}) {
  const ref = opts.today || new Date();
  const all = String(text || "").replace(/\r/g, "").split("\n").map(l => l.trim());
  const start = all.findIndex(l => /^(ASM|SSM)\b/.test(l.toUpperCase()));
  if (start < 0) return null;
  const kind = all[start].toUpperCase().slice(0, 3).toLowerCase();
  const out = { kind, timeMode: null, reference: [], items: [], warnings: [] };
  let action = null, cur = null, sawAction = false;

  const finish = () => { if (cur) { out.items.push(cur); cur = null; } };
  for (let i = start + 1; i < all.length; i++) {
    const line = all[i].toUpperCase().replace(/\s+/g, " ").trim();
    if (!line) { if (kind === "ssm") finish(); continue; }
    if (line === "NNNN" || line === "=" || line === "//") { finish(); if (line === "NNNN") break; continue; }
    if (line === "UTC" || line === "LT") { out.timeMode = line; continue; }
    const act = ACTION_RE.exec(line);
    if (act) { finish(); action = act[1]; sawAction = true; continue; }
    if (!sawAction) { out.reference.push(line); continue; }
    if (/^(SI|GI|REJECT)\b/.test(line) || line.startsWith("//")) { if (cur) cur.notes.push(line); continue; }

    // flight line, optionally followed on the same line by dates and days
    const toks = line.split(" ");
    let head = toks[0];
    if (toks.length > 1 && /^[A-Z0-9]{2}$/.test(toks[0]) && /^\d{1,4}[A-Z]?(\/.*)?$/.test(toks[1]) && !LEG_RE.test(line) && !AIRCRAFT_RE.test(line)) { head = toks[0] + toks[1]; toks.splice(0, 2, head); }
    const fm = FLIGHT_RE.exec(head);
    if (fm && !LEG_RE.test(line) && !(toks.length === 2 && AIRCRAFT_RE.test(line))) {
      finish();
      cur = { action, airline: fm[1], flightNo: String(Number(fm[2])), suffix: fm[3] || "", dateFrom: null, dateTo: null, days: null, legs: [], aircraftType: "", serviceType: "", notes: [], raw: [line] };
      const rest = [];
      if (fm[4]) { const d = resolveDate(fm[4].split("/")[0], ref); if (d) { cur.dateFrom = d; cur.dateTo = d; } }
      toks.slice(1).forEach(t => rest.push(t));
      applyPeriodTokens(cur, rest, ref);
      continue;
    }
    if (!cur) { out.warnings.push(`Could not read: "${line}"`); continue; }
    cur.raw.push(line);
    const lm = LEG_RE.exec(line);
    if (lm && validTime(lm[2]) && validTime(lm[5])) { cur.legs.push({ origin: lm[1], depTime: hhmm(lm[2]), destination: lm[4], arrTime: hhmm(lm[5]) }); continue; }
    const am = AIRCRAFT_RE.exec(line);
    if (am) { cur.serviceType = am[1]; cur.aircraftType = am[2]; continue; }
    if (applyPeriodTokens(cur, line.split(" "), ref)) continue;
    cur.notes.push(line);
  }
  finish();
  if (!out.items.length) out.warnings.push("No flights found in this message.");
  if (out.timeMode === "LT" && out.items.some(i => APPLIES.has(i.action))) out.warnings.push("This message uses local times (LT). Times cannot be converted without each airport's UTC offset, so it cannot be applied here. Ask the sender for UTC, or enter the changes by hand.");
  return out;
}

// dates ("20OCT26 24OCT26") and days ("246") from a token list; returns true if it used any
function applyPeriodTokens(item, toks, ref) {
  let used = false;
  const dates = [];
  toks.forEach(t => {
    const piece = t.replace(/\/$/, "");
    if (DATE_RE.test(piece)) { const d = resolveDate(piece, ref); if (d) { dates.push(d); used = true; } }
    else if (/^[1-7X]{1,7}$/.test(piece) && (dates.length || item.dateFrom)) { item.days = new Set([...piece].filter(c => /[1-7]/.test(c)).map(Number)); used = true; }
  });
  if (dates.length) { item.dateFrom = dates[0]; item.dateTo = dates[1] || dates[0]; if (item.dateTo < item.dateFrom) item.dateTo = new Date(Date.UTC(item.dateTo.getUTCFullYear() + 1, item.dateTo.getUTCMonth(), item.dateTo.getUTCDate())); }
  return used;
}

// An item's operating dates (UTC), capped.
export function itemDates(item, cap = 800) {
  if (!item.dateFrom) return [];
  const out = [];
  for (let t = item.dateFrom.getTime(); t <= item.dateTo.getTime() && out.length < cap; t += 86400000) {
    const d = new Date(t);
    if (item.days && !item.days.has(d.getUTCDay() || 7)) continue;
    out.push(d);
  }
  return out;
}

const dayStr = d => d.toISOString().slice(0, 10);
const digitsOf = ref => String(ref || "").replace(/\D/g, "").replace(/^0+/, "");

// Rows to create (from an SSIM file or a NEW message) -> the same rows with duplicateOf set when
// a live flight with that number, date and route is already in the schedule.
export function markDuplicates(rows, flights) {
  const live = (flights || []).filter(f => f.status !== "cancelled");
  return rows.map(r => {
    const dup = live.find(f => digitsOf(f.ref) === String(r.flightNo) && dayStr(f.start) === dayStr(r.date) && String(f.origin).toUpperCase() === r.origin && String(f.destination).toUpperCase() === r.destination);
    return { ...r, duplicateOf: dup ? dup.ref : null };
  });
}

// Turns parsed items into things to do against the flights already in the schedule.
//   flights: [{ id, ref, origin, destination, start: Date, depTime, arrTime, status }]
//   Returns { create: [row], cancel: [..], retime: [..], manual: [..], notes: [..] }
export function planScheduleChanges(items, flights, opts = {}) {
  const plan = { create: [], cancel: [], retime: [], manual: [], notes: [] };
  const live = (flights || []).filter(f => f.status !== "cancelled");
  const find = (item, d, leg) => live.filter(f => digitsOf(f.ref) === item.flightNo && dayStr(f.start) === dayStr(d) && (!leg || !leg.origin || String(f.origin).toUpperCase() === leg.origin));
  for (const item of items) {
    const label = `${item.airline}${item.flightNo}${item.suffix || ""}`;
    const dates = itemDates(item);
    if (opts.airlines && opts.airlines.length && !opts.airlines.map(a => a.toUpperCase()).includes(item.airline)) { plan.notes.push(`${label}: another airline, ignored.`); continue; }
    if (!APPLIES.has(item.action)) { plan.manual.push({ action: item.action, label, text: item.raw.join(" / ") }); continue; }
    if (!dates.length) { plan.manual.push({ action: item.action, label, text: `no readable date: ${item.raw.join(" / ")}` }); continue; }
    if (item.action === "NEW") {
      if (!item.legs.length) { plan.manual.push({ action: "NEW", label, text: "no route and times found" }); continue; }
      for (const d of dates) for (const leg of item.legs) {
        const dep = leg.depTime.split(":").map(Number), arr = leg.arrTime.split(":").map(Number);
        const dur = (((arr[0] * 60 + arr[1]) - (dep[0] * 60 + dep[1])) % 1440 + 1440) % 1440;
        const dup = find(item, d, leg).find(f => String(f.destination).toUpperCase() === leg.destination);
        plan.create.push({ date: d, airline: item.airline, flightNo: item.flightNo, origin: leg.origin, destination: leg.destination, depTime: leg.depTime, arrTime: leg.arrTime, durationMin: dur, aircraftType: item.aircraftType, serviceType: item.serviceType, legType: item.serviceType === "P" ? "ferry" : "revenue", duplicateOf: dup ? dup.ref : null });
      }
    } else if (item.action === "CNL") {
      for (const d of dates) {
        const hit = find(item, d, item.legs[0]);
        if (hit.length) hit.forEach(f => plan.cancel.push({ flightId: f.id, ref: f.ref, date: dayStr(d), origin: f.origin, destination: f.destination, label }));
        else plan.notes.push(`${label} ${dayStr(d)}: cancellation, but no such flight in the schedule.`);
      }
    } else if (item.action === "TIM") {
      if (!item.legs.length) { plan.manual.push({ action: "TIM", label, text: "no new times found" }); continue; }
      for (const d of dates) for (const leg of item.legs) {
        const hit = find(item, d, leg);
        if (!hit.length) { plan.notes.push(`${label} ${dayStr(d)} ${leg.origin}: time change, but no such flight in the schedule.`); continue; }
        hit.forEach(f => {
          const same = f.depTime === leg.depTime && f.arrTime === leg.arrTime;
          if (!same) plan.retime.push({ flightId: f.id, ref: f.ref, date: dayStr(d), origin: f.origin, destination: f.destination, from: { dep: f.depTime, arr: f.arrTime }, to: { dep: leg.depTime, arr: leg.arrTime }, label });
        });
      }
    }
  }
  return plan;
}

// Compares the flights expanded from an SSIM file with the schedule already in the system.
//   rows:    expandLegs(...).rows (already limited to the airlines wanted)
//   flights: [{ id, ref, origin, destination, start: Date, depTime, arrTime, status, legType }]
//   opts:    { airlines: ["DV"], fromDate, toDate (Date, UTC midnight, the period the file covers),
//              today (Date), allotted: Set of flight ids that have live allotments }
// Returns { create, retime, missing, changed, scope } where
//   create  = rows with no flight in the system (duplicateOf is always null)
//   retime  = flights whose departure or arrival time differs from the file
//   changed = flights found by number and date whose route differs (never changed automatically)
//   missing = flights in the system for the same airline and period that the file does not contain
//             (proposed for cancellation; only future, not yet operating, revenue legs)
export function planSsimSync(rows, flights, opts = {}) {
  const out = { create: [], retime: [], changed: [], missing: [], scope: null };
  const airlines = (opts.airlines || []).map(a => a.toUpperCase());
  const live = (flights || []).filter(f => f.status !== "cancelled");
  const today = opts.today ? dayStr(opts.today) : null;
  const allotted = opts.allotted || new Set();
  const key = (no, d, o) => `${no}|${dayStr(d)}|${String(o).toUpperCase()}`;
  const fileKeys = new Set(rows.map(r => key(r.flightNo, r.date, r.origin)));
  const fileNos = new Set(rows.map(r => String(r.flightNo)));
  const airlinesInRows = [...new Set(rows.map(r => r.airline))];
  const scopeAirlines = airlines.length ? airlines : airlinesInRows;
  let from = opts.fromDate || null, to = opts.toDate || null;
  for (const r of rows) { if (!opts.fromDate && (!from || r.date < from)) from = r.date; if (!opts.toDate && (!to || r.date > to)) to = r.date; }
  out.scope = { airlines: scopeAirlines, from, to };

  // New / retimed / changed route
  for (const r of rows) {
    const same = live.filter(f => digitsOf(f.ref) === String(r.flightNo) && dayStr(f.start) === dayStr(r.date));
    if (!same.length) { out.create.push({ ...r, duplicateOf: null }); continue; }
    const exact = same.find(f => String(f.origin).toUpperCase() === r.origin && String(f.destination).toUpperCase() === r.destination);
    if (exact) {
      if (exact.depTime !== r.depTime || exact.arrTime !== r.arrTime) out.retime.push({ flightId: exact.id, ref: exact.ref, date: dayStr(r.date), origin: exact.origin, destination: exact.destination, from: { dep: exact.depTime, arr: exact.arrTime }, to: { dep: r.depTime, arr: r.arrTime }, label: `${r.airline}${r.flightNo}`, allotted: allotted.has(exact.id) });
      continue;
    }
    // same number and day, but another route: if some other flight with the same origin exists, report; otherwise treat as a second leg
    // the same number departing at the same minute can only be the same flight on another route (the database allows one flight per number and departure time)
    const sameOrigin = same.find(f => String(f.origin).toUpperCase() === r.origin) || same.find(f => f.depTime === r.depTime);
    if (sameOrigin) out.changed.push({ flightId: sameOrigin.id, ref: sameOrigin.ref, date: dayStr(r.date), inSystem: `${sameOrigin.origin}–${sameOrigin.destination}`, inFile: `${r.origin}–${r.destination}` });
    else out.create.push({ ...r, duplicateOf: null });
  }

  // In the system but not in the file
  if (from && to) {
    const fromS = dayStr(from), toS = dayStr(to);
    for (const f of live) {
      const m = /^([A-Za-z]{2,3})\s*0*(\d+)/.exec(String(f.ref || ""));
      if (!m) continue;
      const code = m[1].toUpperCase();
      if (!scopeAirlines.includes(code)) continue;
      const ds = dayStr(f.start);
      if (ds < fromS || ds > toS) continue;
      if (today && ds < today) continue;
      if (!["tentative", "confirmed"].includes(f.status)) continue;
      if (f.legType && f.legType !== "revenue") continue; // positioning legs are not normally in the schedule file
      if (fileKeys.has(key(m[2], f.start, f.origin))) continue;
      out.missing.push({ flightId: f.id, ref: f.ref, date: ds, origin: f.origin, destination: f.destination, depTime: f.depTime, flightNumberInFile: fileNos.has(m[2]), allotted: allotted.has(f.id) });
    }
    out.missing.sort((a, b) => (a.date + a.depTime).localeCompare(b.date + b.depTime));
  }
  return out;
}

// text -> { kind, summary } or null when it is not a schedule message
export function describeScheduleText(text) {
  if (looksLikeSsim(text)) {
    const r = parseSsim(text, { forceUtc: true });
    const airlines = [...new Set(r.legs.map(l => l.airline))].join(", ");
    return { kind: "ssim", summary: `${r.legs.length} flight legs${airlines ? ` (${airlines})` : ""}${r.warnings.length ? `, ${r.warnings.length} not readable` : ""}` };
  }
  const kind = detectKind(text);
  if (!kind) return null;
  const r = parseScheduleMessage(text);
  const count = {};
  (r?.items || []).forEach(i => { count[i.action] = (count[i.action] || 0) + 1; });
  const parts = Object.entries(count).map(([a, n]) => `${a} ${n}`);
  return { kind, summary: parts.length ? parts.join(", ") : "no readable actions" };
}

