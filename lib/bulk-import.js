// Bulk loading of fuel prices, airport fees and average flight times from a spreadsheet grid
// (rows of cells as read from CSV or Excel). Pure functions: parsing, validation and CSV export.

import { CURRENCIES, normCurrency } from "./fx.js";

export const norm = s => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const LOOKALIKE = { "А": "A", "В": "B", "С": "C", "Е": "E", "Н": "H", "К": "K", "М": "M", "О": "O", "Р": "P", "Т": "T", "Х": "X", "У": "Y" };
export function cleanCode(s) {
  return String(s ?? "").trim().toUpperCase().replace(/[АВСЕНКМОРТХУ]/g, c => LOOKALIKE[c]).replace(/[^A-Z0-9]/g, "");
}

export function toNumber(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[\s $€]/g, "").replace(/usd/i, "");
  if (!s) return null;
  const t = /,/.test(s) && /\./.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTHS_RU = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const ym = (y, m) => (y >= 2000 && y <= 2100 && m >= 1 && m <= 12) ? `${y}-${String(m).padStart(2, "0")}-01` : null;

// Returns "YYYY-MM-01" or null.
export function toMonth(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : ym(v.getFullYear(), v.getMonth() + 1);
  if (typeof v === "number") return v > 30000 && v < 80000 ? toMonth(new Date(Math.round((v - 25569) * 86400000) + 43200000)) : null;
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})(?:[-/.]\d{1,2})?$/))) return ym(+m[1], +m[2]);
  if ((m = s.match(/^(\d{1,2})[-/.](\d{4})$/))) return ym(+m[2], +m[1]);
  if ((m = s.match(/^\d{1,2}[-/.](\d{1,2})[-/.](\d{4})$/))) return ym(+m[2], +m[1]);
  if ((m = s.match(/^([a-zа-я]{3,})[\s\-.,]*(\d{4})$/))) {
    const i = MONTHS.indexOf(m[1].slice(0, 3)), j = MONTHS_RU.indexOf(m[1].slice(0, 3));
    const k = i >= 0 ? i : j;
    return k >= 0 ? ym(+m[2], k + 1) : null;
  }
  return null;
}

// Average flight time in minutes. unitHint: "min" | "h" | "" (unknown).
export function toMinutes(v, unitHint = "") {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getUTCHours() * 60 + v.getUTCMinutes();
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v <= 0) return null;
    if (unitHint === "h") return Math.round(v * 60);
    if (unitHint === "min") return Math.round(v);
    return v < 1 ? Math.round(v * 1440) : Math.round(v); // a bare number under 1 is an Excel time (fraction of a day)
  }
  const s = String(v).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/))) return +m[1] * 60 + +m[2];
  if ((m = s.match(/^(\d+)\s*(?:h|ч)[\s.]*(?:(\d+)\s*(?:m|min|м|мин)?)?$/))) return +m[1] * 60 + (m[2] ? +m[2] : 0);
  const n = toNumber(s);
  return n == null ? null : toMinutes(n, unitHint);
}

const BASIS_MAP = {
  зазаход: "turnaround", запериод: "time", запассажира: "pax", зачленаэкипажа: "crew", затоннуmtow: "mtow_t", затоннутоплива: "fuel_t", залитр: "litre",
  turnaround: "turnaround", pertunaround: "turnaround", pertuaround: "turnaround", perturnaround: "turnaround", заход: "turnaround", рейс: "turnaround",
  time: "time", period: "time", perperiod: "time", час: "time", период: "time",
  pax: "pax", passenger: "pax", perpassenger: "pax", пассажир: "pax",
  crew: "crew", percrewmember: "crew", экипаж: "crew",
  mtow: "mtow_t", mtowt: "mtow_t", pertonnemtow: "mtow_t", тонна: "mtow_t",
  fuel: "fuel_t", fuelt: "fuel_t", pertonneoffuel: "fuel_t", топливо: "fuel_t",
  litre: "litre", liter: "litre", perlitre: "litre", литр: "litre",
};
export function toBasis(v) { return BASIS_MAP[norm(v)] || null; }

const SET_MAP = { стандартный: "STD", международные: "INT", международныемвл: "INT", внутренниеввл: "DOM", внутренние: "DOM", std: "STD", standard: "STD", "": "STD", int: "INT", intl: "INT", international: "INT", мвл: "INT", dom: "DOM", domestic: "DOM", ввл: "DOM" };
export function toFeeSet(v) { return SET_MAP[norm(v)] ?? null; }

