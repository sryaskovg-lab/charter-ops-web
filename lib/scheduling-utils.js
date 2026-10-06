// ---------- scheduling-utils ----------
// Pure logic extracted from CharterOpsApp.jsx specifically so it can be unit tested without
// pulling in React, Next.js, Leaflet, or Supabase — none of which belong in a test that's only
// checking date math or lane assignment. CharterOpsApp.jsx imports these back in; this file is
// the single source of truth for them, not a copy.

const FAINT_COLOR = "#A7B0BE"; // matches C.faint in CharterOpsApp.jsx's palette
export const FLIGHT_COLORS = ["#3B6FE0", "#E0473B", "#1FAA59", "#E0923B", "#8B5CF6", "#2FA0C9", "#D6432E", "#0F9B8E", "#C2437E", "#B8860B", "#7C6FD1", "#DB2777", "#059669", "#EA580C", "#4F46E5", "#0891B2", "#65A30D", "#9333EA"];
const MIN_TURNAROUND_MIN = 45;

export function iso(d) { return d.toISOString().slice(0, 10); }
export function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }

export function hhmm(dateStr) { if (!dateStr) return null; const d = new Date(dateStr); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }

export function combineDateAndTime(baseDate, hhmmStr) {
  if (!hhmmStr) return null;
  const [h, m] = hhmmStr.split(":").map(Number);
  const d = new Date(baseDate);
  d.setUTCHours(h, m, 0, 0);
  return d;
}

