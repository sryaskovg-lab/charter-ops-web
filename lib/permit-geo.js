// Turns the geography helpers into permit suggestions. Nothing here writes anything:
// the Permits tab shows the suggestions and a person applies the ones they accept.
import { normAirport, normState, dayOf } from "./permit-utils.js";
import { buildCountryIndex, statesAlong } from "./geo.js";

export function makeGeo(airportRows, countries) {
  const airports = new Map();
  (airportRows || []).forEach(r => {
    const rec = { iata: r[0], icao: r[1], lat: r[2], lon: r[3], state: r[4], name: r[5] };
    if (rec.icao) airports.set(rec.icao, rec);
    if (rec.iata) airports.set(rec.iata, rec);
  });
  const names = new Map((countries || []).map(c => [c.cc, c.name]));
  return { airports, index: buildCountryIndex(countries), nameOf: cc => names.get(cc) || cc };
}

// Destinations of upcoming flights that are not in the airport list yet.
export function upcomingDestinations(flights, airportMap, todayStr) {
  const m = new Map();
  (flights || []).forEach(f => {
    if (f.status === "cancelled" || !f.destination) return;
    const day = dayOf(f.start);
    if (day < todayStr) return;
    const a = normAirport(f.destination);
    if (airportMap && airportMap.has(a)) return;
    const cur = m.get(a) || { airport: a, count: 0, firstDay: day };
    cur.count++; if (day < cur.firstDay) cur.firstDay = day;
    m.set(a, cur);
  });
  return [...m.values()].sort((x, y) => y.count - x.count);
}

// codes: [{ airport, count, firstDay }]; homeStates: States that need no landing permit.
export function suggestAirports(codes, geo, homeStates) {
  const home = new Set((homeStates || []).map(normState));
  return (codes || []).map(c => {
    const rec = geo.airports.get(normAirport(c.airport));
    if (!rec) return { ...c, found: false, state: null, name: null };
    const st = normState(rec.state);
    return { ...c, found: true, name: rec.name, country: st, state: home.has(st) ? "" : st, home: home.has(st) };
  });
}

// routes: [{ origin, destination, count?, firstDay? }]
export function suggestRoute(origin, destination, geo, opts) {
  const a = geo.airports.get(normAirport(origin)), b = geo.airports.get(normAirport(destination));
  if (!a || !b) return { found: false, missing: [!a && normAirport(origin), !b && normAirport(destination)].filter(Boolean) };
  const crossed = statesAlong(geo.index, geo.nameOf, a, b, opts);
  const ends = new Set([normState(a.state), normState(b.state)]); // landing/departure States are not overflown
  const states = crossed.filter(c => !ends.has(c.state));
  return { found: true, states, originState: normState(a.state), destState: normState(b.state) };
}
export function suggestRoutes(routes, geo, opts) {
  return (routes || []).map(r => ({ ...r, ...suggestRoute(r.origin, r.destination, geo, opts) }));
}

// Differences between the States someone typed in and the line between the airports.
export function compareMapped(routes, geo, opts) {
  const out = [];
  (routes || []).forEach(r => {
    const s = suggestRoute(r.origin, r.destination, geo, opts);
    if (!s.found) return;
    const mine = new Set((r.states || []).map(normState));
    const calc = new Set(s.states.map(x => x.state));
    const missing = s.states.filter(x => !mine.has(x.state));
    const extra = [...mine].filter(x => !calc.has(x));
    if (missing.length || extra.length) out.push({ origin: r.origin, destination: r.destination, missing, extra });
  });
  return out;
}