// "EUR/tonne", "USD/kg", "tonne", "€ per litre" ... -> "<CUR>/<per>"; the currency defaults to defCur
export function toFuelUnit(v, defCur = "USD", curCell = "") {
  let s = String(v ?? "").trim();
  let cur = curCell ? normCurrency(curCell) : null;
  const tok = s.match(/\b([A-Za-z]{3})\b/g) || [];
  for (const t of tok) { const c = normCurrency(t); if (c && CURRENCIES.includes(c) && !/^(kg|usg|lit)$/i.test(t) && !/^per$/i.test(t)) { cur = cur || c; s = s.replace(new RegExp("\\b" + t + "\\b"), ""); break; } }
  const sym = s.match(/[€£₸₽¥$]/);
  if (sym) { cur = cur || normCurrency(sym[0]); s = s.replace(sym[0], ""); }
  cur = cur || defCur;
  s = s.replace(/[\s/]+/g, " ").trim().toLowerCase();
  if (!s || s === "per") return cur + "/tonne";
  if (/usg|gal/.test(s)) return cur + "/USG";
  if (/kg|кг/.test(s)) return cur + "/kg";
  if (/lit|^l$|л/.test(s)) return cur + "/litre";
  if (/t|т/.test(s)) return cur + "/tonne";
  return null;
}

// ---- grid helpers ----
function findHeader(grid, aliases, extraHit) {
  const keys = Object.entries(aliases);
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    const cols = {};
    let extra = 0;
    (grid[i] || []).forEach((c, j) => {
      const n = norm(c);
      if (!n) return;
      const hit = keys.find(([, list]) => list.includes(n));
      if (hit && cols[hit[0]] === undefined) cols[hit[0]] = j;
      else if (!hit && extraHit && extraHit(c)) extra++;
    });
    if (Object.keys(cols).length + (extra ? 1 : 0) >= 2) return { row: i, cols };
  }
  return null;
}
const blank = r => !r || r.every(c => c == null || String(c).trim() === "");

const FUEL_ALIASES = {
  airport: ["airport", "icao", "iata", "code", "airportcode", "аэропорт", "код"],
  price: ["price", "fuelprice", "цена", "стоимость"],
  unit: ["unit", "units", "uom", "единица", "единицаизмерения", "ед"],
  currency: ["currency", "cur", "ccy", "валюта"],
  month: ["month", "period", "date", "месяц", "дата", "validfrom", "действуетс"],
  supplier: ["supplier", "vendor", "поставщик"],
  note: ["note", "notes", "comment", "примечание"],
};

