// Reads a permit REQUEST e-mail that went to a handling agent (ours, or typed by hand) and works out which
// countries and which flights it asked for. No network, no AI. The result goes to the Proposals list as
// "requested" items: a person confirms them, and the permit requests then cover exactly those flights and dates.
import { allCountries } from "./country-names";
import { statesInLine } from "./permit-reply";

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const mon = s => MONTHS[String(s || "").toUpperCase().slice(0, 3)] || null;
const p2 = n => String(n).padStart(2, "0");
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const isoOf = t => new Date(t).toISOString().slice(0, 10);
const validDay = (y, m, d) => { const t = new Date(utc(y, m, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
const isoDow = t => ((new Date(t).getUTCDay() + 6) % 7) + 1; // Mon=1 .. Sun=7

// Splits a forwarded / replied thread into blocks, newest first: the text itself, then one block per "From:" header.
export function threadBlocks(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const blocks = [[]];
  lines.forEach(l => {
    if (/^\s*(From|Von|De):\s.+/i.test(l) && /@|</.test(l)) blocks.push([]);
    else if (/^\s*-{2,}\s*(original|forwarded) message/i.test(l)) blocks.push([]);
    else if (/^\s*On .+ wrote:\s*$/.test(l)) blocks.push([]);
    blocks[blocks.length - 1].push(l.replace(/^\s*>+\s?/, ""));
  });
  return blocks.map(b => b.join("\n")).filter(b => b.trim());
}

// Year for a day/month: the first date is the nearest one on or after (ref - 60 days); later dates never go backwards.
function makeYearResolver(ref) {
  let last = null;
  return (m, d) => {
    let y = new Date(ref.getTime() - 60 * 86400000).getUTCFullYear();
    let t = validDay(y, m, d) ? utc(y, m, d) : null;
    if (t == null) return null;
    if (last == null) { while (t < ref.getTime() - 60 * 86400000) { y++; t = utc(y, m, d); } }
    else { while (t < last) { y++; if (!validDay(y, m, d)) return null; t = utc(y, m, d); } }
    last = t;
    return t;
  };
}

function expandPeriod(from, to, weekdays) {
  const out = [];
  for (let t = from; t <= to && out.length < 400; t += 86400000) if (!weekdays || weekdays.includes(isoDow(t))) out.push(isoOf(t));
  return out;
}

// One schedule line -> { number, origin, destination, dates: ["YYYY-MM-DD"] } or null
export function parseScheduleLine(line, ref = new Date()) {
  const L = line.trim().replace(/\s+/g, " ");
  const yr = makeYearResolver(ref);
  // our own layout:  5316  ALA-PQC  19:05  21:05  5 DAY FROM 30.10 TO 26.03   |  ... DAILY FROM ...  |  ... 12.11.
  let m = /^(?:[A-Z]{2,3})?(\d{1,4}[A-Z]?) ([A-Z]{3})-([A-Z]{3}) (\d{2}:?\d{2}) (\d{2}:?\d{2}|--:--) (.+)$/i.exec(L);
  if (m) {
    const rest = m[6].toUpperCase();
    const per = /^(DAILY|[1-7]+ DAY)\s+FROM (\d{1,2})\.(\d{1,2}) TO (\d{1,2})\.(\d{1,2})/.exec(rest);
    if (per) {
      const a = yr(+per[3], +per[2]), b = yr(+per[5], +per[4]);
      if (a == null || b == null) return null;
      return { number: m[1].toUpperCase(), origin: m[2].toUpperCase(), destination: m[3].toUpperCase(), dates: expandPeriod(a, b, per[1] === "DAILY" ? null : per[1].replace(/\D/g, "").split("").map(Number)) };
    }
    const singles = [...rest.matchAll(/(\d{1,2})\.(\d{1,2})\./g)];
    if (singles.length) {
      const dates = singles.map(s => yr(+s[2], +s[1])).filter(x => x != null).map(isoOf);
      return dates.length ? { number: m[1].toUpperCase(), origin: m[2].toUpperCase(), destination: m[3].toUpperCase(), dates } : null;
    }
    return null;
  }
  // typed by hand:  VSV777 SYX0830 - 1200 SIN 20 and 24 OCT   |  ... every 4th day from 29OCT till 23MAR
  m = /^(?:[A-Z]{2,3})?(\d{1,4}[A-Z]?) ([A-Z]{3}) ?(\d{4}) ?[-–] ?(\d{4}) ([A-Z]{3}) (.+)$/i.exec(L);
  if (m) {
    const rest = m[6].toUpperCase();
    const base = { number: m[1].toUpperCase(), origin: m[2].toUpperCase(), destination: m[5].toUpperCase() };
    const ev = /EVERY (\d+)(?:ST|ND|RD|TH)? DAY(?: FROM)? (\d{1,2}) ?([A-Z]{3,9}) (?:TILL|TO|UNTIL|-) (\d{1,2}) ?([A-Z]{3,9})/.exec(rest);
    if (ev && mon(ev[3]) && mon(ev[5])) {
      const a = yr(mon(ev[3]), +ev[2]), b = yr(mon(ev[5]), +ev[4]);
      if (a == null || b == null) return null;
      const step = Math.max(1, +ev[1]), dates = [];
      for (let t = a; t <= b && dates.length < 400; t += step * 86400000) dates.push(isoOf(t));
      return { ...base, dates };
    }
    const daily = /(DAILY|[1-7]+ DAY|ALL DAYS)(?: FROM)? (\d{1,2}) ?([A-Z]{3,9}) (?:TILL|TO|UNTIL|-) (\d{1,2}) ?([A-Z]{3,9})/.exec(rest);
    if (daily && mon(daily[3]) && mon(daily[5])) {
      const a = yr(mon(daily[3]), +daily[2]), b = yr(mon(daily[5]), +daily[4]);
      if (a == null || b == null) return null;
      const wd = /^[1-7]+ DAY$/.test(daily[1]) ? daily[1].replace(/\D/g, "").split("").map(Number) : null;
      return { ...base, dates: expandPeriod(a, b, wd) };
    }
    // "20 and 24 OCT"  /  "20, 24 OCT 05 NOV"
    const groups = [...rest.matchAll(/((?:\d{1,2}(?:\s*(?:AND|,|&)\s*)?)+)\s*([A-Z]{3,9})/g)];
    const dates = [];
    groups.forEach(g => { const mo = mon(g[2]); if (!mo) return; [...g[1].matchAll(/\d{1,2}/g)].forEach(d => { const t = yr(mo, +d[0]); if (t != null) dates.push(isoOf(t)); }); });
    return dates.length ? { ...base, dates } : null;
  }
  return null;
}

// Fuzzy country name for typed-by-hand lines ("AFGANISTAN" -> AF).
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function countryOfHeading(line, known) {
  const t = line.trim().replace(/^ROUTE\b[:\s-]*/i, "").replace(/[:.]+$/, "").trim();
  if (!t || t.length < 4 || t.split(/\s+/).length > 3 || /\d/.test(t)) return null;
  const hit = statesInLine(t, known);
  if (hit.length === 1 && t.length <= 40) return hit[0];
  if (/^[A-Za-z' -]+$/.test(t) && t.length >= 6) {
    const T = t.toUpperCase();
    let best = null;
    allCountries().forEach(([code, name]) => { const N = name.replace(/\s*\(.*\)/, "").toUpperCase(); if (Math.abs(N.length - T.length) > 2) return; const d = lev(T, N); if (d <= 2 && (!best || d < best.d)) best = { code, d }; });
    return best ? best.code : null;
  }
  return null;
}

// text -> { found: bool, flights: [{number, origin, destination, dates}], states: [codes], kind } for the newest request in the thread
export function readRequestMail(text, ctx = {}) {
  const ref = ctx.receivedAt ? new Date(ctx.receivedAt) : new Date();
  for (const block of threadBlocks(text)) {
    const lines = block.split("\n").map(l => l.trim());
    const flights = [];
    lines.forEach(l => { const r = parseScheduleLine(l, ref); if (r && r.dates.length) flights.push(r); });
    if (!flights.length) continue;
    // countries: headings in the ROUTE section (or after "Route:")
    const start = lines.findIndex(l => /^ROUTE\b/i.test(l));
    const states = [];
    if (start >= 0) lines.slice(start).forEach(l => { const c = countryOfHeading(l, ctx.states); if (c && !states.includes(c)) states.push(c); });
    const kind = /landing permission/i.test(block) && !/over\s?fl|ovf|\bof permit/i.test(block) ? "landing" : "overfly";
    return { found: true, flights, states, kind };
  }
  return { found: false, flights: [], states: [], kind: "overfly" };
}

// -> proposal items (one per country) in the shape the Proposals list uses. refsFor(number) -> the refs of that flight number in the schedule.
export function requestItems(read, refsFor = n => [n]) {
  if (!read.found || !read.states.length) return [];
  const refs = [...new Set(read.flights.flatMap(f => refsFor(f.number)))];
  const dates = [...new Set(read.flights.flatMap(f => f.dates))].sort().slice(0, 400);
  return read.states.map(state => ({
    kind: read.kind, state, airport: null, decision: "pending", permitNumber: null, authorityRef: null,
    validFrom: dates[0] || null, validTo: dates[dates.length - 1] || null, aircraft: [], unknownAircraft: [], dates, flights: refs,
    remarks: `Request e-mail: ${read.flights.length} schedule line(s), ${refs.length} flight number(s), ${dates.length} date(s)`, itemState: "open",
  }));
}
