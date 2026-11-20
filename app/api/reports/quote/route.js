import React from "react";
import { createClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import QuoteDocument from "./QuoteDocument.jsx";
import { computeQuote } from "../../../../lib/charter-calc";

export const runtime = "nodejs";

export async function POST(request) {
  try {
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { global: { headers: { Authorization: `Bearer ${token}` } } });
    const { data: u, error: ue } = await supabase.auth.getUser(token);
    if (ue || !u?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { input, lang } = await request.json();
    if (!input?.aircraft || !Array.isArray(input.legs) || !input.legs.length || !Array.isArray(input.blocks)) return Response.json({ error: "A quote needs an aircraft, at least one leg and the airport blocks." }, { status: 400 });
    // recomputed here from the inputs, so the PDF always matches the formulas
    const q = computeQuote(input);
    const generated = new Date().toISOString().slice(0, 10);
    const buf = await renderToBuffer(React.createElement(QuoteDocument, { q, input, lang: lang === "en" ? "en" : "ru", generated }));
    const route = [input.legs[0].from, ...input.legs.map(l => l.to)].join("-");
    return new Response(buf, { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="charter-quote-${route}-${generated}.pdf"` } });
  } catch (err) {
    console.error("Quote PDF failed:", err);
    return Response.json({ error: err.message || "Quote PDF failed" }, { status: 500 });
  }
}