// -> { rows: [{airport, month, price, unit, supplier, note}], errors: [{line, reason}], wide: bool }
export function parseFuelGrid(grid, { defaultMonth, knownAirports, lang, defaultCurrency = "USD" } = {}) {
  const L = (en, ru) => (lang === "ru" ? ru : en);
  const out = { rows: [], errors: [], wide: false };
  const h = findHeader(grid, FUEL_ALIASES, c => !!toMonth(c));
  if (!h || h.cols.airport === undefined) { out.errors.push({ line: 0, reason: L("Header row not found: the file needs an Airport column and either Price or one column per month (2026-10, 2026-11 ...).", "Строка заголовков не найдена: в файле нужен столбец «Аэропорт» и либо «Цена», либо по одному столбцу на месяц (2026-10, 2026-11 ...).") }); return out; }
  const monthCols = [];
  (grid[h.row] || []).forEach((c, j) => { if (!Object.values(h.cols).includes(j)) { const m = toMonth(c); if (m) monthCols.push([j, m]); } });
  out.wide = h.cols.price === undefined && monthCols.length > 0;
  if (h.cols.price === undefined && !out.wide) { out.errors.push({ line: h.row + 1, reason: L("No Price column and no month columns found.", "Нет столбца «Цена» и столбцов с месяцами.") }); return out; }
  const seen = new Set();
  for (let i = h.row + 1; i < grid.length; i++) {
    const r = grid[i]; if (blank(r)) continue;
    const line = i + 1;
    const airport = cleanCode(r[h.cols.airport]);
    if (!/^[A-Z0-9]{3,4}$/.test(airport)) { out.errors.push({ line, reason: L(`Airport code "${r[h.cols.airport] ?? ""}" is not 3 or 4 letters`, `Код аэропорта "${r[h.cols.airport] ?? ""}" — не 3 и не 4 буквы`) }); continue; }
    if (knownAirports && !knownAirports.has(airport)) { out.errors.push({ line, reason: L(`Airport ${airport} is not in the airport list`, `Аэропорт ${airport} отсутствует в списке аэропортов`) }); continue; }
    const unit = toFuelUnit(h.cols.unit !== undefined ? r[h.cols.unit] : "", defaultCurrency, h.cols.currency !== undefined ? r[h.cols.currency] : "");
    if (!unit) { out.errors.push({ line, reason: L(`Unit "${r[h.cols.unit]}" not recognised (use tonne, kg, USG or litre, optionally with a currency: EUR/tonne)`, `Единица "${r[h.cols.unit]}" не распознана (используйте tonne, kg, USG или litre, можно с валютой: EUR/tonne)`) }); continue; }
    const supplier = h.cols.supplier !== undefined ? String(r[h.cols.supplier] ?? "").trim() || null : null;
    const note = h.cols.note !== undefined ? String(r[h.cols.note] ?? "").trim() || null : null;
    const cells = out.wide ? monthCols.map(([j, m]) => [m, r[j]]) : [[h.cols.month !== undefined && r[h.cols.month] != null && r[h.cols.month] !== "" ? toMonth(r[h.cols.month]) : defaultMonth, r[h.cols.price]]];
    for (const [month, raw] of cells) {
      if (raw == null || String(raw).trim() === "") { if (!out.wide) out.errors.push({ line, reason: L(`${airport}: price is empty`, `${airport}: цена не заполнена`) }); continue; }
      const price = toNumber(raw);
      if (!month) { out.errors.push({ line, reason: L(`${airport}: month "${r[h.cols.month]}" not recognised (use 2026-11 or a date)`, `${airport}: месяц "${r[h.cols.month]}" не распознан (используйте 2026-11 или дату)`) }); continue; }
      if (price == null || price < 0) { out.errors.push({ line, reason: L(`${airport}: price "${raw}" is not a number`, `${airport}: цена "${raw}" не является числом`) }); continue; }
      const key = `${airport}|${month}`;
      if (seen.has(key)) { out.errors.push({ line, reason: L(`${airport} ${month.slice(0, 7)} appears twice (the later line wins)`, `${airport} ${month.slice(0, 7)} встречается дважды (действует последняя строка)`) }); out.rows = out.rows.filter(x => `${x.airport}|${x.month}` !== key); }
      seen.add(key);
      out.rows.push({ airport, month, price, unit, supplier, note });
    }
  }
  return out;
}

const FEE_ALIASES = {
  airport: ["airport", "icao", "iata", "code", "аэропорт", "код"],
  feeSet: ["feeset", "set", "type", "flighttype", "тип", "мвлввл", "наборсборов", "типсбора"],
  name: ["name", "item", "fee", "description", "charge", "наименование", "название", "сбор"],
  basis: ["basis", "chargedper", "chargedby", "per", "charged", "основание", "расчет", "начисляетсяза", "начисляется"],
  price: ["price", "priceusd", "usd", "rate", "amount", "цена", "тариф", "ценаusd"],
  quantity: ["quantity", "qty", "количество", "кол"],
  period: ["periodminutes", "period", "periodmin", "minutes", "min", "периодмин"],
  aircraft: ["aircrafttype", "aircraft", "onlyfor", "type", "ac", "типвс", "вс"],
};

