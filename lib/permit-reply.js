// Reads the plain-text body of an agent's reply e-mail (no network, no AI) and proposes permit
// decisions: country, permit number, validity, granted / rejected. The result has the same shape
// as the proposals read from attachments, so a person confirms each item before anything changes.
import { allCountries } from "./country-names";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = n => String(n).padStart(2, "0");
const iso = (y, m, d) => {
  if (y < 100) y += 2000;
  const s = `${y}-${pad(m)}-${pad(d)}`;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isNaN(t) || new Date(t).getUTCMonth() + 1 !== m ? null : s;
};

// every date written in the text, in order: 24.10.2026, 24/10/26, 24-OCT-2026, 24 October 2026, 2026-10-24
export function findDates(text) {
  const out = [];
  const re = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b|\b(\d{1,2})[\s\-]?([A-Za-z]{3,9})\.?[\s\-,]*(\d{4}|\d{2})\b/g;
  let m;
  while ((m = re.exec(text))) {
    let d = null;
    if (m[1]) d = iso(+m[1], +m[2], +m[3]);
    else if (m[4]) d = iso(+m[6], +m[5], +m[4]);
    else { const mo = MONTHS[m[8].slice(0, 4).toLowerCase()] || MONTHS[m[8].slice(0, 3).toLowerCase()]; if (mo) d = iso(+m[9], mo, +m[7]); }
    if (d) out.push({ date: d, index: m.index });
  }
  return out;
}

const NUMBER_RE = /(?:permit|permission|approval|clearance|authori[sz]ation|ref(?:erence)?|number|no\.?|nr\.?|#)\s*(?:number|no\.?|nr\.?|#)?\s*[:=\-]?\s*([A-Z0-9][A-Z0-9\/\-.]{3,39})/gi;
export function findNumber(line) {
  let m;
  NUMBER_RE.lastIndex = 0;
  while ((m = NUMBER_RE.exec(line))) {
    const v = m[1].replace(/[.\-\/]+$/, "");
    if (/\d/.test(v) && !/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  }
  return null;
}

export function findDecision(line) {
  const t = line.toLowerCase();
  if (/\b(not approved|not granted|rejected|refused|denied|declined|unable to|cannot be (?:issued|granted)|no permit)\b/.test(t)) return "rejected";
  if (/\b(approved|granted|issued|confirmed|valid)\b/.test(t)) return "granted";
  if (/\b(pending|awaiting|in progress|under process|waiting)\b/.test(t)) return "pending";
  return null;
}

let cachedNames = null;
function nameIndex() {
  if (!cachedNames) {
    cachedNames = allCountries().map(([code, name]) => ({ code, name, re: new RegExp(`\\b${name.replace(/\([^)]*\)/g, "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}\\b`, "i") }))
      .sort((a, b) => b.name.length - a.name.length);
    const alias = { AF: "Afghanistan", KG: "Kyrgyz|Kyrgyzstan", MM: "Burma", CZ: "Czechia", RU: "Russian Federation", TR: "Turkiye|Türkiye", LA: "Lao", KR: "Korea", VN: "Viet\\s*nam" };
    Object.entries(alias).forEach(([code, a]) => cachedNames.push({ code, name: a, re: new RegExp(`\\b(?:${a})\\b`, "i") }));
  }
  return cachedNames;
}
// country codes named in a line (by name, or as "KG:" / "(KG)" at the start / in brackets)
export function statesInLine(line, known) {
  const out = [];
  nameIndex().forEach(n => { if (n.re.test(line) && !out.includes(n.code)) out.push(n.code); });
  const c = /^\s*\(?([A-Z]{2})\)?\s*[:\-–]/.exec(line) || /\(([A-Z]{2})\)/.exec(line);
  if (c && !out.includes(c[1]) && known && known.includes(c[1]) && !/^(RE|FW)$/.test(c[1])) out.push(c[1]);
  // "Mongolia" must not also claim "Mongolia ... Kazakhstan" overlap issues; keep order of appearance
  return out.sort((a, b) => line.toLowerCase().indexOf(String(nameOf(a)).toLowerCase()) - line.toLowerCase().indexOf(String(nameOf(b)).toLowerCase()));
}
function nameOf(code) { const x = allCountries().find(([c]) => c === code); return x ? x[1].replace(/\s*\(.*\)/, "") : code; }

// text: reply body. ctx: { subject, receivedAt, states: [codes the app knows] }
// returns items in the proposal shape (no `match` yet).
export function readReplyBody(text, ctx = {}) {
  const lines = String(text || "").replace(/\r/g, "").split("\n")
    .filter(l => !/^\s*>/.test(l)); // drop quoted earlier messages
  const cut = lines.findIndex(l => /^\s*(on .+ wrote:|-{2,}\s*(original|forwarded) message|from:\s.+@)/i.test(l));
  const body = cut > 0 ? lines.slice(0, cut) : lines;
  const items = [];
  const subjectStates = statesInLine(ctx.subject || "", ctx.states);
  let current = null; // a state line opens a block that follows lines can complete
  const flush = () => { if (current) { push(current); current = null; } };
  function push(b) {
    const joined = b.lines.join(" ");
    const decision = b.decision || (b.number ? "granted" : null);
    if (!decision || (decision === "pending")) return;
    if (decision === "granted" && !b.number && !b.dates.length) return;
    const ds = b.dates.map(d => d.date).sort();
    let vf = null, vt = null;
    if (ds.length >= 2) { vf = ds[0]; vt = ds[ds.length - 1]; }
    else if (ds.length === 1) { if (/\b(until|till|to|expires?|expiry)\b/i.test(joined)) vt = ds[0]; else vf = ds[0]; }
    b.states.forEach(state => items.push({
      kind: /\b(landing|ldg|lnd|arrival)\b/i.test(joined) && !/\b(overfl|ovf|o\/f)/i.test(joined) ? "landing" : "overfly",
      state, airport: null, decision, permitNumber: b.number || null, authorityRef: null,
      validFrom: vf, validTo: vt, aircraft: [], unknownAircraft: [], dates: [], flights: [],
      remarks: joined.replace(/\s+/g, " ").trim().slice(0, 280), itemState: "open",
    }));
  }
  body.forEach(raw => {
    const line = raw.trim();
    if (!line) return;
    const st = statesInLine(line, ctx.states);
    if (st.length) {
      flush();
      current = { states: st, lines: [line], number: findNumber(line), decision: findDecision(line), dates: findDates(line) };
      return;
    }
    if (current && current.lines.length < 4) {
      current.lines.push(line);
      current.number = current.number || findNumber(line);
      current.decision = current.decision || findDecision(line);
      current.dates.push(...findDates(line));
    } else if (!current) {
      // text before any country line: applies to the country in the subject
      if (subjectStates.length && (findNumber(line) || findDecision(line))) current = { states: subjectStates, lines: [line], number: findNumber(line), decision: findDecision(line), dates: findDates(line) };
    }
  });
  flush();
  // one item per country/kind
  const seen = new Set();
  return items.filter(i => { const k = `${i.kind}|${i.state}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
