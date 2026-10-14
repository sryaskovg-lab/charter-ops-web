// IATA SSIM Chapter 7 (standard schedules data set) reader. Pure functions, no dependencies.
//
// Fixed-width 200-character records:
//   1 header, 2 carrier (time mode U/L, airline, season), 3 flight leg, 4 segment data, 5 trailer.
// Only Type 2 and Type 3 are used. Times in a Type 3 record are local with a UTC offset
// (unless the carrier record says UTC), so they are converted to UTC here, and the weekday of
// operation refers to the LOCAL departure date, as in the standard.
//
// Field positions below are 1-based, as the standard prints them.

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export const MAX_EXPANDED_FLIGHTS = 20000;

export function looksLikeSsim(text) {
  const first = String(text || "").split(/\r?\n/).find(l => l.trim());
  return !!first && /^1AIRLINE STANDARD SCHEDULE DATA SET/i.test(first);
}

// "20OCT26" -> Date (UTC midnight); "00XXX00" and anything unreadable -> null
export function parseSsimDate(s) {
  const m = /^(\d{2})([A-Za-z]{3})(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toUpperCase()];
  if (mon === undefined) return null;
  const d = new Date(Date.UTC(2000 + Number(m[3]), mon, Number(m[1])));
  return d.getUTCDate() === Number(m[1]) ? d : null; // rejects 31FEB26
}

// "+0500" / "-0330" / "" -> minutes
export function parseOffset(s) {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}
const hhmmToMin = s => { const m = /^(\d{2})(\d{2})$/.exec(String(s || "").trim()); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : null; };
const two = n => String(n).padStart(2, "0");
export const minToHHMM = m => `${two(Math.floor(((m % 1440) + 1440) % 1440 / 60))}:${two(((m % 1440) + 1440) % 1440 % 60)}`;

// Aircraft types are written differently in schedules (IATA 3-character) and in the fleet list
// (ICAO). Both are mapped to one key so "7M9" finds a "B39M" aircraft.
const TYPE_ALIASES = {
  "7M9": "B39M", "B39M": "B39M", "739M": "B39M",
  "7M8": "B38M", "B38M": "B38M", "738M": "B38M",
  "7M7": "B37M", "B37M": "B37M",
  "73H": "B738", "738": "B738", "B738": "B738",
  "739": "B739", "B739": "B739",
  "752": "B752", "757": "B752", "75W": "B752", "B752": "B752",
  "753": "B753", "B753": "B753",
  "763": "B763", "767": "B763", "76W": "B763", "B763": "B763",
  "320": "A320", "A320": "A320", "32N": "A20N", "A20N": "A20N",
  "321": "A321", "A321": "A321", "32Q": "A21N", "A21N": "A21N",
  "319": "A319", "A319": "A319", "333": "A333", "A333": "A333",
};
export function canonicalAircraftType(code) {
  const c = String(code || "").trim().toUpperCase();
  return TYPE_ALIASES[c] || c;
}
// "B39M · 213Y" -> "B39M"
export function fleetTypeKey(variant) {
  return canonicalAircraftType(String(variant || "").split(/[\s·]+/)[0]);
}

// Type 3 record -> leg object, or { error } for a record that cannot be used.
export function parseLegRecord(line, carrier) {
  const s = String(line).padEnd(200);
  const slice = (pos, len) => s.slice(pos - 1, pos - 1 + len);
  const airline = slice(3, 3).trim();
  const noRaw = slice(6, 4).trim();
  if (!/^\d{1,4}$/.test(noRaw)) return { error: `flight number "${noRaw}" is not numeric` };
  const from = parseSsimDate(slice(15, 7)), to = parseSsimDate(slice(22, 7));
  if (!from || !to) return { error: `period "${slice(15, 7)} to ${slice(22, 7)}" is not readable` };
  if (to < from) return { error: "period ends before it starts" };
  const days = new Set([...slice(29, 7)].filter(c => /[1-7]/.test(c)).map(Number));
  if (!days.size) return { error: "no operating days" };
  const origin = slice(37, 3).trim().toUpperCase(), destination = slice(55, 3).trim().toUpperCase();
  const std = hhmmToMin(slice(44, 4)) ?? hhmmToMin(slice(40, 4)); // aircraft time, else passenger time
  const sta = hhmmToMin(slice(58, 4)) ?? hhmmToMin(slice(62, 4));
  if (!/^[A-Z]{3}$/.test(origin) || !/^[A-Z]{3}$/.test(destination)) return { error: "airport codes are not readable" };
  if (std === null || sta === null) return { error: "times are not readable" };
  const utc = carrier?.timeMode === "U";
  const depOff = utc ? 0 : parseOffset(slice(48, 5));
  const arrOff = utc ? 0 : parseOffset(slice(66, 5));
  if (depOff === null || arrOff === null) return { error: "UTC offset is missing or not readable" };
  return {
    airline, flightNo: String(Number(noRaw)), suffix: slice(2, 1).trim(), legSeq: slice(12, 2).trim(), serviceType: slice(14, 1).trim(),
    from, to, days, freq: slice(36, 1).trim(), origin, destination, std, sta, depOff, arrOff,
    aircraftType: slice(73, 3).trim().toUpperCase(),
  };
}

