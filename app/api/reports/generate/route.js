import React from "react";
import { createClient } from "@supabase/supabase-js";
import { renderToBuffer } from "@react-pdf/renderer";
import { computeScheduleIssues } from "../../../../lib/scheduling-utils";
import ReportDocument from "./ReportDocument.jsx";
import { fetchAllPages } from "../../../../lib/fetchAllPages";

function iso(d) { return new Date(d).toISOString().slice(0, 10); }

export async function POST(request) {
  try {
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    // Scoped to the caller's own session — RLS enforces the report never surfaces anything
    // the requesting user couldn't already see in the app itself.
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { startDate, endDate, sections } = await request.json();
    if (!startDate || !endDate || !Array.isArray(sections) || sections.length === 0) {
      return Response.json({ error: "startDate, endDate, and at least one section are required." }, { status: 400 });
    }
    const startISO = new Date(startDate + "T00:00:00Z").toISOString();
    const endISO = new Date(endDate + "T23:59:59Z").toISOString();

    const [{ data: flights }, { data: resources }, { data: operators }, { data: allotments }, { data: scrLog }, { data: slotRequests }, { data: maintenanceRows }] = await Promise.all([
      fetchAllPages(() => supabase.from("flights").select("*").gte("scheduled_departure", startISO).lte("scheduled_departure", endISO).order("scheduled_departure").order("id")),
      supabase.from("resources").select("*"),
      supabase.from("tour_operators").select("*"),
      fetchAllPages(() => supabase.from("allotments").select("*").order("id")),
      supabase.from("scr_log").select("*").gte("created_at", startISO).lte("created_at", endISO).order("created_at"),
      fetchAllPages(() => supabase.from("slot_requests").select("*").order("id")),
      supabase.from("maintenance_blocks").select("*"),
    ]);

    const flightList = flights || [];
    const flightIds = new Set(flightList.map(f => f.id));
    const resourceCodeById = Object.fromEntries((resources || []).map(r => [r.id, r.code]));
    const operatorNameById = Object.fromEntries((operators || []).map(o => [o.id, o.name]));
    const flightRefById = Object.fromEntries(flightList.map(f => [f.id, f.ref]));
    const flightDateById = Object.fromEntries(flightList.map(f => [f.id, iso(f.scheduled_departure)]));

    const allotmentsInRange = (allotments || []).filter(a => flightIds.has(a.flight_id));
    const activeAllotments = allotmentsInRange.filter(a => a.status !== "cancelled" && a.status !== "released");
    const totalRevenue = activeAllotments.reduce((s, a) => s + a.seats_allocated * a.price_per_seat, 0);
    const totalSeatsSold = activeAllotments.reduce((s, a) => s + a.seats_allocated, 0);
    const revenueByOperator = {};
    activeAllotments.forEach(a => {
      const name = operatorNameById[a.tour_operator_id] || "Unknown";
      if (!revenueByOperator[name]) revenueByOperator[name] = { seats: 0, revenue: 0 };
      revenueByOperator[name].seats += a.seats_allocated;
      revenueByOperator[name].revenue += a.seats_allocated * a.price_per_seat;
    });

    const utilization = (resources || []).map(r => {
      const rFlights = flightList.filter(f => f.resource_id === r.id);
      const seatsSold = activeAllotments.filter(a => rFlights.some(f => f.id === a.flight_id)).reduce((s, a) => s + a.seats_allocated, 0);
      return { code: r.code, variant: r.variant, flightCount: rFlights.length, seatsSold };
    }).sort((a, b) => b.flightCount - a.flightCount);

    // computeScheduleIssues expects the app's mapped shape (camelCase, real Date objects) —
    // reusing the exact same pure function the Issues panel itself runs, not a re-derived copy.
    const mappedFlights = flightList.map(f => ({
      id: f.id, ref: f.ref, resourceId: f.resource_id, origin: f.origin, destination: f.destination,
      start: new Date(f.scheduled_departure), arrivalAt: f.scheduled_arrival ? new Date(f.scheduled_arrival) : null,
      capacity: f.capacity, status: f.status, legType: f.leg_type,
    }));
    const mappedResources = (resources || []).map(r => ({ id: r.id, code: r.code, capacity: r.capacity }));
    const mappedSlotRequests = (slotRequests || []).filter(s => flightIds.has(s.flight_id)).map(s => ({ id: s.id, flightId: s.flight_id, movementType: s.movement_type, airport: s.airport, status: s.status }));
    const mappedBlocks = (maintenanceRows || []).map(m => ({ id: m.id, resourceId: m.resource_id, start: new Date(m.start_at), end: new Date(m.end_at), reason: m.reason }));
    const issues = computeScheduleIssues(mappedFlights, mappedResources, mappedSlotRequests, mappedBlocks);

    const pdfBuffer = await renderToBuffer(
      React.createElement(ReportDocument, {
        startDate, endDate, sections,
        data: {
          flights: flightList, resourceCodeById, allotments: allotmentsInRange, operatorNameById, flightRefById, flightDateById,
          totalRevenue, totalSeatsSold, revenueByOperator, utilization, issues, scrLog: scrLog || [],
        },
      })
    );

    return new Response(pdfBuffer, {
      status: 200,
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="charter-ops-report-${startDate}-to-${endDate}.pdf"` },
    });
  } catch (err) {
    console.error("Report generation failed:", err);
    return Response.json({ error: err.message || "Report generation failed" }, { status: 500 });
  }
}