// -> { rows: [{airport, fee_set, name, basis, price_usd, quantity, period_minutes, aircraft_type}], errors }
export function parseFeesGrid(grid, { aircraftCodes, lang } = {}) {
  const L = (en, ru) => (lang === "ru" ? ru : en);
  const out = { rows: [], errors: [] };
  // "type" is ambiguous (fee set or aircraft): the first one found is the fee set, so give aircraft its own aliases priority
  const aliases = { ...FEE_ALIASES, feeSet: FEE_ALIASES.feeSet.filter(x => x !== "type"), aircraft: FEE_ALIASES.aircraft.filter(x => x !== "type") };
  aliases.feeSet.push("type"); // used only if no other header claims it; aircraft keeps its own names
  const h = findHeader(grid, aliases);
  if (!h || h.cols.airport === undefined || h.cols.name === undefined || h.cols.price === undefined) { out.errors.push({ line: 0, reason: L("Header row not found: the file needs Airport, Name and Price columns (optional: Fee set, Charged per, Quantity, Period minutes, Aircraft type).", "Строка заголовков не найдена: в файле нужны столбцы «Аэропорт», «Название» и «Цена» (необязательно: «Набор сборов», «Начисляется за», «Количество», «Период, мин», «Тип ВС»).") }); return out; }
  const codes = aircraftCodes ? new Map(aircraftCodes.map(c => [String(c).toUpperCase(), c])) : null;
  for (let i = h.row + 1; i < grid.length; i++) {
    const r = grid[i]; if (blank(r)) continue;
    const line = i + 1, get = k => (h.cols[k] !== undefined ? r[h.cols[k]] : null);
    const airport = cleanCode(get("airport"));
    if (!/^[A-Z0-9]{3,4}$/.test(airport)) { out.errors.push({ line, reason: L(`Airport code "${get("airport") ?? ""}" is not 3 or 4 letters`, `Код аэропорта "${get("airport") ?? ""}" — не 3 и не 4 буквы`) }); continue; }
    const name = String(get("name") ?? "").trim();
    if (!name) { out.errors.push({ line, reason: L(`${airport}: fee name is empty`, `${airport}: название сбора не заполнено`) }); continue; }
    const price = toNumber(get("price"));
    if (price == null || price < 0) { out.errors.push({ line, reason: L(`${airport} ${name}: price "${get("price") ?? ""}" is not a number`, `${airport} ${name}: цена "${get("price") ?? ""}" не является числом`) }); continue; }
    const basis = h.cols.basis === undefined ? "turnaround" : toBasis(get("basis"));
    if (!basis) { out.errors.push({ line, reason: L(`${airport} ${name}: "${get("basis")}" is not a known way of charging (per turnaround, per period, per passenger, per crew member, per tonne MTOW, per tonne of fuel, per litre)`, `${airport} ${name}: "${get("basis")}" — неизвестный способ начисления (за заход, за период, за пассажира, за члена экипажа, за тонну MTOW, за тонну топлива, за литр)`) }); continue; }
    const fee_set = h.cols.feeSet === undefined ? "STD" : toFeeSet(get("feeSet"));
    if (!fee_set) { out.errors.push({ line, reason: L(`${airport} ${name}: fee set "${get("feeSet")}" is not STD, INT or DOM`, `${airport} ${name}: набор сборов "${get("feeSet")}" — не STD, INT и не DOM`) }); continue; }
    const qRaw = get("quantity"), quantity = qRaw == null || qRaw === "" ? null : toNumber(qRaw);
    if (qRaw != null && qRaw !== "" && quantity == null) { out.errors.push({ line, reason: L(`${airport} ${name}: quantity "${qRaw}" is not a number`, `${airport} ${name}: количество "${qRaw}" не является числом`) }); continue; }
    const pRaw = get("period"), period_minutes = pRaw == null || pRaw === "" ? null : toNumber(pRaw);
    if (basis === "time" && !(period_minutes > 0)) { out.errors.push({ line, reason: L(`${airport} ${name}: a per-period fee needs the period length in minutes`, `${airport} ${name}: для сбора за период нужна длина периода в минутах`) }); continue; }
    const acRaw = String(get("aircraft") ?? "").trim();
    let aircraft_type = null;
    if (acRaw && !/^(all|any|-|—)$/i.test(acRaw)) {
      aircraft_type = codes ? (codes.get(acRaw.toUpperCase()) || null) : acRaw;
      if (!aircraft_type) { out.errors.push({ line, reason: L(`${airport} ${name}: aircraft type "${acRaw}" is not in the aircraft list`, `${airport} ${name}: тип ВС "${acRaw}" отсутствует в списке типов`) }); continue; }
    }
    out.rows.push({ airport, fee_set, name, basis, price_usd: price, quantity, period_minutes: basis === "time" ? Math.round(period_minutes) : (period_minutes ? Math.round(period_minutes) : null), aircraft_type });
  }
  return out;
}

const TIME_ALIASES = {
  origin: ["origin", "from", "departure", "dep", "откуда", "вылет"],
  destination: ["destination", "to", "arrival", "arr", "куда", "прилет"],
  minutes: ["minutes", "min", "avgminutes", "averageminutes", "avgmin", "avgflighttimemin", "минуты"],
  hours: ["hours", "hrs", "avghours", "averagehours", "avgflighttimeh", "часы"],
  time: ["time", "avgtime", "averagetime", "avgflighttime", "averageflighttime", "flighttime", "blocktime", "avgblocktime", "время", "времяполета"],
  km: ["km", "distance", "distancekm", "dist", "расстояние", "км", "расстояниекм"],
  note: ["note", "notes", "comment", "примечание"],
};