// text -> { header, carriers, legs, warnings, counts }
export function parseSsim(text) {
  const lines = String(text || "").split(/\r?\n/).filter(l => l.trim());
  const out = { header: null, carriers: [], legs: [], warnings: [], counts: { records: lines.length, legs: 0, skipped: 0 } };
  let carrier = null;
  lines.forEach((line, i) => {
    const type = line[0];
    if (type === "1") out.header = line.slice(0, 35).trim();
    else if (type === "2") {
      carrier = { airline: line.slice(2, 5).trim(), timeMode: (line[1] || "L").toUpperCase() === "U" ? "U" : "L" };
      out.carriers.push(carrier);
    } else if (type === "3") {
      const leg = parseLegRecord(line, carrier);
      if (leg.error) { out.counts.skipped++; out.warnings.push(`Line ${i + 1}: ${leg.error}; skipped.`); }
      else { leg.timeMode = carrier?.timeMode || "L"; out.legs.push(leg); out.counts.legs++; }
    }
    // 0 (filler), 4 (segment data) and 5 (trailer) carry nothing this app uses
  });
  if (!out.legs.length && !out.warnings.length) out.warnings.push("No flight records (type 3) found.");
  return out;
}

// One leg line -> one row per operating day, in UTC.
//   opts: { airlines: ['DV'], fromDate: Date, toDate: Date }
export function expandLegs(legs, opts = {}) {
  const airlines = opts.airlines && opts.airlines.length ? new Set(opts.airlines.map(a => a.toUpperCase())) : null;
  const rows = [], warnings = [];
  for (const leg of legs) {
    if (airlines && !airlines.has(leg.airline.toUpperCase())) continue;
    if (leg.freq && !["1", "2"].includes(leg.freq)) warnings.push(`${leg.airline}${leg.flightNo}: frequency rate "${leg.freq}" is treated as weekly.`);
    const first = opts.fromDate && opts.fromDate > leg.from ? opts.fromDate : leg.from;
    const last = opts.toDate && opts.toDate < leg.to ? opts.toDate : leg.to;
    for (let t = first.getTime(); t <= last.getTime(); t += 86400000) {
      const local = new Date(t);
      if (!leg.days.has(local.getUTCDay() || 7)) continue;
      if (leg.freq === "2" && Math.floor((t - leg.from.getTime()) / 86400000 / 7) % 2 !== 0) continue;
      const depAbs = t / 60000 + leg.std - leg.depOff; // minutes since epoch, UTC
      const depOfDay = ((depAbs % 1440) + 1440) % 1440;
      const arrOfDay = ((leg.sta - leg.arrOff) % 1440 + 1440) % 1440;
      const dayStart = Math.floor(depAbs / 1440) * 1440;
      const date = new Date(dayStart * 60000);
      rows.push({
        date, airline: leg.airline, flightNo: leg.flightNo, origin: leg.origin, destination: leg.destination,
        depTime: minToHHMM(depOfDay), arrTime: minToHHMM(arrOfDay), durationMin: (arrOfDay - depOfDay + 1440) % 1440,
        aircraftType: leg.aircraftType, serviceType: leg.serviceType, legType: leg.serviceType === "P" ? "ferry" : "revenue", localDate: new Date(t),
      });
      if (rows.length >= MAX_EXPANDED_FLIGHTS) { warnings.push(`Stopped at ${MAX_EXPANDED_FLIGHTS} flights; narrow the airline or the dates.`); return { rows, warnings }; }
    }
  }
  return { rows, warnings };
}
