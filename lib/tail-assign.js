// Proposes an aircraft (tail) for flights that have none, e.g. flights created from an SSIM file.
// Pure function: nothing is saved here.
//
//   flights:   [{ id, resourceId, origin, destination, start: Date, arrivalAt: Date|null, capacity, status }]
//   resources: [{ id, code, variant, capacity }]
//   opts: { typeKey(variant) -> "B39M"|..., isGrounded(resourceId, Date) -> bool, turnMin = 45,
//           allowJump = false, from, to (Date, limit which unassigned flights are handled) }
// Returns { assigned: [{ flightId, resourceId, jump: null|{ from } }], left: [{ flightId, reason }], byType }
//
// Rules, in this order:
//   1. the tail must be of the flight's type (found from the seats on the flight);
//   2. it must be free: no other flight within the turnaround time on either side, and not grounded;
//   3. it should depart from where the tail last landed; when allowJump is false a tail that would
//      have to change station without a flight is not used.
// Flights are handled in departure order; among tails that fit, the one already at the station is
// preferred, then a tail with no earlier flight, then (only if allowJump) any free tail; ties go to
// the tail with the fewest flights.

const HOUR = 3600000;

export function flightEnd(f) {
  return f.arrivalAt && f.arrivalAt > f.start ? f.arrivalAt : new Date(f.start.getTime() + 2 * HOUR);
}

export function assignTails(flights, resources, opts = {}) {
  const turn = (opts.turnMin ?? 45) * 60000;
  const typeKey = opts.typeKey || (v => String(v || "").split(/[\s·]+/)[0]);
  const isGrounded = opts.isGrounded || (() => false);
  const from = opts.from ? opts.from.getTime() : -Infinity;
  const to = opts.to ? opts.to.getTime() + 86400000 : Infinity;

  // the seats on a flight tell which type it was made for
  const typesByCapacity = new Map();
  for (const r of resources) {
    const k = typeKey(r.variant);
    if (!typesByCapacity.has(r.capacity)) typesByCapacity.set(r.capacity, new Set());
    typesByCapacity.get(r.capacity).add(k);
  }
  const canon = opts.canonType || (x => String(x || "").toUpperCase());
  const eligibleTails = f => {
    if (f.aircraftType) { const k = canon(f.aircraftType); return resources.filter(r => typeKey(r.variant) === k); }
    const types = typesByCapacity.get(f.capacity);
    return resources.filter(r => !types || types.size === 0 || types.has(typeKey(r.variant)));
  };

  // each tail's timeline, kept sorted by start
  const line = new Map(resources.map(r => [r.id, []]));
  for (const f of flights) {
    if (f.resourceId && f.status !== "cancelled" && line.has(f.resourceId)) line.get(f.resourceId).push({ s: f.start.getTime(), e: flightEnd(f).getTime(), o: String(f.origin).toUpperCase(), d: String(f.destination).toUpperCase() });
  }
  for (const l of line.values()) l.sort((a, b) => a.s - b.s);

  const todo = flights
    .filter(f => !f.resourceId && f.status !== "cancelled" && f.start.getTime() >= from && f.start.getTime() < to)
    .sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));

  const assigned = [], left = [];
  const byType = {};
  for (const f of todo) {
    const s = f.start.getTime(), e = flightEnd(f).getTime();
    const o = String(f.origin).toUpperCase();
    const cands = eligibleTails(f);
    if (!cands.length) { left.push({ flightId: f.id, reason: `no ${f.aircraftType ? canon(f.aircraftType) + " " : ""}aircraft in the fleet` }); continue; }
    let best = null, anyFree = false, anyUngrounded = false;
    for (const r of cands) {
      const days = [];
      for (let t = Date.UTC(f.start.getUTCFullYear(), f.start.getUTCMonth(), f.start.getUTCDate()); t <= e; t += 86400000) days.push(new Date(t));
      if (days.some(d => isGrounded(r.id, d))) continue;
      anyUngrounded = true;
      const l = line.get(r.id);
      let prev = null, clash = false;
      for (const x of l) {
        if (x.s < e + turn && x.e > s - turn) { clash = true; break; }
        if (x.e <= s - turn) prev = x; // latest finished flight before this one
        if (x.s >= e + turn) break;
      }
      if (clash) continue;
      anyFree = true;
      const atStation = prev && prev.d === o;
      const score = atStation ? 0 : !prev ? 1 : 2;
      if (score === 2 && !opts.allowJump) continue;
      const load = l.length;
      if (!best || score < best.score || (score === best.score && load < best.load)) best = { r, score, load, prev };
    }
    if (!best) {
      left.push({ flightId: f.id, reason: !anyUngrounded ? "every aircraft of this type is grounded" : !anyFree ? "every aircraft of this type is busy at that time" : "free aircraft are at another station (turn on positioning to allow it)" });
      continue;
    }
    const l = line.get(best.r.id);
    l.push({ s, e, o, d: String(f.destination).toUpperCase() });
    l.sort((a, b) => a.s - b.s);
    assigned.push({ flightId: f.id, resourceId: best.r.id, jump: best.score === 2 ? { from: best.prev.d } : null });
    byType[typeKey(best.r.variant)] = (byType[typeKey(best.r.variant)] || 0) + 1;
  }
  return { assigned, left, byType };
}
