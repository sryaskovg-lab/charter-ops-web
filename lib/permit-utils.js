// ---------- permit-utils ----------
// Pure logic for overfly permits, kept out of CharterOpsApp.jsx so it can be tested without
// React or Supabase. Dates are plain "YYYY-MM-DD" strings compared as UTC calendar days, the
// same day boundary the rest of the schedule uses.
//
// Model: each route (origin-destination, either direction) lists the States it overflies.
// A flight needs, for every one of those States, an APPROVED permit that covers its UTC
// departure day and its aircraft (a permit with no aircraft listed covers every aircraft).

export const PERMIT_STATUSES = ["draft", "submitted", "approved", "rejected", "cancelled"];
export const DEFAULT_LEAD_DAYS = 10;
export const ALERT_DAYS = 4; // flights this close (or closer) without an approved permit raise an alert
const EXPIRY_WARN_DAYS = 30;
const CHASE_AFTER_DAYS = 7;

export function normState(s) { return String(s || "").trim().toUpperCase(); }

// "tm, uz  kz;kg" -> ["TM","UZ","KZ","KG"] (de-duplicated, order kept)
export function parseStates(text) {
  const out = [];
  String(text || "").split(/[\s,;]+/).map(normState).filter(Boolean).forEach(s => { if (!out.includes(s)) out.push(s); });
  return out;
}

function routeKey(o, d) { return `${String(o || "").trim().toUpperCase()}-${String(d || "").trim().toUpperCase()}`; }

// rows: [{ origin, destination, states: [...] }] -> Map("ALA-DMB" -> ["TM", ...])
export function buildRouteMap(rows) {
  const m = new Map();
  (rows || []).forEach(r => m.set(routeKey(r.origin, r.destination), (r.states || []).map(normState)));
  return m;
}

// States a flight overflies, or null when the route has never been mapped (unknown, NOT "none").
export function routeStatesFor(routeMap, origin, destination) {
  return routeMap.get(routeKey(origin, destination)) ?? routeMap.get(routeKey(destination, origin)) ?? null;
}

