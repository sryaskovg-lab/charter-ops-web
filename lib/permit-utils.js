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

export function dayOf(d) { return new Date(d).toISOString().slice(0, 10); }
export function daysBetween(aStr, bStr) { return Math.round((Date.parse(bStr + "T00:00:00Z") - Date.parse(aStr + "T00:00:00Z")) / 86400000); }
export function addDaysStr(dayStr, n) { const [y, m, d] = dayStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }

// approved-but-past-validity shows as "expired"; everything else is its stored status
export function effectiveStatus(p, todayStr) {
  if (p.status === "approved" && p.validTo && p.validTo < todayStr) return "expired";
  return p.status;
}

function matchesAircraft(p, resourceId) { return !p.resourceIds || p.resourceIds.length === 0 || p.resourceIds.includes(resourceId); }
function coversDay(p, day) { return (!p.validFrom || p.validFrom <= day) && (!p.validTo || p.validTo >= day); }

const REASON_RANK = { submitted: 1, draft: 2, rejected: 3, expired: 4, none: 5 }; // higher = worse

// Why a given flight/State is (not) covered. Returns { covered, reason, permit }.
//  covered  – an approved permit covers the day and aircraft
//  otherwise reason is the best-available state of the paperwork: submitted | draft | rejected | expired | none
export function coverageFor(permits, state, day, resourceId) {
  const st = normState(state);
  const mine = (permits || []).filter(p => normState(p.state) === st && p.status !== "cancelled" && matchesAircraft(p, resourceId));
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
export function computePermitIssues(flights, routeMap, permits, settings, todayStr, horizonDays = 60) {
  const issues = [];
  const last = addDaysStr(todayStr, horizonDays);
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr || day > last) return;
    const states = routeStatesFor(routeMap, f.origin, f.destination);
    if (!states) return;
    states.forEach(state => {
      const c = coverageFor(permits, state, day, f.resourceId);
      if (c.covered) return;
      const daysOut = daysBetween(todayStr, day);
      const severity = c.reason === "submitted" ? "warn" : (c.reason === "rejected" || daysOut <= leadFor(settings, state)) ? "error" : "warn";
      issues.push({
        id: `permit-${f.id}-${normState(state)}`, severity, flightId: f.id, kind: "Overfly permit",
        message: `${f.ref} (${f.origin}→${f.destination}, ${day}) overflies ${normState(state)} — ${reasonText(c.reason, c.permit)}.`,
      });
    });
  });
  return issues;
}

// Everything still uncovered from today on, grouped per State + aircraft, so the planner can
// see "UP-B3748 needs TM from 1 Nov (file by 20 Oct)" instead of 400 separate flights.
export function computePermitGaps(flights, routeMap, permits, settings, todayStr) {
  const groups = new Map();
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr) return;
    const states = routeStatesFor(routeMap, f.origin, f.destination);
    if (!states) return;
    states.forEach(state => {
      const c = coverageFor(permits, state, day, f.resourceId);
      if (c.covered) return;
      const key = `${normState(state)}|${f.resourceId}`;
      let g = groups.get(key);
      if (!g) { g = { state: normState(state), resourceId: f.resourceId, firstDay: day, lastDay: day, flightCount: 0, reason: c.reason, flightIds: [] }; groups.set(key, g); }
      if (day < g.firstDay) g.firstDay = day;
      if (day > g.lastDay) g.lastDay = day;
      g.flightCount++;
      g.flightIds.push(f.id);
      if (REASON_RANK[c.reason] > REASON_RANK[g.reason]) g.reason = c.reason;
    });
  });
  return [...groups.values()].map(g => {
    const lead = leadFor(settings, g.state);
    const fileBy = addDaysStr(g.firstDay, -lead);
    const needsFiling = g.reason === "none" || g.reason === "draft" || g.reason === "rejected" || g.reason === "expired";
    return { ...g, leadDays: lead, fileBy, overdue: needsFiling && fileBy < todayStr };
  }).sort((a, b) => a.firstDay.localeCompare(b.firstDay) || a.state.localeCompare(b.state));
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
    const label = `${normState(p.state)}${p.permitNumber ? ` ${p.permitNumber}` : ""}`;
    if (p.status === "approved" && p.validTo && p.validTo >= todayStr) {
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
