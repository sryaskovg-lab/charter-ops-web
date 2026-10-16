// IATA MVT (aircraft movement) messages, e.g.
//   MVT
//   DV5273/16.B3738.NQZ
//   AD0225/0300 EA0810 AYT
//   SI AUTOFEED 34916553
// AD = actual departure (off-block / airborne), AA = actual arrival (landing / on-block),
// ED / EA = estimated departure / arrival. All times are UTC; the "16" is the day of the month of
// the scheduled departure. Pure functions, no network or database.

const HHMM = /^([01]\d|2[0-3])([0-5]\d)$/;
const mins = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));

export function looksLikeMvt(text) {
  return /^\s*MVT\s*$/im.test(String(text || "")) || /^\s*MVA\s*$/im.test(String(text || ""));
}

// text -> [{ airline, number, ref, day, registration, origin, off, airborne, landing, onBlock, eta, etaDest, estDep, destination, notes, warnings }]
export function parseMvt(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").map(l => l.trim().toUpperCase());
  const out = [];
  let cur = null;
  const flush = () => { if (cur && (cur.off || cur.airborne || cur.landing || cur.onBlock || cur.eta || cur.estDep)) out.push(cur); cur = null; };
  for (const line of lines) {
    if (!line) continue;
    if (line === "MVT" || line === "MVA") { flush(); continue; }
    if (line === "NNNN") { flush(); continue; }
    const head = /^([A-Z0-9]{2})\s?(\d{1,4}[A-Z]?)\/(\d{1,2})\.([A-Z0-9-]{3,8})\.([A-Z]{3})(?:\.(\d))?$/.exec(line);
    if (head) {
      flush();
      cur = { airline: head[1], number: head[2], ref: head[1] + head[2], day: Number(head[3]), registration: head[4], origin: head[5],
        off: null, airborne: null, landing: null, onBlock: null, eta: null, etaDest: null, estDep: null, destination: null, notes: [], warnings: [] };
      continue;
    }
    if (!cur) continue;
    if (/^(SI|SK|PX|DL|RR|FR|NI|CD|AM|EM|RE|ER)\b/.test(line)) { cur.notes.push(line); continue; }
    // AD0225/0300 EA0810 AYT   |   AA0805/0812   |   ED0230   |   EA0810 AYT
    const toks = line.split(/\s+/);
    for (let i = 0; i < toks.length; i++) {
      const m = /^(AD|AA|ED|EA)(\d{4})(?:\/(\d{4}))?(?:\/(\d{2}))?$/.exec(toks[i]);
      if (!m) { if (/^[A-Z]{3}$/.test(toks[i]) && cur.eta && !cur.etaDest) cur.etaDest = toks[i]; continue; }
      const [, kind, a, b] = m;
      if (!HHMM.test(a) || (b && !HHMM.test(b))) { cur.warnings.push(`Unreadable time in "${toks[i]}"`); continue; }
      if (kind === "AD") { cur.off = a; cur.airborne = b || null; }
      else if (kind === "AA") { cur.landing = a; cur.onBlock = b || null; }
      else if (kind === "ED") cur.estDep = a;
      else if (kind === "EA") cur.eta = a;
    }
    if (cur.eta && cur.etaDest) cur.destination = cur.etaDest;
  }
  flush();
  return out;
}

// Turns hhmm strings into UTC instants on / after the scheduled departure day.
// std: Date (scheduled departure). Each time is placed on the first day that keeps the sequence
// moving forward, starting 12 hours before the scheduled departure.
export const isArrivalOnly = mv => !mv.off && !mv.airborne && !mv.estDep && !!(mv.landing || mv.onBlock);

export function resolveMvtTimes(mv, std, sta) {
  if (isArrivalOnly(mv)) {
    // the station in the header is the arrival station: put the times next to the scheduled arrival
    const ref = (sta || new Date(std.getTime() + 2 * 3600000)).getTime();
    const day0 = Date.UTC(new Date(ref).getUTCFullYear(), new Date(ref).getUTCMonth(), new Date(ref).getUTCDate());
    const near = hhmm => {
      if (!hhmm) return null;
      let best = null;
      for (const d of [-1, 0, 1]) { const t = day0 + d * 86400000 + mins(hhmm) * 60000; if (best == null || Math.abs(t - ref) < Math.abs(best - ref)) best = t; }
      return best;
    };
    const landing = near(mv.landing);
    let onBlock = near(mv.onBlock);
    if (onBlock != null && landing != null && onBlock < landing) onBlock += 86400000;
    const iso = t => (t == null ? null : new Date(t).toISOString());
    return { off: null, airborne: null, landing: iso(landing), onBlock: iso(onBlock), eta: null };
  }
  const base = Date.UTC(std.getUTCFullYear(), std.getUTCMonth(), std.getUTCDate());
  const place = (hhmm, notBefore) => {
    if (!hhmm) return null;
    let t = base + mins(hhmm) * 60000;
    while (t < notBefore) t += 86400000;
    while (t - 86400000 >= notBefore) t -= 86400000;
    return t;
  };
  const off = place(mv.off, std.getTime() - 12 * 3600000);
  const estDep = place(mv.estDep, std.getTime() - 12 * 3600000);
  const dep = off ?? estDep ?? std.getTime();
  const airborne = place(mv.airborne, dep);
  const landing = place(mv.landing, airborne ?? dep);
  const onBlock = place(mv.onBlock, landing ?? airborne ?? dep);
  const eta = place(mv.eta, airborne ?? dep);
  const iso = t => (t == null ? null : new Date(t).toISOString());
  return { off: iso(off), airborne: iso(airborne), landing: iso(landing), onBlock: iso(onBlock), eta: iso(eta) };
}

const keyOf = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
// "B3738" vs resource code "UP-B3738" -> same aircraft
export function sameAircraft(reg, resourceCode) {
  const a = keyOf(reg), b = keyOf(resourceCode);
  if (!a || !b) return null;
  return a === b || b.endsWith(a) || a.endsWith(b);
}

// candidates: flights [{ id, ref, origin, scheduled_departure }]; picks the one scheduled on mv.day (UTC)
// nearest to `around` (the time the message was sent).
export function pickFlight(mv, candidates, around) {
  const arr = isArrivalOnly(mv);
  const day = d => new Date(d).getUTCDate();
  const hits = (candidates || []).filter(f => String(f.ref || "").toUpperCase().replace(/\s/g, "") === mv.ref
    && (arr ? String(f.destination || "").toUpperCase() === mv.origin && (day(f.scheduled_departure) === mv.day || (f.scheduled_arrival && day(f.scheduled_arrival) === mv.day))
            : String(f.origin || "").toUpperCase() === mv.origin && day(f.scheduled_departure) === mv.day));
  if (!hits.length) return { flight: null, how: arr ? "no flight with this number, day and arrival station" : "no flight with this number, day and origin" };
  const t = (around || new Date()).getTime();
  hits.sort((a, b) => Math.abs(new Date(a.scheduled_departure) - t) - Math.abs(new Date(b.scheduled_departure) - t));
  if (hits.length > 1 && Math.abs(new Date(hits[0].scheduled_departure) - t) > 20 * 86400000) return { flight: null, how: "several months match; message too old to tell" };
  return { flight: hits[0], how: arr ? "number, day and arrival station match" : "number, day and origin match" };
}