// Computes the real arrival timestamp from a departure timestamp + an arrival "HH:MM" string.
// If the arrival lands on-or-before the departure once combined with the departure's own
// calendar day, the flight is assumed to cross midnight and actually lands the following day —
// this is the fix for overnight flights (e.g. depart 23:00, arrive 02:00) computing an arrival
// that's chronologically before takeoff, which is wrong in both the database and the display.
export function combineArrivalDateTime(depDateTime, hhmmStr) {
  if (!hhmmStr || !depDateTime) return null;
  const [h, m] = hhmmStr.split(":").map(Number);
  const d = new Date(depDateTime);
  d.setUTCHours(h, m, 0, 0);
  if (d <= depDateTime) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

export function timeToMinutes(hhmmStr) { if (!hhmmStr) return null; const [h, m] = hhmmStr.split(":").map(Number); return h * 60 + m; }
export function minutesToHHMM(min) { min = ((min % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"); }

export function flightGeometry(f) {
  const dep = timeToMinutes(f.depTime);
  if (dep == null) return { offsetFrac: 0, widthFrac: 1 };
  const arr = timeToMinutes(f.arrTime);
  let dur = arr != null ? arr - dep : 90;
  if (dur <= 0) dur += 1440;
  return { offsetFrac: dep / 1440, widthFrac: dur / 1440 };
}

// Greedy interval-scheduling lane assignment — when one aircraft has two+ flights whose times
// overlap (or are close) on the same day, they get separate lanes stacked vertically instead
// of literally drawing on top of each other.
export function assignLanes(flightsForDay, geomFn = flightGeometry) {
  const sorted = [...flightsForDay].sort((a, b) => geomFn(a).offsetFrac - geomFn(b).offsetFrac);
  const laneEnds = [];
  const laneOf = new Map();
  sorted.forEach(f => {
    const g = geomFn(f);
    const start = g.offsetFrac, end = g.offsetFrac + g.widthFrac;
    let placed = false;
    for (let lane = 0; lane < laneEnds.length; lane++) {
      if (start >= laneEnds[lane] - 0.005) { laneEnds[lane] = end; laneOf.set(f.id, lane); placed = true; break; }
    }
    if (!placed) { laneEnds.push(end); laneOf.set(f.id, laneEnds.length - 1); }
  });
  return { laneOf, laneCount: Math.max(laneEnds.length, 1) };
}

// Deterministic — the same destination always gets the same color across the whole app and
// across reloads, without needing to store anything. Two destinations can collide once there
// are more distinct ones than colors in the palette; that's a real limit of a fixed palette,
// not a bug, and grows more likely as the network grows past ~18 destinations.
export function colorForDestination(code) {
  if (!code) return FAINT_COLOR;
  let hash = 0;
  for (let i = 0; i < code.length; i++) hash = (hash * 31 + code.charCodeAt(i)) >>> 0;
  return FLIGHT_COLORS[hash % FLIGHT_COLORS.length];
}

export function mapFlight(f) {
  return {
    id: f.id, ref: f.ref, resourceId: f.resource_id, origin: f.origin, destination: f.destination,
    start: new Date(f.scheduled_departure), arrivalAt: f.scheduled_arrival ? new Date(f.scheduled_arrival) : null,
    capacity: f.capacity, status: f.status, legType: f.leg_type, version: f.version,
    depTime: hhmm(f.scheduled_departure), arrTime: hhmm(f.scheduled_arrival), color: f.color || null,
  };
}

// ---------- schedule validation engine ----------
// Real operational checks, not decorative ones: turnaround time, route continuity (does the
// next flight actually depart from where this aircraft just landed), capacity vs the
// aircraft's current configuration, and double-booking. Each issue names the actual numbers
// involved rather than just flagging a flight, matching how a real duty officer would want it
// explained. Advisory only — nothing here blocks or auto-corrects anything.
export function computeScheduleIssues(flights, resources, slotRequests = [], maintenanceBlocks = []) {
  const issues = [];
  const byResource = new Map(resources.map(r => [r.id, []]));
  flights.forEach(f => { if (byResource.has(f.resourceId)) byResource.get(f.resourceId).push(f); });

  slotRequests.forEach(s => {
    if (s.status !== "change_required") return;
    const f = flights.find(fl => fl.id === s.flightId);
    if (!f) return;
    issues.push({ id: `slot-${s.id}`, severity: "warn", flightId: f.id, kind: "Slot amendment required",
      message: `${f.ref}'s ${s.movementType} slot at ${s.airport} was confirmed for a different time than the schedule now shows — the confirmation was left untouched; re-coordinate and update the slot record.` });
  });

  const arrivalOf = f => f.arrivalAt || new Date(f.start.getTime() + 90 * 60000);

  byResource.forEach((resFlights, resourceId) => {
    const resource = resources.find(r => r.id === resourceId);
    const sorted = [...resFlights].sort((a, b) => a.start - b.start);
    sorted.forEach(f => {
      if (resource && f.capacity && f.capacity > resource.capacity && f.status !== "cancelled") {
        issues.push({ id: `cap-${f.id}`, severity: "error", flightId: f.id, kind: "Capacity",
          message: `${f.ref} is booked for ${f.capacity} seats, but ${resource.code} is currently configured for ${resource.capacity}.` });
      }
    });

    // Everything below only considers flights that will actually operate. A cancelled flight in
    // the middle must neither be checked itself nor break the chain between its neighbours.
    const active = sorted.filter(f => f.status !== "cancelled");

    // Maintenance: a flight on a day (UTC calendar day, same rule the Aircraft tab uses) when the
    // aircraft is down, however it got onto the board (manual add, drag, import, engine).
    active.forEach(f => {
      const d0 = new Date(f.start); d0.setUTCHours(0, 0, 0, 0);
      const d1 = new Date(d0); d1.setUTCDate(d1.getUTCDate() + 1);
      const block = maintenanceBlocks.find(m => m.resourceId === resourceId && m.start < d1 && m.end > d0);
      if (block) {
        issues.push({ id: `mx-${f.id}`, severity: "error", flightId: f.id, kind: "Aircraft grounded",
          message: `${f.ref} is scheduled while ${resource?.code || "this aircraft"} is in maintenance${block.reason ? ` (${block.reason})` : ""}.` });
      }
    });

    // Double-booking is checked against the flight that lands LATEST so far, not just the
    // previous departure: a long flight that two later flights both depart during is flagged
    // for both, where a neighbour-only comparison would miss the second one.
    let lastLanding = null; // the active flight with the latest arrival among those already seen
    active.forEach((f, i) => {
      if (lastLanding && f.start < arrivalOf(lastLanding)) {
        issues.push({ id: `overlap-${f.id}`, severity: "error", flightId: f.id, kind: "Double-booked",
          message: `${f.ref} departs before ${lastLanding.ref} has landed — ${resource?.code || "this aircraft"} is double-booked.` });
      } else if (i > 0) {
        const prev = active[i - 1];
        const prevArr = arrivalOf(prev);
        const gapMin = Math.round((f.start - prevArr) / 60000);
        if (gapMin >= 0 && gapMin < MIN_TURNAROUND_MIN) {
          issues.push({ id: `turn-${f.id}`, severity: "warn", flightId: f.id, kind: "Turnaround",
            message: `${prev.ref} arrives ${hhmm(prevArr)} — only ${gapMin} min before ${f.ref} departs, against a ${MIN_TURNAROUND_MIN} min minimum.` });
        }
      }
      if (i > 0) {
        const prev = active[i - 1];
        if (prev.destination && f.origin && prev.destination !== f.origin && prev.legType !== "ferry" && f.legType !== "ferry") {
          issues.push({ id: `geo-${f.id}`, severity: "warn", flightId: f.id, kind: "Route gap",
            message: `${f.ref} departs from ${f.origin}, but ${resource?.code || "this aircraft"} last landed at ${prev.destination} on ${prev.ref}. Add a ferry leg or check the routing.` });
        }
      }
      if (!lastLanding || arrivalOf(f) > arrivalOf(lastLanding)) lastLanding = f;
    });
  });
  return issues.sort((a, b) => (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1));
}