// airport -> State for landing permits. rows: [{ airport, state }]; blank state = no landing permit needed.
export function buildAirportMap(rows) {
  const m = new Map();
  (rows || []).forEach(r => { const a = normAirport(r.airport); if (a) m.set(a, normState(r.state)); });
  return m;
}
export function normAirport(a) { return String(a || "").trim().toUpperCase(); }
const normRef = r => String(r || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// Flight numbers are compared on their digits, so a callsign in a permit document (VSV778)
// matches the schedule's flight number (DV778).
const flightDigits = r => (String(r || "").match(/\d+/g) || []).join("").replace(/^0+/, "");
export function sameFlight(a, b) {
  const x = normRef(a), y = normRef(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const dx = flightDigits(a), dy = flightDigits(b);
  return !!dx && dx === dy;
}

// What a flight needs: [{ kind:'overfly', state }, { kind:'landing', state, airport }] plus what
// could not be determined. Landing checks only run once at least one airport is listed.
export function flightNeeds(f, routeMap, airportMap) {
  const needs = [];
  const states = routeStatesFor(routeMap, f.origin, f.destination);
  if (states) states.forEach(st => needs.push({ kind: "overfly", state: normState(st) }));
  let unknownAirport = false;
  if (airportMap && airportMap.size > 0 && f.destination) {
    const a = normAirport(f.destination);
    if (!airportMap.has(a)) unknownAirport = true;
    else if (airportMap.get(a)) needs.push({ kind: "landing", state: airportMap.get(a), airport: a });
  }
  return { needs, unknownRoute: !states, unknownAirport };
}

export function dayOf(d) { return new Date(d).toISOString().slice(0, 10); }
export function daysBetween(aStr, bStr) { return Math.round((Date.parse(bStr + "T00:00:00Z") - Date.parse(aStr + "T00:00:00Z")) / 86400000); }
export function addDaysStr(dayStr, n) { const [y, m, d] = dayStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// approved-but-past-validity shows as "expired"; everything else is its stored status
export function effectiveStatus(p, todayStr) {
  if (p.status === "approved" && p.validTo && p.validTo < todayStr) return "expired";
  return p.status;
}

function matchesScope(p, opts) {
  if ((p.kind || "overfly") !== (opts?.kind || "overfly")) return false;
  if (p.validDates && p.validDates.length && opts?.day && !p.validDates.includes(opts.day)) return false;
  if (p.flightRefs && p.flightRefs.length && !p.flightRefs.some(r => sameFlight(r, opts?.ref))) return false;
  if ((p.kind || "overfly") === "landing" && p.airport && opts?.airport && normAirport(p.airport) !== normAirport(opts.airport)) return false;
  return true;
}
function matchesAircraft(p, resourceId) { return !p.resourceIds || p.resourceIds.length === 0 || p.resourceIds.includes(resourceId); }
function coversDay(p, day) { return (!p.validFrom || p.validFrom <= day) && (!p.validTo || p.validTo >= day); }

const REASON_RANK = { submitted: 1, draft: 2, rejected: 3, expired: 4, none: 5 }; // higher = worse

// Why a given flight/State is (not) covered. Returns { covered, reason, permit }.
//  covered  – an approved permit covers the day and aircraft
//  otherwise reason is the best-available state of the paperwork: submitted | draft | rejected | expired | none
export function coverageFor(permits, state, day, resourceId, opts) {
  const st = normState(state);
  const mine = (permits || []).filter(p => normState(p.state) === st && p.status !== "cancelled" && matchesAircraft(p, resourceId) && matchesScope(p, { ...(opts || {}), day }));
  const approved = mine.find(p => p.status === "approved" && coversDay(p, day));
  if (approved) return { covered: true, reason: "approved", permit: approved };
  const open = mine.filter(p => coversDay(p, day));
  const submitted = open.find(p => p.status === "submitted");
  if (submitted) return { covered: false, reason: "submitted", permit: submitted };
  const draft = open.find(p => p.status === "draft");
  if (draft) return { covered: false, reason: "draft", permit: draft };
  const rejected = open.find(p => p.status === "rejected");
  if (rejected) return { covered: false, reason: "rejected", permit: rejected };
  const lapsed = mine.filter(p => p.status === "approved" && p.validTo && p.validTo < day).sort((a, b) => b.validTo.localeCompare(a.validTo))[0];
  if (lapsed) return { covered: false, reason: "expired", permit: lapsed };
  return { covered: false, reason: "none", permit: null };
}

function leadFor(settings, state) { return settings?.get(normState(state))?.leadDays ?? DEFAULT_LEAD_DAYS; }

function reasonText(reason, permit) {
  switch (reason) {
    case "submitted": return `requested${permit?.authorityRef ? ` (ref ${permit.authorityRef})` : ""}, awaiting approval`;
    case "draft": return "drafted but not submitted yet";
    case "rejected": return `request rejected${permit?.permitNumber ? ` (${permit.permitNumber})` : ""}`;
    case "expired": return `last approved permit${permit?.permitNumber ? ` ${permit.permitNumber}` : ""} ended ${permit?.validTo}`;
    default: return "no permit on file";
  }
}

// Issues for the schedule Issues panel. Only flights that will operate (not cancelled), from today
// to `horizonDays` ahead — thousands of far-future warnings would bury real problems; the full
// picture lives in the Permits tab's gap list.
// Severity: a submitted request is only a warning; anything else is an error once the flight is
// inside the State's normal processing time (lead_days), otherwise a warning.
export function computePermitIssues(flights, routeMap, permits, settings, todayStr, horizonDays = 60, airportMap = null) {
  const issues = [];
  const last = addDaysStr(todayStr, horizonDays);
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr || day > last) return;
    flightNeeds(f, routeMap, airportMap).needs.forEach(n => {
      const c = coverageFor(permits, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport });
      if (c.covered) return;
      const daysOut = daysBetween(todayStr, day);
      const severity = c.reason === "submitted" ? "warn" : (c.reason === "rejected" || daysOut <= Math.max(ALERT_DAYS, leadFor(settings, n.state))) ? "error" : "warn";
      issues.push({
        id: `permit-${n.kind}-${f.id}-${n.state}`, severity, flightId: f.id, kind: n.kind === "landing" ? "Landing permit" : "Overfly permit",
        message: `${f.ref} (${f.origin}→${f.destination}, ${day}) ${n.kind === "landing" ? `lands in ${n.state}` : `overflies ${n.state}`} — ${reasonText(c.reason, c.permit)}.`,
      });
    });
  });
  return issues;
}

