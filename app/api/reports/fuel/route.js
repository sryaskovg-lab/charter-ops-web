import React from "react";
import fs from "fs";
import path from "path";
import { createClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import FuelDocument from "./FuelDocument.jsx";
import { fetchAllPages } from "../../../../lib/fetchAllPages";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Runs as the caller, so row-level security decides what the report may show.
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    let lang = "en";
    try { const b = await request.json(); if (b?.lang === "ru") lang = "ru"; } catch { /* no body: English */ }
    const [{ data: flights, error: fe }, { data: prices, error: pe }] = await Promise.all([
      fetchAllPages(() => supabase.from("flights").select("id,origin,destination").order("id")),
      supabase.from("airport_fuel_prices").select("airport,price,unit,supplier,valid_from,updated_at"),
    ]);
    if (fe || pe) return Response.json({ error: (fe || pe).message }, { status: 500 });

    const count = new Map();
    (flights || []).forEach(f => [f.origin, f.destination].forEach(c => { if (c) { const k = String(c).toUpperCase(); count.set(k, (count.get(k) || 0) + 1); } }));
    const byCode = new Map((prices || []).map(p => [p.airport, p]));
    let names = new Map();
    try {
      const a = JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", "airports.json"), "utf8"));
      names = new Map(a.map(x => [x[0], `${x[5]} (${x[4]})`]));
    } catch { /* names are optional */ }

    const rows = [...count.keys()].sort().map(code => {
      const p = byCode.get(code);
      return { code, name: names.get(code) || "", flights: count.get(code), price: p ? Number(p.price) : null, unit: p?.unit, supplier: p?.supplier, valid_from: p?.valid_from, updated: p?.updated_at ? String(p.updated_at).slice(0, 10) : "" };
    });
    const priced = rows.filter(r => r.price != null).length;
    const generated = new Date().toISOString().slice(0, 16).replace("T", " ");
    const buf = await renderToBuffer(React.createElement(FuelDocument, { rows, generated, priced, lang }));
    return new Response(buf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="fuel-prices-${generated.slice(0, 10)}.pdf"` } });
  } catch (err) {
    console.error("Fuel report failed:", err);
    return Response.json({ error: err.message || "Fuel report failed" }, { status: 500 });
  }
}
