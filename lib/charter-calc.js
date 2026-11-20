// Charter flight price calculation (pure functions, no database access).
// Mirrors the cost sheet: airport costs at each station + navigation + flight hour cost, all in USD.

export const BASES = ["turnaround", "time", "pax", "crew", "mtow_t", "fuel_t", "litre"];
export const BASIS_LABEL = { turnaround: "per turnaround", time: "per period", pax: "per passenger", crew: "per crew member", mtow_t: "per tonne MTOW", fuel_t: "per tonne of fuel", litre: "per litre" };

const r2 = x => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// Fuel price in USD per tonne from a stored price and unit (litres use a density of 0.8 kg/l).
export function fuelUsdPerTonne(price, unit) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  switch (unit) {
    case "USD/tonne": return p;
    case "USD/kg": return p * 1000;
    case "USD/litre": return p * 1250;
    case "USD/USG": return p * 1000 / (3.785 * 0.8);
    default: return null;
  }
}

// Legs: { from, to, km }. Time and fuel follow from the distance unless overridden on the leg.
export function computeLegs(legs, aircraft) {
  const speed = num(aircraft.cruiseKmh) || 850, burn = num(aircraft.burnTPerH);
  return legs.map(l => {
    const km = num(l.km);
    const hours = l.hours != null && l.hours !== "" ? num(l.hours) : r2(km / speed);
    const fuelT = l.fuelT != null && l.fuelT !== "" ? num(l.fuelT) : r2(hours * burn);
    return { from: l.from, to: l.to, km, hours, fuelT };
  });
}

// One cost block per station that is visited: every departure airport, plus the last arrival
// when it is not the first departure (a round trip is covered by the home station block).
export function stationsForLegs(legs) {
  if (!legs.length) return [];
  const out = legs.map((l, i) => ({ airport: l.from, uplift: l.fuelT, legIndex: i }));
  const last = legs[legs.length - 1];
  if (last.to && last.to !== legs[0].from) out.push({ airport: last.to, uplift: 0, legIndex: null });
  return out;
}

// Lines that apply to this aircraft type (a line tagged for another type is left out).
export function applicableLines(lines, aircraftCode) {
  return lines.filter(l => !l.aircraftType || l.aircraftType === aircraftCode);
}

function lineQuantity(line, ctx) {
  switch (line.basis) {
    case "pax": return ctx.pax;
    case "crew": return ctx.crew;
    case "mtow_t": return ctx.mtow;
    case "fuel_t": return ctx.uplift;
    default: return num(line.qty) || 1;
  }
}

// block: { airport, uplift, fuelUsdPerT, lines: [{ name, basis, price, qty, include }] }
export function computeBlock(block, ctx) {
  const lines = (block.lines || []).filter(l => l.include !== false).map(l => {
    const qty = lineQuantity(l, { ...ctx, uplift: num(block.uplift) });
    return { name: l.name, basis: l.basis, qty, price: num(l.price), total: num(l.price) * qty };
  });
  const fuelQty = num(block.uplift), fuelPrice = block.fuelUsdPerT == null ? null : num(block.fuelUsdPerT);
  const fuel = { qty: fuelQty, price: fuelPrice, total: fuelPrice == null ? 0 : fuelQty * fuelPrice, missing: fuelQty > 0 && fuelPrice == null };
  const total = lines.reduce((s, l) => s + l.total, 0) + fuel.total;
  return { airport: block.airport, lines, fuel, total };
}

// input: { aircraft:{ mtow, seats, burnTPerH, cruiseKmh, hourCost }, pax, crew, legs, blocks, nav:{ enroutePerKm, terminalPerLeg }, hourCost? }
export function computeQuote(input) {
  const aircraft = input.aircraft;
  const pax = num(input.pax) || num(aircraft.seats), crew = num(input.crew) || 7, mtow = num(aircraft.mtow);
  const legs = computeLegs(input.legs, aircraft);
  const km = legs.reduce((s, l) => s + l.km, 0), hours = r2(legs.reduce((s, l) => s + l.hours, 0)), fuelT = r2(legs.reduce((s, l) => s + l.fuelT, 0));
  const blocks = (input.blocks || []).map(b => computeBlock(b, { pax, crew, mtow }));
  const navEnroute = km * num(input.nav?.enroutePerKm), navTerminal = legs.length * num(input.nav?.terminalPerLeg);
  const hourCost = input.hourCost != null && input.hourCost !== "" ? num(input.hourCost) : num(aircraft.hourCost);
  const flightHours = hours * hourCost;
  const airports = blocks.reduce((s, b) => s + b.total, 0);
  const total = airports + navEnroute + navTerminal + flightHours;
  return {
    pax, crew, mtow, legs, km, hours, fuelT, blocks,
    nav: { enroute: navEnroute, terminal: navTerminal },
    flightHours: { hours, rate: hourCost, total: flightHours },
    airports, total,
    perSeat: pax ? total / pax : 0,
    perBlockHour: hours ? total / hours : 0,
    missingFuel: blocks.filter(b => b.fuel.missing).map(b => b.airport),
  };
}
