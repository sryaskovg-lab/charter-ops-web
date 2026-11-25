// Currency conversion to USD. Rates are "units of currency per 1 USD" (as the live rate source gives them).
export const CURRENCIES = ["USD", "EUR", "KZT", "RUB", "GBP", "CNY", "AED", "TRY", "UZS", "KGS", "GEL", "AMD", "AZN", "BYN", "THB", "VND", "CHF", "JPY", "INR"];

// override: a rate typed by hand for this conversion (units of currency per 1 USD); wins over the live rate.
export function toUsd(amount, currency, rates, override) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return null;
  const cur = String(currency || "USD").toUpperCase();
  if (cur === "USD") return a;
  const o = Number(override);
  const rate = Number.isFinite(o) && o > 0 ? o : Number(rates?.[cur]);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  return a / rate;
}

export const roundUsd = (x, d = 4) => Math.round((Number(x) + Number.EPSILON) * 10 ** d) / 10 ** d;

// Picks the 3-letter currency out of strings like "EUR", "€", "eur/tonne".
const SYMBOLS = { "€": "EUR", "£": "GBP", "₸": "KZT", "₽": "RUB", "¥": "CNY", "$": "USD" };
export function normCurrency(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (SYMBOLS[s]) return SYMBOLS[s];
  const m = s.toUpperCase().match(/^[A-Z]{3}$/);
  return m ? m[0] : null;
}

// USD value of a stored fee: the original amount at the live rate, or the saved USD snapshot when there is no rate
export function storedUsd(row, usdField, origField, rates) {
  const cur = row?.currency || "USD";
  const orig = row?.[origField];
  if (cur !== "USD" && orig != null && orig !== "") {
    const u = toUsd(Number(orig), cur, rates);
    if (u != null) return u;
  }
  return Number(row?.[usdField]);
}
