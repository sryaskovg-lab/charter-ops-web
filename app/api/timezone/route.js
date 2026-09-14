import { supabaseAdmin } from "../../../lib/supabaseAdmin";

// GET /api/timezone?code=AYT -> { code, tz } | { code, tz: null, error }
//
// Never called directly from the browser with the API key — this route holds
// APIFREAKS_API_KEY server-side and the client only ever talks to this endpoint.
// Checks the `station_timezones` cache first so a given airport is looked up
// against APIFreaks at most once, ever, across every user of this deployment.
export async function GET(request) {
  const code = new URL(request.url).searchParams.get("code")?.toUpperCase();
  if (!code || !/^[A-Z]{3}$/.test(code)) {
    return Response.json({ error: "Provide a 3-letter IATA code as ?code=" }, { status: 400 });
  }

  const { data: cached } = await supabaseAdmin.from("station_timezones").select("tz").eq("code", code).maybeSingle();
  if (cached) return Response.json({ code, tz: cached.tz, cached: true });

  if (!process.env.APIFREAKS_API_KEY) {
    return Response.json({ code, tz: null, error: "APIFREAKS_API_KEY not configured" }, { status: 500 });
  }

  try {
    const url = `https://api.apifreaks.com/v2.0/geolocation/timezone?iata_code=${code}&apiKey=${process.env.APIFREAKS_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const tz = data?.time_zone?.name;
    if (!res.ok || !tz) {
      return Response.json({ code, tz: null, error: data?.message || "Not found" }, { status: 404 });
    }
    await supabaseAdmin.from("station_timezones").upsert({ code, tz, source: "apifreaks" });
    return Response.json({ code, tz, cached: false });
  } catch (e) {
    return Response.json({ code, tz: null, error: e.message }, { status: 502 });
  }
}