// Everything still uncovered from today on, grouped per State + aircraft, so the planner can
// see "UP-B3748 needs TM from 1 Nov (file by 20 Oct)" instead of 400 separate flights.
export function computePermitGaps(flights, routeMap, permits, settings, todayStr, airportMap = null) {
  const groups = new Map();
  const NEEDS_FILING = new Set(["none", "draft", "rejected", "expired"]);
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr) return;
    flightNeeds(f, routeMap, airportMap).needs.forEach(n => {
      const c = coverageFor(permits, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport });
      if (c.covered) return;
      const key = `${n.kind}|${n.state}|${f.resourceId}`;
      let g = groups.get(key);
      if (!g) { g = { kind: n.kind, state: n.state, resourceId: f.resourceId, firstDay: day, lastDay: day, flightCount: 0, reason: c.reason, flightIds: [], airports: [], firstNeedDay: null }; groups.set(key, g); }
      if (n.airport && !g.airports.includes(n.airport)) g.airports.push(n.airport);
      if (day < g.firstDay) g.firstDay = day;
      if (day > g.lastDay) g.lastDay = day;
      g.flightCount++;
      g.flightIds.push(f.id);
      if (REASON_RANK[c.reason] > REASON_RANK[g.reason]) g.reason = c.reason;
      // the deadline to file depends only on flights that still need paperwork, not on ones
      // already waiting for an answer
      if (NEEDS_FILING.has(c.reason) && (!g.firstNeedDay || day < g.firstNeedDay)) g.firstNeedDay = day;
    });
  });
  return [...groups.values()].map(g => {
    const lead = leadFor(settings, g.state);
    const fileBy = g.firstNeedDay ? addDaysStr(g.firstNeedDay, -lead) : null;
    return { ...g, leadDays: lead, fileBy, overdue: !!fileBy && fileBy < todayStr };
  }).sort((a, b) => a.firstDay.localeCompare(b.firstDay) || a.state.localeCompare(b.state) || a.kind.localeCompare(b.kind));
}

// Destination airports of upcoming flights that are not in the airport list yet (only once the
// list has at least one entry, i.e. landing checks are switched on).
export function unmappedAirports(flights, airportMap, todayStr) {
  const m = new Map();
  if (!airportMap || airportMap.size === 0) return [];
  (flights || []).forEach(f => {
    if (f.status === "cancelled" || !f.destination) return;
    const day = dayOf(f.start);
    if (day < todayStr) return;
    const a = normAirport(f.destination);
    if (airportMap.has(a)) return;
    const cur = m.get(a) || { airport: a, count: 0, firstDay: day };
    cur.count++; if (day < cur.firstDay) cur.firstDay = day;
    m.set(a, cur);
  });
  return [...m.values()].sort((x, y) => y.count - x.count);
}

// Routes of upcoming flights that nobody has mapped to States yet. These are invisible to the
// permit check, so the Permits tab lists them instead of letting them pass silently.
export function unmappedRoutes(flights, routeMap, todayStr) {
  const m = new Map();
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr || !f.origin || !f.destination) return;
    if (routeStatesFor(routeMap, f.origin, f.destination) !== null) return;
    const a = String(f.origin).toUpperCase(), b = String(f.destination).toUpperCase();
    const key = a < b ? `${a}-${b}` : `${b}-${a}`; // one entry for both directions
    const cur = m.get(key) || { origin: a < b ? a : b, destination: a < b ? b : a, count: 0, firstDay: day };
    cur.count++;
    if (day < cur.firstDay) cur.firstDay = day;
    m.set(key, cur);
  });
  return [...m.values()].sort((x, y) => y.count - x.count);
}

// Housekeeping reminders about the permits themselves (not about flights).
export function permitReminders(permits, todayStr) {
  const out = [];
  (permits || []).forEach(p => {
    const label = `${normState(p.state)}${p.kind === "landing" ? " landing" : ""}${p.permitNumber ? ` ${p.permitNumber}` : ""}`;
    const renewed = p.validTo && (permits || []).some(o => o.id !== p.id && o.status === "approved" && normState(o.state) === normState(p.state) && (o.kind || "overfly") === (p.kind || "overfly")
      && o.validTo && o.validTo > p.validTo && (!o.validFrom || o.validFrom <= addDaysStr(p.validTo, 1))
      && ((o.resourceIds || []).length === 0 || (p.resourceIds || []).length === 0 || o.resourceIds.some(r => p.resourceIds.includes(r))));
    if (p.status === "approved" && p.validTo && p.validTo >= todayStr && !renewed) {
      const left = daysBetween(todayStr, p.validTo);
      if (left <= EXPIRY_WARN_DAYS) out.push({ id: `exp-${p.id}`, permitId: p.id, severity: left <= 7 ? "error" : "warn", message: `Permit ${label} expires ${p.validTo} (${left} day${left === 1 ? "" : "s"} left).` });
    }
    if (p.status === "submitted" && p.submittedAt) {
      const age = daysBetween(dayOf(p.submittedAt), todayStr);
      if (age >= CHASE_AFTER_DAYS) out.push({ id: `chase-${p.id}`, permitId: p.id, severity: "warn", message: `Request for ${label} was submitted ${age} days ago with no decision — chase the authority.` });
    }
  });
  return out.sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
}