// -> { rows: [{origin, destination, avg_minutes, km}], errors }
export function parseTimesGrid(grid, { lang } = {}) {
  const L = (en, ru) => (lang === "ru" ? ru : en);
  const out = { rows: [], errors: [] };
  const h = findHeader(grid, TIME_ALIASES);
  if (!h || h.cols.origin === undefined || h.cols.destination === undefined || (h.cols.minutes === undefined && h.cols.hours === undefined && h.cols.time === undefined)) {
    out.errors.push({ line: 0, reason: L("Header row not found: the file needs From, To and a flight time column (Minutes, Hours or Time as 2:35). Distance in km is optional.", "Строка заголовков не найдена: в файле нужны столбцы «Откуда», «Куда» и время полёта («Минуты», «Часы» или «Время» в виде 2:35). Расстояние в км необязательно.") }); return out;
  }
  const seen = new Set();
  for (let i = h.row + 1; i < grid.length; i++) {
    const r = grid[i]; if (blank(r)) continue;
    const line = i + 1, get = k => (h.cols[k] !== undefined ? r[h.cols[k]] : null);
    const origin = cleanCode(get("origin")), destination = cleanCode(get("destination"));
    if (!/^[A-Z0-9]{3,4}$/.test(origin) || !/^[A-Z0-9]{3,4}$/.test(destination)) { out.errors.push({ line, reason: L(`Airport codes "${get("origin") ?? ""}" / "${get("destination") ?? ""}" are not 3 or 4 letters`, `Коды аэропортов "${get("origin") ?? ""}" / "${get("destination") ?? ""}" — не 3 и не 4 буквы`) }); continue; }
    if (origin === destination) { out.errors.push({ line, reason: L(`${origin}: from and to are the same`, `${origin}: «откуда» и «куда» совпадают`) }); continue; }
    const raw = h.cols.minutes !== undefined ? get("minutes") : h.cols.hours !== undefined ? get("hours") : get("time");
    const mins = toMinutes(raw, h.cols.minutes !== undefined ? "min" : h.cols.hours !== undefined ? "h" : "");
    if (!(mins > 0) || mins > 1500) { out.errors.push({ line, reason: L(`${origin}-${destination}: flight time "${raw ?? ""}" not recognised (use minutes, hours or 2:35)`, `${origin}-${destination}: время полёта "${raw ?? ""}" не распознано (используйте минуты, часы или 2:35)`) }); continue; }
    const kmRaw = get("km"), km = kmRaw == null || kmRaw === "" ? null : toNumber(kmRaw);
    if (kmRaw != null && kmRaw !== "" && (km == null || km < 0)) { out.errors.push({ line, reason: L(`${origin}-${destination}: distance "${kmRaw}" is not a number`, `${origin}-${destination}: расстояние "${kmRaw}" не является числом`) }); continue; }
    const key = `${origin}|${destination}`;
    if (seen.has(key)) { out.rows = out.rows.filter(x => `${x.origin}|${x.destination}` !== key); out.errors.push({ line, reason: L(`${origin}-${destination} appears twice (the later line wins)`, `${origin}-${destination} встречается дважды (действует последняя строка)`) }); }
    seen.add(key);
    out.rows.push({ origin, destination, avg_minutes: mins, km: km || null });
  }
  return out;
}

// ---- CSV export ----
export function toCsv(rows, cols) {
  const q = v => { const s = v == null ? "" : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return "﻿" + [cols.map(c => q(c.label)).join(","), ...rows.map(r => cols.map(c => q(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","))].join("\r\n");
}

// Price for an airport in a month: the latest history entry up to that month, else the current price.
// history: [{airport, month: "YYYY-MM-01", price, unit}], current: Map airport -> {price, unit}
export function pickFuelPrice(history, current, airport, month) {
  let best = null;
  for (const h of history) if (h.airport === airport && String(h.month).slice(0, 10) <= month && (!best || h.month > best.month)) best = h;
  if (best) return { price: Number(best.price), unit: best.unit, month: String(best.month).slice(0, 7), exact: String(best.month).slice(0, 7) === month.slice(0, 7) };
  const c = current?.get?.(airport);
  return c ? { price: Number(c.price), unit: c.unit, month: null, exact: false } : null;
}
