import { createClient } from "@supabase/supabase-js";
import { CURRENCIES } from "../../../lib/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Live exchange rates (units of currency per 1 USD) from free public sources, cached in memory for 30 minutes.
// A signed-in user is required. The sources are tried in turn; if none answers, the caller types the rate by hand.
let cache = null;
const SOURCES = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD", read: j => ({ rates: j.rates, updated: j.time_last_update_utc ? new Date(j.time_last_update_utc).toISOString() : null, ok: j.result === "success" }) },
  { name: "exchangerate-api.com", url: "https://api.exchangerate-api.com/v4/latest/USD", read: j => ({ rates: j.rates, updated: j.time_last_updated ? new Date(j.time_last_updated * 1000).toISOString() : null, ok: !!j.rates }) },
];

async function fetchRates() {
  const errors = [];
  for (const s of SOURCES) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(s.url, { signal: ctl.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = s.read(await res.json());
      if (!r.ok || !r.rates) throw new Error("unexpected answer");
      const rates = {};
      CURRENCIES.forEach(c => { if (Number(r.rates[c]) > 0) rates[c] = Number(r.rates[c]); });
      if (!rates.EUR) throw new Error("no EUR rate in the answer");
      return { rates, updated: r.updated || new Date().toISOString(), source: s.name };
    } catch (e) { errors.push(`${s.name}: ${e.message}`); }
  }
  throw new Error(`No exchange rate source answered (${errors.join("; ")})`);
}

export async function GET(request) {
  try {
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: { user } } = await supabase.auth.getUser(token);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!cache || Date.now() - cache.at > 30 * 60 * 1000) cache = { at: Date.now(), data: await fetchRates() };
    return Response.json({ ...cache.data, base: "USD" });
  } catch (err) {
    return Response.json({ error: err.message || "Exchange rates unavailable" }, { status: 502 });
  }
}