// Flights departing from today up to `days` days ahead that lack an approved permit (or whose
// route is not mapped, so nobody can tell). Used for the daily alert e-mail.
export function computeUrgentUncovered(flights, routeMap, permits, todayStr, days = ALERT_DAYS, airportMap = null) {
  const last = addDaysStr(todayStr, days);
  const uncovered = [], unmapped = [];
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr || day > last) return;
    const { needs, unknownRoute, unknownAirport } = flightNeeds(f, routeMap, airportMap);
    if (unknownRoute || unknownAirport) unmapped.push({ flightId: f.id, ref: f.ref, origin: f.origin, destination: f.destination, day, start: f.start, resourceId: f.resourceId, what: unknownRoute && unknownAirport ? "route and airport not mapped" : unknownRoute ? "route not mapped" : "airport not mapped" });
    needs.forEach(n => {
      const c = coverageFor(permits, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport });
      if (c.covered) return;
      uncovered.push({ flightId: f.id, ref: f.ref, origin: f.origin, destination: f.destination, day, start: f.start, resourceId: f.resourceId, kind: n.kind, state: n.state, reason: c.reason, text: reasonText(c.reason, c.permit), daysOut: daysBetween(todayStr, day) });
    });
  });
  const byTime = (a, b) => new Date(a.start) - new Date(b.start);
  return { uncovered: uncovered.sort(byTime), unmapped: unmapped.sort(byTime) };
}

// ---------- paperwork status of one flight (Gantt marks, change checks) ----------
// level: "ok" (nothing needed, or every permit approved) | "requested" (not approved yet but asked for or drafted)
//        | "missing" (nothing on file, rejected or expired) | "unchecked" (route or airport not mapped)
// Returns null when no route is mapped at all (the permit module is not in use yet) or for past/cancelled flights.
export function flightPermitStatus(f, routeMap, permits, airportMap, todayStr) {
  if (!routeMap || routeMap.size === 0) return null;
  if (f.status === "cancelled") return null;
  const day = dayOf(f.start);
  if (todayStr && day < todayStr) return null;
  const { needs, unknownRoute, unknownAirport } = flightNeeds(f, routeMap, airportMap);
  if (unknownRoute || unknownAirport) return { level: "unchecked", items: [], text: unknownRoute && unknownAirport ? "Route and airport not mapped in Permits" : unknownRoute ? "Route not mapped in Permits" : "Airport not mapped in Permits" };
  const items = [];
  needs.forEach(n => {
    const c = coverageFor(permits, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport });
    if (!c.covered) items.push({ kind: n.kind, state: n.state, reason: c.reason, text: reasonText(c.reason, c.permit) });
  });
  if (!items.length) return { level: "ok", items, text: needs.length ? "All permits approved" : "No permit needed" };
  const missing = items.some(i => ["none", "expired", "rejected"].includes(i.reason));
  return { level: missing ? "missing" : "requested", items, text: items.map(i => `${i.state}${i.kind === "landing" ? " (landing)" : ""}: ${i.text}`).join("; ") };
}

// What a change would break: needs that are uncovered after the change but were not uncovered before it.
// before / after: { ref, origin, destination, start, resourceId, status }
export function permitImpact(before, after, routeMap, permits, airportMap, todayStr) {
  const a = flightPermitStatus(after, routeMap, permits, airportMap, todayStr);
  if (!a || a.level === "ok") return [];
  const b = before ? flightPermitStatus(before, routeMap, permits, airportMap, todayStr) : null;
  const keyOf = i => `${i.kind}|${normState(i.state)}`;
  const was = new Set((b?.items || []).map(keyOf));
  if (a.level === "unchecked") return b?.level === "unchecked" ? [] : [{ kind: "route", state: "", reason: "unchecked", text: a.text }];
  return a.items.filter(i => !was.has(keyOf(i)));
}

// Does permit p (any status except cancelled) apply to a flight on `day` needing `state`? Used to find the flights a request is about.
export function permitAppliesTo(p, state, day, resourceId, opts) {
  return normState(p.state) === normState(state) && p.status !== "cancelled" && matchesAircraft(p, resourceId) && matchesScope(p, { ...(opts || {}), day }) && coversDay(p, day);
}
