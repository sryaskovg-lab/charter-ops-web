import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// Deliberately narrow, read-only tools — the bot can look things up, it can never write
// anything. Each one maps to a real Supabase query, not a guess.
const TOOLS = [
  {
    name: "search_flights",
    description: "Search scheduled flights by route, date range, and/or aircraft. All dates and times are UTC.",
    input_schema: {
      type: "object",
      properties: {
        origin: { type: "string", description: "3-4 letter origin airport code, optional" },
        destination: { type: "string", description: "3-4 letter destination airport code, optional" },
        date_from: { type: "string", description: "YYYY-MM-DD, optional" },
        date_to: { type: "string", description: "YYYY-MM-DD, optional" },
        aircraft_code: { type: "string", description: "aircraft registration e.g. UP-B3748, optional" },
      },
    },
  },
  {
    name: "get_allotment_summary",
    description: "Get seat allotment totals (seats sold, revenue in USD) for a tour operator and/or destination, across active/confirmed allotments only.",
    input_schema: {
      type: "object",
      properties: {
        operator_name: { type: "string", description: "tour operator name, optional — omit for all operators" },
        destination: { type: "string", description: "3-4 letter destination code, optional" },
      },
    },
  },
  {
    name: "list_operators",
    description: "List all tour operators with status and their default USD rate per seat.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_fleet_status",
    description: "List the fleet with capacity and how many flights each aircraft currently has on the schedule.",
    input_schema: { type: "object", properties: {} },
  },
];

async function runTool(supabase, name, input) {
  if (name === "search_flights") {
    let q = supabase.from("flights").select("ref, origin, destination, scheduled_departure, scheduled_arrival, status, capacity, resources(code)");
    if (input.origin) q = q.ilike("origin", input.origin);
    if (input.destination) q = q.ilike("destination", input.destination);
    if (input.date_from) q = q.gte("scheduled_departure", input.date_from);
    if (input.date_to) q = q.lte("scheduled_departure", input.date_to + "T23:59:59Z");
    const { data, error } = await q.order("scheduled_departure").limit(50);
    if (error) return { error: error.message };
    let rows = data || [];
    if (input.aircraft_code) rows = rows.filter(r => r.resources?.code?.toLowerCase() === input.aircraft_code.toLowerCase());
    return { flights: rows.map(r => ({ ref: r.ref, origin: r.origin, destination: r.destination, departure_utc: r.scheduled_departure, arrival_utc: r.scheduled_arrival, status: r.status, capacity: r.capacity, aircraft: r.resources?.code })) };
  }
  if (name === "get_allotment_summary") {
    const { data: allotments, error } = await supabase.from("allotments").select("seats_allocated, price_per_seat, status, tour_operators(name), flights(destination)");
    if (error) return { error: error.message };
    let rows = (allotments || []).filter(a => a.status !== "cancelled" && a.status !== "released");
    if (input.operator_name) rows = rows.filter(a => a.tour_operators?.name?.toLowerCase().includes(input.operator_name.toLowerCase()));
    if (input.destination) rows = rows.filter(a => a.flights?.destination?.toLowerCase() === input.destination.toLowerCase());
    const seats = rows.reduce((s, a) => s + a.seats_allocated, 0);
    const revenue = rows.reduce((s, a) => s + a.seats_allocated * Number(a.price_per_seat), 0);
    return { matching_allotments: rows.length, total_seats: seats, total_revenue_usd: revenue };
  }
  if (name === "list_operators") {
    const { data, error } = await supabase.from("tour_operators").select("name, status, contracts(rate_per_seat, currency)");
    if (error) return { error: error.message };
    return { operators: (data || []).map(o => ({ name: o.name, status: o.status, default_rate: o.contracts?.[0]?.rate_per_seat, currency: o.contracts?.[0]?.currency })) };
  }
  if (name === "get_fleet_status") {
    const { data: resources, error } = await supabase.from("resources").select("id, code, variant, capacity");
    if (error) return { error: error.message };
    const { data: flights } = await supabase.from("flights").select("resource_id");
    const counts = {};
    (flights || []).forEach(f => { counts[f.resource_id] = (counts[f.resource_id] || 0) + 1; });
    return { fleet: (resources || []).map(r => ({ code: r.code, variant: r.variant, capacity: r.capacity, flights_on_board: counts[r.id] || 0 })) };
  }
  return { error: "Unknown tool: " + name };
}

export async function POST(request) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return Response.json({ error: "ANTHROPIC_API_KEY is not set for this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy." }, { status: 500 });

    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Scoped to the caller's own session, not the service-role key — RLS enforces the bot
    // never surfaces anything the asking user couldn't already see in the app itself.
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { messages } = await request.json();
    const anthropic = new Anthropic({ apiKey });
    const systemPrompt = "You are the in-app assistant for Charter Ops, a charter airline scheduling tool. Answer using the tools provided to look up real flight, allotment, and tour-operator data — never guess or invent numbers, and say so plainly if a lookup comes back empty. All dates/times in the data are UTC. All currency is USD. Be concise and direct; this is a working tool for ops staff, not a chat companion.";

    let conversation = messages;
    for (let turn = 0; turn < 6; turn++) {
      const response = await anthropic.messages.create({
        model: "claude-sonnet-5",
        max_tokens: 1024,
        system: systemPrompt,
        tools: TOOLS,
        messages: conversation,
      });

      if (response.stop_reason !== "tool_use") {
        const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
        return Response.json({ reply: text });
      }

      conversation = [...conversation, { role: "assistant", content: response.content }];
      const toolResults = [];
      for (const block of response.content) {
        if (block.type === "tool_use") {
          const result = await runTool(supabase, block.name, block.input || {});
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        }
      }
      conversation = [...conversation, { role: "user", content: toolResults }];
    }
    return Response.json({ reply: "I couldn't finish that within the tool-call limit — try asking something narrower." });
  } catch (err) {
    return Response.json({ error: err.message || "Unexpected server error" }, { status: 500 });
  }
}
