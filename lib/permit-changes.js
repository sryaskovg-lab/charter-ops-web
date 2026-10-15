// Schedule changes since a permit request was sent. A snapshot of the flights (flightKey) is stored when the request is
// made; later the current flights the permit applies to are compared with it.
import { flightNeeds, permitAppliesTo, dayOf, normAirport } from "./permit-utils";
import { scheduleLines } from "./permit-request";

const hm = d => (d ? new Date(d).toISOString().slice(11, 16) : "--:--");
export function flightKey(f) { return [String(f.ref), dayOf(f.start), f.origin, f.destination, hm(f.start), hm(f.arrivalAt)].join("|"); }
const parseKey = k => { const [ref, day, origin, destination, dep, arr] = k.split("|"); return { ref, day, origin, destination, dep, arr }; };
const pseudo = e => ({ ref: e.ref, origin: e.origin, destination: e.destination, start: new Date(`${e.day}T${e.dep}:00Z`), arrivalAt: e.arr === "--:--" ? null : new Date(`${e.day}T${e.arr}:00Z`) });

// Flights a permit is about: non-cancelled, needing its State (and kind), inside its validity, on its aircraft and scope.
export function flightsForPermit(p, flights, routeMap, airportMap) {
  return (flights || []).filter(f => {
    if (f.status === "cancelled") return false;
    const day = dayOf(f.start);
    return flightNeeds(f, routeMap, airportMap).needs.some(n => n.kind === (p.kind || "overfly") && n.state === String(p.state).trim().toUpperCase()
      && permitAppliesTo({ ...p, status: "draft" }, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport || (p.airport ? normAirport(p.airport) : undefined) }));
  });
}

// -> { added: [flight], removed: [entry], changed: [{ from: entry, to: flight }], count } for upcoming flights only
export function permitChanges(p, flights, routeMap, airportMap, todayStr) {
  if (!Array.isArray(p.requestedFlights)) return null;
  const now = flightsForPermit(p, flights, routeMap, airportMap).filter(f => dayOf(f.start) >= todayStr);
  const snap = p.requestedFlights.map(parseKey).filter(e => e.day >= todayStr);
  const snapKeys = new Set(p.requestedFlights);
  const nowByDay = new Map(now.map(f => [`${f.ref}|${dayOf(f.start)}`, f]));
  const snapByDay = new Map(snap.map(e => [`${e.ref}|${e.day}`, e]));
  const added = [], changed = [], removed = [];
  now.forEach(f => {
    if (snapKeys.has(flightKey(f))) return;
    const old = snapByDay.get(`${f.ref}|${dayOf(f.start)}`);
    if (old) changed.push({ from: old, to: f }); else added.push(f);
  });
  snap.forEach(e => { if (!nowByDay.has(`${e.ref}|${e.day}`)) removed.push(e); });
  return { added, removed, changed, count: added.length + removed.length + changed.length };
}

const dm = ds => `${ds.slice(8, 10)}.${ds.slice(5, 7)}`;
export function amendmentText({ added = [], removed = [], changed = [] }) {
  const out = [];
  const no = r => String(r).replace(/^[A-Za-z]{2}(?=\d)/, "");
  if (added.length) out.push("ADDITIONAL FLIGHTS (times UTC)", ...scheduleLines(added), "");
  if (removed.length) out.push("CANCELLED FLIGHTS", ...removed.map(e => `${no(e.ref).padEnd(6)}${(e.origin + "-" + e.destination).padEnd(10)}${e.dep.padEnd(7)}${e.arr.padEnd(7)}${dm(e.day)}.`), "");
  if (changed.length) out.push("CHANGED FLIGHTS (times UTC)", ...changed.map(({ from, to }) => `${no(from.ref).padEnd(6)}${dm(from.day)}.  ${from.origin}-${from.destination} ${from.dep}-${from.arr}  ->  ${to.origin}-${to.destination} ${hm(to.start)}-${hm(to.arrivalAt)}`), "");
  return out.join("\n").trim();
}
export { pseudo as entryToFlight };
