"use client";
import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "../lib/supabaseClient";
import "leaflet/dist/leaflet.css";
import * as XLSX from "xlsx";
import {
  iso, addDays, hhmm, combineDateAndTime, combineArrivalDateTime, timeToMinutes, minutesToHHMM,
  flightGeometry, assignLanes, colorForDestination, mapFlight, computeScheduleIssues, FLIGHT_COLORS,
} from "../lib/scheduling-utils";

// Leaflet touches `window`/`document` at import time, so it can only load client-side —
// dynamic() with ssr:false is the standard fix for react-leaflet under Next.js.
const MapContainer = dynamic(() => import("react-leaflet").then(m => m.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import("react-leaflet").then(m => m.TileLayer), { ssr: false });
const CircleMarker = dynamic(() => import("react-leaflet").then(m => m.CircleMarker), { ssr: false });
const Popup = dynamic(() => import("react-leaflet").then(m => m.Popup), { ssr: false });
const Polyline = dynamic(() => import("react-leaflet").then(m => m.Polyline), { ssr: false });

// ---------- design tokens: "boarding-pass daylight" ----------
const C = {
  bg: "#F4F6FA", panel: "#FFFFFF", panel2: "#EFF2F8", border: "#E2E7F0", borderSoft: "#EBEEF5",
  text: "#1E2A3D", muted: "#6B7686", faint: "#A7B0BE",
  amber: "#3B6FE0", amberSoft: "#E8EFFD", cyan: "#2FA0C9", cyanSoft: "#E6F5FA",
  green: "#1FAA59", greenSoft: "#E7F8EE", red: "#E0473B", redSoft: "#FCEAE8", violet: "#8B5CF6",
};
const SIDEBAR = { bg: "#0E1B33", bgActive: "#1B2C4D", text: "#E7ECF7", muted: "#8592AC", border: "#1E2D4A" };
const ACCENT = { blue: "#3B6FE0", violet: "#8B5CF6", teal: "#2FA0C9", orange: "#E0923B", green: "#1FAA59" };
const GRADIENT_PRIMARY = C.amber;
const GLOW_PRIMARY = "none";
const ON_ACCENT = "#FFFFFF";
const MONO = "'SF Mono','JetBrains Mono','IBM Plex Mono',ui-monospace,monospace";
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

const today = new Date(); today.setUTCHours(0, 0, 0, 0);

// ---------- IATA season + SCR (slot request) formatting helpers ----------
function lastSundayOf(year, monthIndex0) {
  const last = new Date(Date.UTC(year, monthIndex0 + 1, 0));
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return last;
}
function iataSeasonFor(d) {
  const year = d.getUTCFullYear();
  const summerStart = lastSundayOf(year, 2);
  const winterStart = lastSundayOf(year, 9);
  if (d >= summerStart && d < winterStart) return `S${String(year).slice(-2)}`;
  if (d >= winterStart) return `W${String(year).slice(-2)}`;
  return `W${String(year - 1).slice(-2)}`;
}
const MONTHS3 = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function ddmmm(d) { return String(d.getUTCDate()).padStart(2, "0") + MONTHS3[d.getUTCMonth()]; }
function jsToIataDay(jsDay) { return jsDay === 0 ? 7 : jsDay; }
function daysOfOpString(selectedIataDays) {
  return [1, 2, 3, 4, 5, 6, 7].map(d => selectedIataDays.includes(d) ? d : "0").join("");
}
function guessAcType(variant) {
  const m = (variant || "").match(/^[A-Z]?(\w{3})/);
  return m ? m[1].toUpperCase() : "___";
}
// Real IATA equipment codes for this fleet — confirmed against an actual SCR ("B39M" -> "7M9").
// B38M and B752 follow the same convention (737 MAX 8 -> 7M8, 757-200 -> 752) but are inferred,
// not independently confirmed the way 7M9 is — worth double-checking these two specifically.
const AC_TYPE_MAP = { B38M: "7M8", B39M: "7M9", B752: "752" };
// Resource variants are stored as "B39M · 213Y" (type + seats combined in one label), not the
// bare code — matching AC_TYPE_MAP against the whole string always missed, silently falling
// through to the regex guess, which is what produced the wrong "39M" instead of "7M9". Pulling
// out just the leading token before doing the lookup fixes that.
function acTypeCodeFor(variant) {
  const key = (variant || "").split(/[·\s]/)[0].trim();
  return AC_TYPE_MAP[key] || guessAcType(key || variant);
}
function padFlightNo(ref) { return (ref || "").replace(/^[A-Z]+/, ""); }
function airlineCodeFromRef(ref) { const m = (ref || "").match(/^[A-Z]+/); return m ? m[0] : ""; }

// ---------- station time zones ----------
// Flight times are stored in UTC (scheduled_departure/scheduled_arrival are timestamptz).
// STATION_TZ is the fast, offline, known-good list. DYNAMIC_TZ is filled in at runtime by
// calling /api/timezone (which proxies APIFreaks + a Supabase cache) for any code not in the
// static list — so unknown stations resolve themselves instead of staying a "?" forever.
// Module-level (not React state) since it's a plain lookup cache, not UI state; a version
// counter in the App component below forces a re-render whenever an entry is added.
const STATION_TZ = {
  ALA: "Asia/Almaty", NQZ: "Asia/Almaty", CIT: "Asia/Almaty", AKX: "Asia/Almaty",
  KSN: "Asia/Almaty", PPK: "Asia/Almaty", KGF: "Asia/Almaty", UKK: "Asia/Almaty",
  CXR: "Asia/Ho_Chi_Minh", PQC: "Asia/Ho_Chi_Minh", DAD: "Asia/Ho_Chi_Minh",
  AYT: "Europe/Istanbul", HRI: "Asia/Colombo", SSH: "Africa/Cairo",
  HKT: "Asia/Bangkok", SYX: "Asia/Shanghai", SIN: "Asia/Singapore",
  SVX: "Asia/Yekaterinburg", UFA: "Asia/Yekaterinburg", TJM: "Asia/Yekaterinburg",
  KZN: "Europe/Moscow", VKO: "Europe/Moscow", KJA: "Asia/Krasnoyarsk", OVB: "Asia/Novosibirsk",
  GOI: "Asia/Kolkata", SKD: "Asia/Samarkand",
};
const DYNAMIC_TZ = {};       // code -> tz string, or `false` for "looked up, genuinely unknown"
const TZ_LOOKUP_PENDING = new Set();

function lookupTz(code) {
  return STATION_TZ[code] || (DYNAMIC_TZ[code] || null);
}

// Called from an effect in the App component with the full set of station codes currently on
// the board. Resolves any code that's neither in the static list nor already cached/pending.
async function resolveUnknownStations(codes, onResolved) {
  const toResolve = [...codes].filter(c => c && !STATION_TZ[c] && DYNAMIC_TZ[c] === undefined && !TZ_LOOKUP_PENDING.has(c));
  for (const code of toResolve) {
    TZ_LOOKUP_PENDING.add(code);
    fetch(`/api/timezone?code=${code}`)
      .then(r => r.json())
      .then(data => { DYNAMIC_TZ[code] = data.tz || false; })
      .catch(() => { DYNAMIC_TZ[code] = false; })
      .finally(() => { TZ_LOOKUP_PENDING.delete(code); onResolved(); });
  }
}

function stationLocalTime(dateObj, hhmm, stationCode) {
  const utcDate = combineDateAndTime(dateObj, hhmm);
  if (!utcDate) return null;
  const tz = lookupTz(stationCode);
  if (!tz) return { text: hhmm, dayShift: 0, known: false };
  const text = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(utcDate);
  const localDateStr = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(utcDate);
  const dayShift = Math.round((new Date(localDateStr + "T00:00:00Z").getTime() - new Date(iso(utcDate) + "T00:00:00Z").getTime()) / 86400000);
  return { text, dayShift, known: true };
}
function formatStationTime(dateObj, hhmm, stationCode, showLocal) {
  if (!hhmm) return "—";
  if (!showLocal) return hhmm + "Z";
  const r = stationLocalTime(dateObj, hhmm, stationCode);
  if (!r.known) return hhmm + "Z ?";
  return r.text + (r.dayShift ? (r.dayShift > 0 ? "+1" : "-1") : "");
}


const STATUS_STYLE = {
  tentative: { bg: "rgba(58,54,47,0.06)", border: C.faint, text: C.muted, dash: true },
  confirmed: { bg: C.cyan + "60", border: C.cyan, text: "#22303C", dash: false },
  operating: { bg: C.green + "60", border: C.green, text: "#25331D", dash: false },
  cancelled: { bg: C.red + "60", border: C.red, text: "#4A2116", dash: false },
};

const ROLES = {
  ops_coordinator: { label: "Schedule coordinator (ops)", editFlight: true, editAllotments: false, editContracts: false, manageUsers: false, reports: "utilization" },
  commercial: { label: "Commercial staff", editFlight: false, editAllotments: true, editContracts: false, manageUsers: false, reports: "pipeline" },
  tour_operator_liaison: { label: "Tour operator liaison", editFlight: false, editAllotments: true, editContracts: true, manageUsers: false, reports: "portfolio" },
  management: { label: "Charter dept management", editFlight: true, editAllotments: true, editContracts: true, manageUsers: true, reports: "all" },
};

// ---------- Supabase data layer ----------
// Every read/write in the app goes through the functions below, mapping between the DB's
// snake_case columns and the UI's camelCase shape. RLS on each table (see the migration in
// supabase/migrations/) is what actually enforces the role rules — the `perms` object below
// only controls which buttons render, matching the design doc's principle that the client-side
// role is never trusted for writes.
function mapResource(r) { return { id: r.id, code: r.code, variant: r.variant, base: r.base_station, capacity: r.capacity }; }
function mapMaintenanceBlock(m) { return { id: m.id, resourceId: m.resource_id, start: new Date(m.start_at), end: new Date(m.end_at), reason: m.reason }; }
// hhmm, combineDateAndTime, combineArrivalDateTime, timeToMinutes, minutesToHHMM, flightGeometry,
// assignLanes, colorForDestination, mapFlight, and FLIGHT_COLORS all now live in
// lib/scheduling-utils.js (imported at the top of this file) — extracted so they can be unit
// tested without pulling in React/Next/Leaflet/Supabase.
// Box sizing is purely a display decision, tied to zoom level — it never touches the stored
// depTime/arrTime. At Day/Week zoom there's enough room to show a flight's actual duration; at
// Month/Period the columns are too narrow for that to be legible, so every flight there just
// renders as a clean full-day block instead of a sliver sized to a few pixels.
function effectiveGeometry(f, isNarrow) {
  return isNarrow ? { offsetFrac: 0, widthFrac: 1 } : flightGeometry(f);
}
function mapAllotment(a) { return { id: a.id, flightId: a.flight_id, operatorId: a.tour_operator_id, contractId: a.contract_id, seatsAllocated: a.seats_allocated, pricePerSeat: Number(a.price_per_seat), allotmentType: a.allotment_type, optionReleaseAt: a.option_release_at ? new Date(a.option_release_at) : null, status: a.status }; }
function mapOperator(o, contract) {
  return {
    id: o.id, name: o.name, country: o.country, status: o.status,
    contractId: contract?.id ?? null,
    defaultRate: contract && contract.rate_per_seat != null ? Number(contract.rate_per_seat) : (contract ? null : 0),
    ratesByDestination: Object.fromEntries(Object.entries(contract?.rates_by_destination || {}).map(([k, v]) => [k, Number(v)])),
    allotmentType: contract?.default_allotment_type ?? "fixed",
    optionReleaseDays: contract?.default_option_release_days ?? null,
  };
}
function rateFor(op, destination) { return op?.ratesByDestination?.[destination] ?? op?.defaultRate ?? 0; }

async function fetchAll() {
  const [{ data: resources }, { data: flights }, { data: operators }, { data: contracts }, { data: allotments }, { data: tzCache }, { data: profiles }, { data: tasks }, { data: notifications }, { data: maintenanceBlocks }, { data: ackIssues }, { data: draftChanges }] = await Promise.all([
    supabase.from("resources").select("*").order("code"),
    supabase.from("flights").select("*").order("scheduled_departure"),
    supabase.from("tour_operators").select("*").order("name"),
    supabase.from("contracts").select("*"),
    supabase.from("allotments").select("*"),
    supabase.from("station_timezones").select("*"),
    supabase.from("profiles").select("*").order("name"),
    supabase.from("tasks").select("*").order("created_at"),
    supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(30),
    supabase.from("maintenance_blocks").select("*").order("start_at"),
    supabase.from("acknowledged_issues").select("*"),
    supabase.from("draft_changes").select("*").order("created_at"),
  ]);
  (tzCache || []).forEach(row => { DYNAMIC_TZ[row.code] = row.tz; });
  const contractByOperator = Object.fromEntries((contracts || []).map(c => [c.tour_operator_id, c]));
  return {
    resources: (resources || []).map(mapResource),
    flights: (flights || []).map(mapFlight),
    operators: (operators || []).map(o => mapOperator(o, contractByOperator[o.id])),
    allotments: (allotments || []).map(mapAllotment),
    profiles: profiles || [],
    tasks: tasks || [],
    notifications: notifications || [],
    maintenanceBlocks: (maintenanceBlocks || []).map(mapMaintenanceBlock),
    acknowledgedIssueIds: (ackIssues || []).map(a => a.issue_id),
    draftChanges: (draftChanges || []).map(mapDraftChange),
  };
}
function mapDraftChange(d) { return { id: d.id, flightId: d.flight_id, changeType: d.change_type, patch: d.patch || {}, summary: d.summary, createdBy: d.created_by, createdAt: new Date(d.created_at) }; }

// ---------- atoms ----------
function Badge({ children, color, bg = "transparent" }) {
  return <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 12, color, background: bg, border: `1px solid ${color}55`, whiteSpace: "nowrap" }}>{children}</span>;
}
function Toast({ items, onDismiss }) {
  // bottom offset cleared to sit above the chat launcher button, which now shares this corner
  return <div style={{ position: "fixed", bottom: 84, right: 18, display: "flex", flexDirection: "column", gap: 8, zIndex: 100 }}>
    {items.map(t => (
      <div key={t.id} style={{ background: C.panel, border: `1px solid ${t.tone === "warn" ? C.red : C.cyan}55`, borderLeft: `3px solid ${t.tone === "warn" ? C.red : C.cyan}`, color: C.text, fontFamily: SANS, fontSize: 13, padding: "10px 14px", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", minWidth: 260, maxWidth: 380, animation: "slideIn 0.25s ease-out", display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ flex: 1 }}>{t.msg}</span>
        <button onClick={() => onDismiss(t.id)} style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", padding: 0, fontSize: 15, lineHeight: 1, flexShrink: 0 }}>×</button>
      </div>
    ))}
  </div>;
}

// ---------- floating chat assistant ----------
function ChatWidget({ open, setOpen, messages, busy, onSend, onClear }) {
  const [input, setInput] = useState("");
  const scrollRef = useRef(null);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages, busy]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text);
    setInput("");
  }

  return (
    <>
      <button onClick={() => setOpen(v => !v)} title={open ? "Close assistant" : "Ask the assistant"}
        style={{ position: "fixed", bottom: 20, right: 20, width: 52, height: 52, borderRadius: 999, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, border: "none", cursor: "pointer", zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {open ? <IconX /> : <IconChat />}
      </button>
      {open && (
        <div className="chat-panel" style={{ position: "fixed", bottom: 82, right: 20, width: 340, height: 460, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 16, boxShadow: "0 20px 50px rgba(58,54,47,0.2)", display: "flex", flexDirection: "column", zIndex: 95, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${C.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Ask about the schedule</div>
              <div style={{ fontSize: 10.5, color: C.faint }}>Answers come from real flight/allotment data — it can look things up, not change them.</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              {messages.length > 0 && <button onClick={onClear} title="Clear history" style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", fontSize: 10.5, padding: 0, textDecoration: "underline" }}>Clear</button>}
              {/* Explicit close button — the panel can cover the launcher button entirely on
                  mobile (full-height drawer), so closing can never depend on that button still
                  being reachable underneath it. */}
              <button onClick={() => setOpen(false)} title="Close" style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", padding: 0, display: "flex" }}><IconX size={16} /></button>
            </div>
          </div>
          <div ref={scrollRef} style={{ flex: 1, overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {messages.length === 0 && <div style={{ fontSize: 11.5, color: C.faint }}>Try: "How many seats does ANEX have left to SSH?" or "What's flying this week on UP-B3748?"</div>}
            {messages.map((m, i) => (
              <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "88%", background: m.role === "user" ? C.amberSoft : C.panel2, color: C.text, borderRadius: 10, padding: "7px 10px", fontSize: 12.5, whiteSpace: "pre-wrap" }}>{m.content}</div>
            ))}
            {busy && <div style={{ alignSelf: "flex-start", fontSize: 11.5, color: C.faint }}>Thinking…</div>}
          </div>
          <div style={{ display: "flex", gap: 6, padding: 10, borderTop: `1px solid ${C.borderSoft}` }}>
            <input value={input} onChange={e => setInput(e.target.value)} placeholder="Ask a question…" style={{ ...inputStyle, flex: 1, fontSize: 12.5 }}
              onKeyDown={e => { if (e.key === "Enter") submit(); }} />
            <button onClick={submit} disabled={busy || !input.trim()} style={{ ...miniBtn, background: GRADIENT_PRIMARY, color: ON_ACCENT, borderColor: C.amber }}>Send</button>
          </div>
        </div>
      )}
    </>
  );
}

const inputStyle = { background: C.panel, border: `1px solid ${C.border}`, color: C.text, borderRadius: 10, padding: "7px 10px", fontSize: 12.5, fontFamily: SANS, width: "100%", outline: "none", transition: "box-shadow 0.15s ease, border-color 0.15s ease" };
const miniBtn = { background: C.panel, border: `1px solid ${C.border}`, color: C.text, fontSize: 11, padding: "6px 12px", borderRadius: 999, cursor: "pointer", fontFamily: SANS, transition: "transform 0.12s ease, box-shadow 0.15s ease, background 0.15s ease", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" };
const navBtn = { background: C.panel, border: `1px solid ${C.border}`, color: C.text, fontSize: 12, padding: "7px 14px", borderRadius: 999, cursor: "pointer", fontFamily: SANS, transition: "transform 0.12s ease, box-shadow 0.15s ease, background 0.15s ease", boxShadow: "0 1px 2px rgba(0,0,0,0.05)" };

// ---------- main ----------
// `profile` is the signed-in user's row from `public.profiles` ({ id, name, role }), passed down
// from app/page.jsx after checking the Supabase auth session. Role is never chosen in this UI —
// it's whatever the database says, exactly like production should work.
// ---------- sidebar icons (inline, no icon library dependency) ----------
function IconCalendar() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></svg>; }
function IconBuilding() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="1" /><line x1="9" y1="7" x2="9.01" y2="7" /><line x1="15" y1="7" x2="15.01" y2="7" /><line x1="9" y1="12" x2="9.01" y2="12" /><line x1="15" y1="12" x2="15.01" y2="12" /><line x1="9" y1="17" x2="15" y2="17" /></svg>; }
function IconChart() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="20" x2="4" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="20" y1="20" x2="20" y2="14" /></svg>; }
function IconUsers() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>; }
function IconPlaneLogo({ size = 22 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2 L3 14l4-1 2 6 3-7 3 7 2-6 4 1z" /></svg>; }
function IconPlane() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-3 2v1.5l4.5-1.5 4.5 1.5V21l-3-2v-5.5z" /></svg>; }
function IconGauge() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 12 16 8" /><path d="M12 3v2" /></svg>; }
function IconSearch() { return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>; }
function IconBell() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>; }
function IconChat({ size = 22 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></svg>; }
function IconX({ size = 22 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>; }
function IconMenu() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>; }

export default function CharterOpsApp({ profile, onSignOut }) {
  const role = profile.role;
  const [tab, setTab] = useState("schedule");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // Structural mobile detection — used to switch layout (sidebar becomes a drawer, top bar
  // compresses, etc.), not just for CSS sizing. Checked on mount and on resize/rotate.
  const [isMobile, setIsMobile] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  const [showLocal, setShowLocal] = useState(false);
  const [viewMode, setViewMode] = useState("day"); // "day" | "period"
  // "Day" is a continuous, pannable strip of many days at hour-tick zoom — not one page at a
  // time. "Period" is an explicit From/To range, zoomed via the size slider to fit whatever
  // span was picked.
  const [rangeFrom, setRangeFrom] = useState(iso(addDays(today, -1)));
  const [rangeTo, setRangeTo] = useState(iso(addDays(today, 29)));
  const [viewStart, setViewStart] = useState(addDays(today, -1));
  const DAY_MODE_SPAN = 45;
  const periodSpan = Math.max(1, Math.round((new Date(rangeTo) - new Date(rangeFrom)) / 86400000) + 1);
  const DAYS = viewMode === "period" ? periodSpan : DAY_MODE_SPAN;
  const effectiveViewStart = viewMode === "period" ? new Date(rangeFrom) : viewStart;

  const [loaded, setLoaded] = useState(false);
  const [resources, setResources] = useState([]);
  const [maintenanceBlocks, setMaintenanceBlocks] = useState([]);
  const [acknowledgedIssueIds, setAcknowledgedIssueIds] = useState(() => new Set());
  // Draft Mode is a personal, per-session choice — off by default, not persisted, not shared.
  // While it's on, this user's own direct board edits (drag, resize, delete, duplicate, and
  // flight-drawer edits) are queued for review instead of applied live; other users editing
  // without draft mode on are unaffected and still commit instantly, same as always.
  const [draftMode, setDraftMode] = useState(false);
  const [draftChanges, setDraftChanges] = useState([]);
  const [flights, setFlightsRaw] = useState([]);
  const [operators, setOperatorsRaw] = useState([]);
  const [allotments, setAllotmentsRaw] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedFlightId, setSelectedFlightId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const toastIdRef = useRef(0);
  const [live, setLive] = useState(true);
  const [, bumpTzVersion] = useState(0); // forces a re-render once resolveUnknownStations fills DYNAMIC_TZ

  const perms = ROLES[role];

  // sticky=true skips the auto-dismiss timer entirely — for anything the person needs time to
  // copy (a temp password), not just glance at, since a 4.8s toast racing someone's clipboard
  // is a real usability bug, not a nitpick.
  const pushToast = useCallback((msg, tone, sticky) => {
    const id = ++toastIdRef.current;
    setToasts(t => [...t, { id, msg, tone, sticky }]);
    if (!sticky) setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4800);
  }, []);
  const dismissToast = useCallback(id => setToasts(t => t.filter(x => x.id !== id)), []);

  // ---- Tasks, Notifications, search — Tasks/Notifications are real Supabase tables (not
  // local-only state), so they're genuinely shared across everyone using this deployment.
  const [tasks, setTasks] = useState([]);
  async function addTask(title) {
    const { data, error } = await supabase.from("tasks").insert({ title, due_label: "Today", created_by: profile.id }).select().single();
    if (error) { pushToast(`Could not add task: ${error.message}`, "warn"); return; }
    setTasks(ts => [...ts, data]);
  }
  async function toggleTask(id) {
    const t = tasks.find(x => x.id === id);
    const { error } = await supabase.from("tasks").update({ done: !t.done }).eq("id", id);
    if (error) { pushToast(`Could not update task: ${error.message}`, "warn"); return; }
    setTasks(ts => ts.map(x => x.id === id ? { ...x, done: !x.done } : x));
  }

  const [notifications, setNotifications] = useState([]);
  const pushNotification = useCallback(async (title, subtitle, kind) => {
    const { data, error } = await supabase.from("notifications").insert({ title, subtitle, kind: kind || "info" }).select().single();
    if (!error) setNotifications(ns => [data, ...ns].slice(0, 30));
  }, []);
  const [showNotifPanel, setShowNotifPanel] = useState(false);

  // Gantt box-size scale — a personal preference, saved per-user so it's the same next login
  // regardless of device, not just remembered in this browser.
  const [ganttScale, setGanttScale] = useState(() => profile.preferences?.ganttScale ?? 1);
  async function persistGanttScale(value) {
    setGanttScale(value);
    const { error } = await supabase.from("profiles").update({ preferences: { ...(profile.preferences || {}), ganttScale: value } }).eq("id", profile.id);
    if (error) pushToast(`Could not save your size preference: ${error.message}`, "warn");
  }


  // ---- Chat assistant — tool-use against real data, scoped to the caller's own session on
  // the server side (see /api/chat), so it never sees more than this user already can.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatLoaded, setChatLoaded] = useState(false);
  // Loaded once per session, scoped to this user's own rows by RLS (chat_messages_own_rows) —
  // nobody else's history is reachable even if they knew the ids.
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("chat_messages").select("role, content").order("created_at");
      setChatMessages((data || []).map(m => ({ role: m.role, content: m.content })));
      setChatLoaded(true);
    })();
  }, []);
  async function persistChatMessage(role, content) {
    await supabase.from("chat_messages").insert({ user_id: profile.id, role, content });
  }
  async function sendChatMessage(text) {
    const nextMessages = [...chatMessages, { role: "user", content: text }];
    setChatMessages(nextMessages);
    persistChatMessage("user", text);
    setChatBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ messages: nextMessages.map(m => ({ role: m.role, content: m.content })) }),
      });
      let data;
      try { data = await res.json(); } catch { data = { error: `Server returned ${res.status} with no readable error` }; }
      if (!res.ok || data.error) {
        setChatMessages(m => [...m, { role: "assistant", content: `⚠ ${data.error || "Something went wrong."}` }]);
        // Errors aren't persisted — they're transient UI feedback, not real conversation.
      } else {
        setChatMessages(m => [...m, { role: "assistant", content: data.reply }]);
        persistChatMessage("assistant", data.reply);
      }
    } catch (err) {
      setChatMessages(m => [...m, { role: "assistant", content: `⚠ ${err.message}` }]);
    } finally {
      setChatBusy(false);
    }
  }
  async function clearChatHistory() {
    await supabase.from("chat_messages").delete().eq("user_id", profile.id);
    setChatMessages([]);
  }

  const [searchQuery, setSearchQuery] = useState("");

  // ---- Aircraft (fleet) CRUD — resources already drove the schedule; this adds a dedicated
  // management surface rather than requiring edits to happen implicitly elsewhere.
  async function addResource(r) {
    const { data, error } = await supabase.from("resources").insert({ code: r.code, variant: r.variant, capacity: r.capacity }).select().single();
    if (error) { pushToast(`Could not add aircraft: ${error.message}`, "warn"); return; }
    setResources(rs => [...rs, mapResource(data)]);
    pushNotification("Aircraft added to fleet", r.code, "aircraft");
  }
  async function updateResource(id, patch) {
    const dbPatch = {};
    if (patch.variant !== undefined) dbPatch.variant = patch.variant;
    if (patch.capacity !== undefined) dbPatch.capacity = patch.capacity;
    const { error } = await supabase.from("resources").update(dbPatch).eq("id", id);
    if (error) { pushToast(`Update failed: ${error.message}`, "warn"); return; }
    setResources(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  }
  async function deleteResource(id) {
    const inUse = flights.some(f => f.resourceId === id);
    if (inUse) { pushToast("Can't remove — this aircraft still has flights on the board.", "warn"); return; }
    const r = resources.find(x => x.id === id);
    const { error } = await supabase.from("resources").delete().eq("id", id);
    if (error) { pushToast(`Could not remove aircraft: ${error.message}`, "warn"); return; }
    setResources(rs => rs.filter(x => x.id !== id));
    pushToast(`${r?.code || "Aircraft"} removed from fleet`, "ok");
  }

  async function addMaintenanceBlock(resourceId, start, end, reason) {
    const { data, error } = await supabase.from("maintenance_blocks").insert({ resource_id: resourceId, start_at: start.toISOString(), end_at: end.toISOString(), reason }).select().single();
    if (error) { pushToast(`Could not add maintenance block: ${error.message}`, "warn"); return; }
    setMaintenanceBlocks(mb => [...mb, mapMaintenanceBlock(data)]);
    const r = resources.find(x => x.id === resourceId);
    pushToast(`Maintenance block added for ${r?.code || "aircraft"}`, "ok");
  }

  async function deleteMaintenanceBlock(id) {
    const { error } = await supabase.from("maintenance_blocks").delete().eq("id", id);
    if (error) { pushToast(`Could not remove block: ${error.message}`, "warn"); return; }
    setMaintenanceBlocks(mb => mb.filter(m => m.id !== id));
  }

  async function acknowledgeIssue(issueId) {
    const { error } = await supabase.from("acknowledged_issues").insert({ issue_id: issueId, acknowledged_by: profile.id });
    if (error) { pushToast(`Could not acknowledge: ${error.message}`, "warn"); return; }
    setAcknowledgedIssueIds(prev => new Set(prev).add(issueId));
  }
  async function unacknowledgeIssue(issueId) {
    const { error } = await supabase.from("acknowledged_issues").delete().eq("issue_id", issueId);
    if (error) { pushToast(`Could not clear: ${error.message}`, "warn"); return; }
    setAcknowledgedIssueIds(prev => { const next = new Set(prev); next.delete(issueId); return next; });
  }

  // Plain-language description of a proposed flights-table patch, computed once at draft
  // creation time so the review panel never has to re-derive "what does this actually mean"
  // from raw field diffs later, and so it still reads sensibly even if the flight itself is
  // edited again before this draft is reviewed.
  function summarizeFlightPatch(current, patch) {
    const parts = [];
    if (patch.resourceId && patch.resourceId !== current.resourceId) {
      const newCode = resources.find(r => r.id === patch.resourceId)?.code || "?";
      parts.push(`reassigned to ${newCode}`);
    }
    if (patch.start) {
      const newDay = iso(patch.start);
      if (newDay !== iso(current.start)) parts.push(`moved to ${newDay}`);
    }
    if (patch.depTime !== undefined && patch.depTime !== current.depTime) parts.push(`departure → ${patch.depTime}`);
    if (patch.arrTime !== undefined && patch.arrTime !== current.arrTime) parts.push(`arrival → ${patch.arrTime}`);
    if (patch.capacity !== undefined && patch.capacity !== current.capacity) parts.push(`capacity → ${patch.capacity}`);
    if (patch.status !== undefined && patch.status !== current.status) parts.push(`status → ${patch.status}`);
    return `${current.ref}: ${parts.length ? parts.join(", ") : "updated"}`;
  }

  async function queueDraftChange(flightId, changeType, patch, summary) {
    const { data, error } = await supabase.from("draft_changes").insert({
      flight_id: flightId, change_type: changeType, patch, summary, created_by: profile.id,
    }).select().single();
    if (error) { pushToast(`Could not queue draft change: ${error.message}`, "warn"); return false; }
    setDraftChanges(dc => [...dc, mapDraftChange(data)]);
    pushToast(`Queued for review: ${summary}`, "ok");
    return true;
  }

  async function approveDraftChange(draftId) {
    const d = draftChanges.find(x => x.id === draftId);
    if (!d) return;
    if (d.changeType === "create") {
      const p = d.patch;
      const startDate = new Date(p.start);
      const ref = p.ref || ("DV" + (4520 + flights.length + Math.floor(Math.random() * 50)));
      const { data, error } = await supabase.from("flights").insert({
        ref, resource_id: p.resourceId, origin: p.origin, destination: p.destination,
        scheduled_departure: (combineDateAndTime(startDate, p.depTime) || startDate).toISOString(),
        scheduled_arrival: combineArrivalDateTime(combineDateAndTime(startDate, p.depTime) || startDate, p.arrTime)?.toISOString() ?? null,
        capacity: p.capacity, status: "tentative", color: p.color || null,
      }).select().single();
      if (error) { pushToast(`Could not apply draft: ${error.message}`, "warn"); return; }
      setFlightsRaw(fl => [...fl, mapFlight(data)]);
    } else if (d.changeType === "delete") {
      await deleteFlight(d.flightId, { bypassDraft: true });
    } else {
      const patch = { ...d.patch };
      if (patch.start) patch.start = new Date(patch.start); // drafts store dates as ISO strings (JSON has no Date type) — convert back before applying
      await updateFlight(d.flightId, patch, { bypassDraft: true, silent: true });
    }
    const { error: delError } = await supabase.from("draft_changes").delete().eq("id", draftId);
    if (!delError) setDraftChanges(dc => dc.filter(x => x.id !== draftId));
    pushToast(`Applied: ${d.summary}`, "ok");
  }
  async function discardDraftChange(draftId) {
    const d = draftChanges.find(x => x.id === draftId);
    const { error } = await supabase.from("draft_changes").delete().eq("id", draftId);
    if (error) { pushToast(`Could not discard: ${error.message}`, "warn"); return; }
    setDraftChanges(dc => dc.filter(x => x.id !== draftId));
    pushToast(`Discarded: ${d?.summary || "change"}`, "ok");
  }
  async function approveAllDrafts() { for (const d of draftChanges) await approveDraftChange(d.id); }
  async function discardAllDrafts() {
    const { error } = await supabase.from("draft_changes").delete().in("id", draftChanges.map(d => d.id));
    if (error) { pushToast(`Could not discard all: ${error.message}`, "warn"); return; }
    setDraftChanges([]);
    pushToast("All pending draft changes discarded", "ok");
  }

  // A date/resource pair is grounded if any maintenance block for that aircraft covers that
  // calendar day. Used both by the Aircraft tab display and by the scheduling engine, so the
  // engine never proposes a flight on a tail that's actually down.
  function isGrounded(resourceId, date) {
    const d0 = new Date(date); d0.setUTCHours(0, 0, 0, 0);
    const d1 = new Date(d0); d1.setUTCDate(d1.getUTCDate() + 1);
    return maintenanceBlocks.some(m => m.resourceId === resourceId && m.start < d1 && m.end > d0);
  }

  // initial load, straight from Supabase — everyone hitting this deployment reads the same rows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { resources, flights, operators, allotments, profiles, tasks, notifications, maintenanceBlocks, acknowledgedIssueIds, draftChanges } = await fetchAll();
      if (cancelled) return;
      setResources(resources); setFlightsRaw(flights); setOperatorsRaw(operators); setAllotmentsRaw(allotments); setProfiles(profiles);
      setTasks(tasks); setNotifications(notifications); setMaintenanceBlocks(maintenanceBlocks); setAcknowledgedIssueIds(new Set(acknowledgedIssueIds));
      setDraftChanges(draftChanges);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Any station code on the board that isn't in the static STATION_TZ list gets looked up via
  // /api/timezone (APIFreaks + Supabase cache) once, ever — not on every render, not per user.
  useEffect(() => {
    if (!loaded) return;
    const codes = new Set(flights.flatMap(f => [f.origin, f.destination]));
    resolveUnknownStations(codes, () => bumpTzVersion(v => v + 1));
  }, [loaded, flights]);

  // Supabase Realtime replaces the design doc's WebSocket push directly — any INSERT/UPDATE on
  // flights or allotments from any session refetches and every open board updates without a
  // manual refresh.
  useEffect(() => {
    if (!loaded) return;
    const channel = supabase
      .channel("schedule-sync")
      .on("postgres_changes", { event: "*", schema: "public", table: "flights" }, async () => {
        const { data } = await supabase.from("flights").select("*").order("scheduled_departure");
        setFlightsRaw((data || []).map(mapFlight));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "allotments" }, async () => {
        const { data } = await supabase.from("allotments").select("*");
        setAllotmentsRaw((data || []).map(mapAllotment));
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loaded]);

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(effectiveViewStart, i)), [effectiveViewStart, DAYS]);
  function shiftView(sign) {
    if (viewMode === "period") {
      setRangeFrom(iso(addDays(new Date(rangeFrom), sign * periodSpan)));
      setRangeTo(iso(addDays(new Date(rangeTo), sign * periodSpan)));
    } else {
      setViewStart(addDays(viewStart, sign * DAYS));
    }
  }
  function jumpToDate(d) {
    setViewMode("day");
    setViewStart(d);
  }
  function jumpToToday() {
    const t = new Date(); t.setUTCHours(0, 0, 0, 0);
    if (viewMode === "period") { setRangeFrom(iso(t)); setRangeTo(iso(addDays(t, periodSpan - 1))); }
    else setViewStart(addDays(t, -1));
  }


  function flightInventory(flightId) {
    const fl = flights.find(f => f.id === flightId);
    if (!fl) return null;
    const liveAllotments = allotments.filter(a => a.flightId === flightId && a.status !== "released" && a.status !== "cancelled");
    const allocated = liveAllotments.reduce((s, a) => s + a.seatsAllocated, 0);
    const revenue = liveAllotments.reduce((s, a) => s + a.seatsAllocated * a.pricePerSeat, 0);
    const oversoldBy = Math.max(0, allocated - fl.capacity);
    return { capacity: fl.capacity, allocated, unsold: Math.max(0, fl.capacity - allocated), oversoldBy, revenue, live: liveAllotments };
  }

  async function updateFlight(flightId, patch, opts) {
    const colorOnly = Object.keys(patch).length === 1 && "color" in patch;
    if (!perms.editFlight && !colorOnly) return;
    const current = flights.find(f => f.id === flightId);
    // Color is cosmetic, not an operational schedule change, so it always applies immediately
    // regardless of draft mode — only real schedule/capacity/status edits get queued.
    if (draftMode && !colorOnly && !opts?.bypassDraft) {
      const patchForStorage = { ...patch };
      if (patchForStorage.start instanceof Date) patchForStorage.start = patchForStorage.start.toISOString();
      await queueDraftChange(flightId, "update", patchForStorage, summarizeFlightPatch(current, patch));
      return "drafted";
    }
    const before = flightInventory(flightId);
    const dbPatch = {};
    if (patch.resourceId) dbPatch.resource_id = patch.resourceId;
    if (patch.capacity) dbPatch.capacity = patch.capacity;
    if ("color" in patch) dbPatch.color = patch.color;
    // A drag passes just a new date at midnight via patch.start, with no explicit depTime — a
    // real bug (departure silently zeroing to 00:00 on every drag) came from writing that
    // straight into scheduled_departure. patch.start alone means "move to a different day,
    // keep the same time" — it must be combined with the flight's EXISTING depTime, not
    // written verbatim. An explicit patch.depTime (e.g. from a resize) still takes precedence.
    let newDep = null, newArr = null;
    if (patch.start || patch.depTime !== undefined) {
      const baseDate = patch.start || current.start;
      const effectiveDepTime = patch.depTime !== undefined ? patch.depTime : current.depTime;
      newDep = combineDateAndTime(baseDate, effectiveDepTime) || baseDate;
      dbPatch.scheduled_departure = newDep.toISOString();
    }
    if (patch.start || patch.depTime !== undefined || patch.arrTime !== undefined) {
      const effectiveArrTime = patch.arrTime !== undefined ? patch.arrTime : current.arrTime;
      newArr = combineArrivalDateTime(newDep || patch.start || current.start, effectiveArrTime);
      dbPatch.scheduled_arrival = newArr?.toISOString() ?? null;
    }
    const { error } = await supabase.from("flights").update(dbPatch).eq("id", flightId);
    if (error) { pushToast(`Update failed: ${error.message}`, "warn"); return; }
    // Mirror the ACTUAL resulting values into local state, not the raw patch — patch.start on
    // its own is just midnight-of-the-new-day, not the real corrected departure timestamp.
    const localPatch = { ...patch };
    if (newDep) { localPatch.start = newDep; localPatch.depTime = hhmm(newDep.toISOString()); }
    if (newArr !== null || patch.arrTime !== undefined) localPatch.arrivalAt = newArr;
    if (newArr) localPatch.arrTime = hhmm(newArr.toISOString());
    setFlightsRaw(fl => fl.map(f => f.id === flightId ? { ...f, ...localPatch } : f));
    if (colorOnly || opts?.silent) return;
    const willBeCapacity = patch.capacity ?? before.capacity;
    if (before.allocated > willBeCapacity) {
      pushToast(`Schedule change on ${flights.find(f => f.id === flightId)?.ref}: now oversold by ${before.allocated - willBeCapacity} seats — allotments below reflect it live`, "warn");
    } else {
      pushToast(`Flight updated — all attached allotments now read the new values`, "ok");
    }
  }

  // allotments.flight_id has ON DELETE CASCADE, so deleting a flight row also removes its
  // allotments in the database automatically — these functions just report how many active
  // ones were affected, and mirror that cleanup in local state so the UI updates immediately
  // rather than waiting on the next Realtime event.
  async function deleteFlight(flightId, opts) {
    if (!perms.editFlight) return;
    const flight = flights.find(f => f.id === flightId);
    if (draftMode && !opts?.bypassDraft) {
      await queueDraftChange(flightId, "delete", {}, `Delete ${flight?.ref || "flight"} (${flight ? iso(flight.start) : "?"})`);
      return;
    }
    const affected = allotments.filter(a => a.flightId === flightId && a.status !== "cancelled" && a.status !== "released").length;
    const { error } = await supabase.from("flights").delete().eq("id", flightId);
    if (error) { pushToast(`Could not delete flight: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => fl.filter(f => f.id !== flightId));
    setAllotmentsRaw(as => as.filter(a => a.flightId !== flightId));
    if (selectedFlightId === flightId) setSelectedFlightId(null);
    pushToast(`${flight?.ref || "Flight"} deleted${affected ? ` — ${affected} active allotment${affected === 1 ? "" : "s"} removed with it` : ""}`, affected ? "warn" : "ok");
  }

  async function duplicateFlight(flightId) {
    if (!perms.editFlight) return;
    const f = flights.find(x => x.id === flightId);
    if (!f) return;
    const newStart = addDays(f.start, 1);
    if (draftMode) {
      await queueDraftChange(null, "create", {
        resourceId: f.resourceId, origin: f.origin, destination: f.destination, ref: f.ref,
        start: newStart.toISOString(), depTime: f.depTime, arrTime: f.arrTime, capacity: f.capacity, color: f.color,
      }, `New flight: ${f.ref} duplicated to ${iso(newStart)}`);
      return;
    }
    const { data, error } = await supabase.from("flights").insert({
      ref: f.ref, resource_id: f.resourceId, origin: f.origin, destination: f.destination,
      scheduled_departure: (combineDateAndTime(newStart, f.depTime) || newStart).toISOString(),
      scheduled_arrival: combineArrivalDateTime(combineDateAndTime(newStart, f.depTime) || newStart, f.arrTime)?.toISOString() ?? null,
      capacity: f.capacity, status: "tentative", leg_type: f.legType || "revenue", color: f.color || null,
    }).select().single();
    if (error) { pushToast(`Duplicate failed: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => [...fl, mapFlight(data)]);
    pushToast(`${f.ref} duplicated to ${iso(newStart)}`, "ok");
  }

  async function setFlightColor(flightId, color) {
    const { error } = await supabase.from("flights").update({ color }).eq("id", flightId);
    if (error) { pushToast(`Could not update color: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => fl.map(f => f.id === flightId ? { ...f, color } : f));
  }

  async function bulkDeleteFlights(flightIds) {
    if (!perms.editFlight || flightIds.length === 0) return;
    const affected = allotments.filter(a => flightIds.includes(a.flightId) && a.status !== "cancelled" && a.status !== "released").length;
    const { error } = await supabase.from("flights").delete().in("id", flightIds);
    if (error) { pushToast(`Bulk delete failed: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => fl.filter(f => !flightIds.includes(f.id)));
    setAllotmentsRaw(as => as.filter(a => !flightIds.includes(a.flightId)));
    if (flightIds.includes(selectedFlightId)) setSelectedFlightId(null);
    pushToast(`${flightIds.length} flight${flightIds.length === 1 ? "" : "s"} deleted${affected ? ` — ${affected} active allotment${affected === 1 ? "" : "s"} removed with them` : ""}`, affected ? "warn" : "ok");
    setShowBulkDelete(false);
  }

  // Drag a flight bar from one aircraft's row to another (or to a different day on the same
  // row). Only the date and/or aircraft change — the flight's actual departure/arrival times
  // are left exactly as they were. Opens the drawer afterward so the move can be double-checked.
  // Drag now ONLY reassigns the aircraft — the day is deliberately ignored even if the drop
  // happened over a different date column, so the flight always stays on its original day
  // unless someone explicitly changes the date from the flight drawer. That's a real
  // constraint, not a bug: date changes are meant to go through the drawer's own date field
  // (which already correctly preserves time-of-day via updateFlight), never through drag.
  async function dropFlight(flightId, newResourceId) {
    if (!perms.editFlight) return;
    const f = flights.find(x => x.id === flightId);
    if (!f) return;
    if (newResourceId === f.resourceId) return; // dropped back on the same aircraft — nothing to do
    const conflict = checkConflict(newResourceId, f.start, flightId);
    const result = await updateFlight(flightId, { resourceId: newResourceId });
    if (result === "drafted") return; // queueDraftChange already showed its own toast
    setSelectedFlightId(flightId);
    if (conflict) pushToast(`${f.ref} reassigned — heads up: ${resources.find(r => r.id === newResourceId)?.code} already has ${conflict.ref} that day`, "warn");
    else pushToast(`${f.ref} reassigned to ${resources.find(r => r.id === newResourceId)?.code} — date and time unchanged`, "ok");
  }

  async function addAllotment(flightId, operatorId, seats, priceOverride) {
    const op = operators.find(o => o.id === operatorId);
    const flight = flights.find(f => f.id === flightId);
    const price = priceOverride ?? rateFor(op, flight?.destination);
    const optionReleaseAt = op.allotmentType === "option" ? addDays(today, op.optionReleaseDays || 14) : null;
    const { data, error } = await supabase.from("allotments").insert({
      flight_id: flightId, tour_operator_id: operatorId, contract_id: op.contractId,
      seats_allocated: seats, price_per_seat: price, allotment_type: op.allotmentType,
      option_release_at: optionReleaseAt ? optionReleaseAt.toISOString() : null,
    }).select().single();
    if (error) { pushToast(`Could not allocate seats: ${error.message}`, "warn"); return; }
    setAllotmentsRaw(as => [...as, mapAllotment(data)]);
    const destRate = rateFor(op, flight?.destination);
    const priceNote = price !== destRate ? ` at $${price}/seat (${op.name}'s rate to ${flight?.destination} is $${destRate})` : ` at $${price}/seat`;
    pushToast(`Allocated ${seats} seats to ${op.name}${priceNote}`, "ok");
    pushNotification("Seats allocated", `${seats} seats · ${op.name} · ${flight?.ref || ""}`, "allotment");
  }

  async function patchAllotment(id, patch) {
    const dbPatch = {};
    if (patch.seatsAllocated !== undefined) dbPatch.seats_allocated = patch.seatsAllocated;
    if (patch.pricePerSeat !== undefined) dbPatch.price_per_seat = patch.pricePerSeat;
    if (patch.status !== undefined) dbPatch.status = patch.status;
    const { error } = await supabase.from("allotments").update(dbPatch).eq("id", id);
    if (error) { pushToast(`Update failed: ${error.message}`, "warn"); return; }
    setAllotmentsRaw(as => as.map(a => a.id === id ? { ...a, ...patch } : a));
  }

  async function removeAllotment(id) {
    const { error } = await supabase.from("allotments").update({ status: "cancelled" }).eq("id", id);
    if (error) { pushToast(`Could not remove allotment: ${error.message}`, "warn"); return; }
    setAllotmentsRaw(as => as.map(a => a.id === id ? { ...a, status: "cancelled" } : a));
  }

  // OperatorsPanel edits rates by calling setOperators(prev => ...) exactly like a useState
  // setter; we diff the result against the current array and push only what changed —
  // defaultRate -> contracts.rate_per_seat, ratesByDestination -> contracts.rates_by_destination.
  function setOperators(updater) {
    setOperatorsRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      next.forEach(o => {
        const before = prev.find(p => p.id === o.id);
        if (!before || !o.contractId) return;
        const patch = {};
        if (before.defaultRate !== o.defaultRate) patch.rate_per_seat = o.defaultRate;
        if (JSON.stringify(before.ratesByDestination) !== JSON.stringify(o.ratesByDestination)) patch.rates_by_destination = o.ratesByDestination;
        if (Object.keys(patch).length) {
          supabase.from("contracts").update(patch).eq("id", o.contractId)
            .then(({ error }) => { if (error) pushToast(`Rate update failed: ${error.message}`, "warn"); });
        }
      });
      return next;
    });
  }

  async function addOperator(draft) {
    const { data: opRow, error: opErr } = await supabase.from("tour_operators").insert({ name: draft.name, country: draft.country, status: draft.status }).select().single();
    if (opErr) { pushToast(`Could not create operator: ${opErr.message}`, "warn"); return; }
    const { data: contractRow, error: cErr } = await supabase.from("contracts").insert({
      tour_operator_id: opRow.id, season: "S27", currency: "USD", rate_per_seat: draft.defaultRate,
      rates_by_destination: draft.ratesByDestination || {}, default_allotment_type: draft.allotmentType, default_option_release_days: draft.optionReleaseDays,
    }).select().single();
    if (cErr) { pushToast(`Operator created but contract failed: ${cErr.message}`, "warn"); return; }
    setOperatorsRaw(ops => [...ops, mapOperator(opRow, contractRow)]);
    pushToast(`${draft.name} added`, "ok");
    pushNotification("Tour operator added", draft.name, "operator");
  }

  async function commitBulkOperators(rows) {
    let count = 0;
    for (const r of rows) {
      const { data: opRow, error: opErr } = await supabase.from("tour_operators").insert({ name: r.name, country: r.country, status: r.status }).select().single();
      if (opErr) { pushToast(`${r.name}: ${opErr.message}`, "warn"); continue; }
      const { data: contractRow, error: cErr } = await supabase.from("contracts").insert({
        tour_operator_id: opRow.id, season: "S27", currency: "USD", rate_per_seat: r.defaultRate,
        rates_by_destination: r.ratesByDestination || {}, default_allotment_type: r.allotmentType, default_option_release_days: r.optionReleaseDays,
      }).select().single();
      if (cErr) { pushToast(`${r.name}: contract failed — ${cErr.message}`, "warn"); continue; }
      setOperatorsRaw(ops => [...ops, mapOperator(opRow, contractRow)]);
      count++;
    }
    pushToast(`Imported ${count} tour operator${count === 1 ? "" : "s"}`, "ok");
  }

  async function deleteOperator(id) {
    const active = allotments.some(a => a.operatorId === id && a.status !== "cancelled" && a.status !== "released");
    if (active) {
      pushToast("Can't delete — this operator still has active allotments. Release or cancel them first.", "warn");
      return;
    }
    const op = operators.find(o => o.id === id);
    // Clear any leftover cancelled/released allotments first — the FK has no cascade, so the
    // operator (and its contract, which does cascade) can't go until these are gone.
    await supabase.from("allotments").delete().eq("tour_operator_id", id);
    const { error } = await supabase.from("tour_operators").delete().eq("id", id);
    if (error) { pushToast(`Could not delete ${op?.name}: ${error.message}`, "warn"); return; }
    setOperatorsRaw(ops => ops.filter(o => o.id !== id));
    setAllotmentsRaw(as => as.filter(a => a.operatorId !== id));
    pushToast(`${op?.name || "Operator"} removed`, "ok");
  }

  // Role changes go straight through RLS (the "profiles_update_by_management" policy only
  // lets a management-role caller update someone else's row) — no server route needed.
  async function updateUserRole(id, newRole) {
    const { error } = await supabase.from("profiles").update({ role: newRole }).eq("id", id);
    if (error) { pushToast(`Could not update role: ${error.message}`, "warn"); return; }
    setProfiles(ps => ps.map(p => p.id === id ? { ...p, role: newRole } : p));
    pushToast("Role updated", "ok");
  }

  // Creating a brand-new login needs the service-role key, so it goes through the server
  // route instead — the route re-checks that the caller is actually management itself,
  // never trusting this client-side gate alone.
  async function createTeamUser(draft) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify(draft),
      });
      // The route always returns JSON, even on failure — but if something upstream (a proxy,
      // a crash Next.js itself intercepts) ever returns HTML or plain text instead, .json()
      // throws. Falling back to .text() means the person sees *something* instead of nothing.
      let data;
      try { data = await res.json(); } catch { data = { error: (await res.text().catch(() => "")) || `Server returned ${res.status} with no readable error` }; }
      if (!res.ok) { pushToast(`Could not create user: ${data.error}`, "warn"); return null; }
      setProfiles(ps => [...ps, { id: data.userId, name: draft.name || draft.email, email: draft.email, role: draft.role }]);
      return data.tempPassword;
    } catch (err) {
      pushToast(`Could not create user: ${err.message}`, "warn");
      return null;
    }
  }

  async function resetTeamUserPassword(userId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ userId }),
      });
      let data;
      try { data = await res.json(); } catch { data = { error: (await res.text().catch(() => "")) || `Server returned ${res.status} with no readable error` }; }
      if (!res.ok) { pushToast(`Could not reset password: ${data.error}`, "warn"); return null; }
      return data.tempPassword;
    } catch (err) {
      pushToast(`Could not reset password: ${err.message}`, "warn");
      return null;
    }
  }

  async function deleteTeamUser(userId) {
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/admin/delete-user", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify({ userId }),
      });
      let data;
      try { data = await res.json(); } catch { data = { error: (await res.text().catch(() => "")) || `Server returned ${res.status} with no readable error` }; }
      if (!res.ok) { pushToast(`Could not delete user: ${data.error}`, "warn"); return; }
      setProfiles(ps => ps.filter(p => p.id !== userId));
      pushToast("User removed", "ok");
    } catch (err) {
      pushToast(`Could not delete user: ${err.message}`, "warn");
    }
  }

  const selectedFlight = flights.find(f => f.id === selectedFlightId) || null;
  const [showAddFlight, setShowAddFlight] = useState(false);
  const [addFlightPrefill, setAddFlightPrefill] = useState(null);
  function quickCreateFlight(prefill) { setAddFlightPrefill(prefill); setShowAddFlight(true); }
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showRotationGen, setShowRotationGen] = useState(false);
  const [showSchedulingEngine, setShowSchedulingEngine] = useState(false);
  const [showBulkRetime, setShowBulkRetime] = useState(false);
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [showSCR, setShowSCR] = useState(false);
  const [scrSeed, setScrSeed] = useState(null); // { flights: [...], role: "origin"|"destination" } | null

  function openSCR(flightsForSeed, role) {
    setScrSeed(flightsForSeed?.length ? { flights: flightsForSeed, role } : null);
    setShowSCR(true);
  }

  // Applies a date shift and/or a time change to every matched flight in one go — the "whole
  // season changed its block times" case, not just one flight at a time. Sequential awaits
  // rather than Promise.all so we don't fire dozens of concurrent writes at once.
  async function bulkRetime(matches, change) {
    for (const f of matches) {
      const patch = {};
      if (change.dayShift) patch.start = addDays(f.start, change.dayShift);
      if (change.timeMode === "shift" && change.minuteShift) {
        if (f.depTime) patch.depTime = minutesToHHMM(timeToMinutes(f.depTime) + change.minuteShift);
        if (f.arrTime) patch.arrTime = minutesToHHMM(timeToMinutes(f.arrTime) + change.minuteShift);
      } else if (change.timeMode === "set" && change.newDepTime) {
        const durMin = (f.depTime && f.arrTime) ? ((timeToMinutes(f.arrTime) - timeToMinutes(f.depTime) + 1440) % 1440) : null;
        patch.depTime = change.newDepTime;
        if (durMin != null) patch.arrTime = minutesToHHMM(timeToMinutes(change.newDepTime) + durMin);
      }
      if (Object.keys(patch).length) await updateFlight(f.id, patch, { silent: true });
    }
    pushToast(`Retimed ${matches.length} flight${matches.length === 1 ? "" : "s"}`, "ok");
    setShowBulkRetime(false);
  }

  function checkConflict(resourceId, dateObj, excludeFlightId) {
    return flights.find(f => f.id !== excludeFlightId && f.resourceId === resourceId && iso(f.start) === iso(dateObj));
  }

  async function insertSingleFlight(draft) {
    // Conflicts are advisory only — the toast says so, but the flight is always added.
    // Blocking the insert here would defeat the point of flagging it; ops staff can see the
    // warning and decide, but shouldn't be locked out of scheduling a genuine second flight.
    const conflict = checkConflict(draft.resourceId, draft.start, null);
    const ref = draft.ref || ("DV" + (4520 + flights.length + Math.floor(Math.random() * 50)));
    const { data, error } = await supabase.from("flights").insert({
      ref, resource_id: draft.resourceId, origin: draft.origin, destination: draft.destination,
      scheduled_departure: (combineDateAndTime(draft.start, draft.depTime) || draft.start).toISOString(),
      scheduled_arrival: combineArrivalDateTime(combineDateAndTime(draft.start, draft.depTime) || draft.start, draft.arrTime)?.toISOString() ?? null,
      capacity: draft.capacity, status: "tentative",
    }).select().single();
    if (error) { pushToast(`Insert failed: ${error.message}`, "warn"); return false; }
    const newFlight = mapFlight(data);
    setFlightsRaw(fl => [...fl, newFlight]);
    pushToast(`${ref} inserted onto the board${conflict ? ` — heads up: ${resources.find(r=>r.id===draft.resourceId)?.code} already flies ${conflict.ref} that day` : ""} — slot request drafts ready in its flight info`, conflict ? "warn" : "ok");
    pushNotification("Flight added", `${ref} · ${draft.origin}→${draft.destination}`, "flight");
    setShowAddFlight(false);
    setSelectedFlightId(newFlight.id); // opens the drawer straight away — slot-request buttons are right there
    return true;
  }

  async function commitBulkRows(rows) {
    const inserts = rows.map((r, i) => ({
      resource_id: r.resourceId, origin: r.origin, destination: r.destination,
      scheduled_departure: (combineDateAndTime(r.date, r.depTime) || r.date).toISOString(),
      scheduled_arrival: combineArrivalDateTime(combineDateAndTime(r.date, r.depTime) || r.date, r.arrTime)?.toISOString() ?? null,
      capacity: resources.find(res => res.id === r.resourceId)?.capacity,
      status: "tentative", ref: r.flightNo ? "DV" + r.flightNo : ("DV" + (4600 + i)), leg_type: r.legType || "revenue",
    }));
    const { data, error } = await supabase.from("flights").insert(inserts).select();
    if (error) { pushToast(`Import failed: ${error.message}`, "warn"); return; }
    const newFlights = (data || []).map(mapFlight);
    setFlightsRaw(fl => [...fl, ...newFlights]);
    const ferryCount = newFlights.filter(f => f.legType === "ferry").length;
    pushToast(`Imported ${newFlights.length} flight${newFlights.length === 1 ? "" : "s"}${ferryCount ? ` (${ferryCount} ferry/positioning, excluded from inventory)` : ""}`, "ok");
    pushNotification("Schedule update", `${newFlights.length} flights imported`, "flight");
    setShowBulkImport(false);
  }

  async function commitRotationDates(rows, pattern) {
    const inserts = rows.map(r => ({
      resource_id: pattern.resourceId, origin: r.origin, destination: r.destination,
      scheduled_departure: (combineDateAndTime(r.date, r.depTime) || r.date).toISOString(),
      scheduled_arrival: combineArrivalDateTime(combineDateAndTime(r.date, r.depTime) || r.date, r.arrTime)?.toISOString() ?? null,
      capacity: pattern.capacity, status: "tentative", ref: r.ref,
    }));
    const { data, error } = await supabase.from("flights").insert(inserts).select();
    if (error) { pushToast(`Rotation commit failed: ${error.message}`, "warn"); return; }
    const newFlights = (data || []).map(mapFlight);
    setFlightsRaw(fl => [...fl, ...newFlights]);
    pushToast(`Generated ${newFlights.length} flights from rotation pattern (${pattern.origin}⇄${pattern.destination})${pattern.includeReturn ? " — outbound + return" : ""}`, "ok");
    pushNotification("Rotation generated", `${newFlights.length} flights · ${pattern.origin}⇄${pattern.destination}`, "flight");
    setShowRotationGen(false);
  }

  async function commitSchedulingEngineRows(rows) {
    const inserts = rows.map(r => ({
      resource_id: r.resourceId, origin: r.origin, destination: r.destination,
      scheduled_departure: (combineDateAndTime(r.date, r.depTime) || r.date).toISOString(),
      scheduled_arrival: combineArrivalDateTime(combineDateAndTime(r.date, r.depTime) || r.date, r.arrTime)?.toISOString() ?? null,
      capacity: resources.find(res => res.id === r.resourceId)?.capacity, status: "tentative", ref: r.ref,
    }));
    const { data, error } = await supabase.from("flights").insert(inserts).select();
    if (error) { pushToast(`Scheduling engine commit failed: ${error.message}`, "warn"); return; }
    const newFlights = (data || []).map(mapFlight);
    setFlightsRaw(fl => [...fl, ...newFlights]);
    pushToast(`Scheduling engine added ${newFlights.length} flight${newFlights.length === 1 ? "" : "s"} across the fleet`, "ok");
    pushNotification("Schedule generated", `${newFlights.length} flights via scheduling engine`, "flight");
    setShowSchedulingEngine(false);
  }

  const NAV_ITEMS = [
    ["dashboard", "Dashboard", IconChart],
    ["schedule", "Schedule", IconCalendar],
    ["aircraft", "Aircraft", IconPlane],
    ["operators", "Tour operators", IconBuilding],
    ...(perms.manageUsers ? [["team", "Team", IconUsers]] : []),
  ];

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, height: "100vh", width: "100vw", overflow: "hidden", display: "flex", flexDirection: "row" }}>
      <style>{`
        @keyframes slideIn { from { transform: translateX(20px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }
        @keyframes pulseDot { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
        @keyframes popIn { from { transform: scale(0.96); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { height: 9px; width: 9px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 99px; border: 2px solid ${C.bg}; }
        button { transition: transform 0.12s cubic-bezier(.2,.8,.2,1), box-shadow 0.15s ease, background 0.15s ease, opacity 0.15s ease; }
        button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.02); }
        button:active:not(:disabled) { transform: translateY(0) scale(0.97); }
        button:disabled { cursor: default; opacity: 0.55; }
        input, select, textarea { transition: box-shadow 0.15s ease, border-color 0.15s ease; }
        input:focus, select:focus, textarea:focus { outline: none; box-shadow: 0 0 0 3px ${C.amber}2A; border-color: ${C.amber}; }
        .modal-pop { animation: popIn 0.16s cubic-bezier(.2,.8,.2,1); }
        .sidebar-nav-item:hover { background: ${SIDEBAR.bgActive} !important; }
        .flight-bar:hover { box-shadow: 0 3px 10px rgba(30,42,61,0.16); transform: translateY(-1px); }
        .leaflet-container { border-radius: 10px; }
        @media (max-width: 640px) {
          /* Every modal shares this class — full-screen on a phone instead of a centered
             fixed-width box, since a 560-720px modal simply doesn't fit. !important is
             required here because inline styles normally beat stylesheet rules; it's the
             one legitimate case for it in this file. */
          .modal-pop { width: 100vw !important; max-width: 100vw !important; height: 100vh !important; max-height: 100vh !important; border-radius: 0 !important; }
          .chat-panel { width: 100vw !important; left: 0 !important; right: 0 !important; bottom: 0 !important; height: 70vh !important; border-radius: 16px 16px 0 0 !important; }
        }
      `}</style>

      {!loaded ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: C.muted, fontFamily: MONO, fontSize: 13 }}>
          Loading shared schedule…
        </div>
      ) : (
      <>
      {isMobile && mobileSidebarOpen && (
        <div onClick={() => setMobileSidebarOpen(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200 }} />
      )}
      <aside style={{
        width: isMobile ? 240 : (sidebarCollapsed ? 64 : 232), flexShrink: 0, display: "flex", flexDirection: "column", background: SIDEBAR.bg,
        padding: isMobile ? "18px 12px" : (sidebarCollapsed ? "18px 8px" : "18px 12px"),
        position: isMobile ? "fixed" : "relative", top: isMobile ? 0 : undefined, left: isMobile ? 0 : undefined,
        height: isMobile ? "100vh" : undefined, zIndex: isMobile ? 201 : undefined,
        transform: isMobile ? (mobileSidebarOpen ? "translateX(0)" : "translateX(-100%)") : "none",
        transition: "width 0.15s ease, padding 0.15s ease, transform 0.2s ease",
      }}>
        {!isMobile && (
          <button onClick={() => setSidebarCollapsed(v => !v)} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            style={{ position: "absolute", top: 20, right: -11, width: 22, height: 22, borderRadius: 999, border: `1px solid ${SIDEBAR.border}`, background: SIDEBAR.bgActive, color: SIDEBAR.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, padding: 0, zIndex: 5 }}>
            {sidebarCollapsed ? "›" : "‹"}
          </button>
        )}
        {isMobile && (
          <button onClick={() => setMobileSidebarOpen(false)} title="Close menu"
            style={{ position: "absolute", top: 16, right: 16, width: 28, height: 28, borderRadius: 999, border: `1px solid ${SIDEBAR.border}`, background: SIDEBAR.bgActive, color: SIDEBAR.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}>
            <IconX size={15} />
          </button>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: (sidebarCollapsed && !isMobile) ? "0" : "0 8px", marginBottom: 26, justifyContent: (sidebarCollapsed && !isMobile) ? "center" : "flex-start" }}>
          <img src="/logo-mark.png" alt="" style={{ height: 24, width: "auto", flexShrink: 0 }} />
          {!(sidebarCollapsed && !isMobile) && <div style={{ fontFamily: SANS, fontWeight: 700, letterSpacing: 0.2, fontSize: 14, color: SIDEBAR.text, whiteSpace: "nowrap" }}>CHARTER OPS</div>}
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {NAV_ITEMS.map(([k, l, Icon]) => (
            <button key={k} className="sidebar-nav-item" onClick={() => { setTab(k); if (isMobile) setMobileSidebarOpen(false); }} title={(sidebarCollapsed && !isMobile) ? l : undefined}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: (sidebarCollapsed && !isMobile) ? "9px 0" : "9px 10px", justifyContent: (sidebarCollapsed && !isMobile) ? "center" : "flex-start", borderRadius: 8, border: "none",
                background: tab === k ? SIDEBAR.bgActive : "transparent", color: tab === k ? SIDEBAR.text : SIDEBAR.muted,
                fontSize: 13, fontWeight: tab === k ? 600 : 500, cursor: "pointer", fontFamily: SANS, textAlign: "left", width: "100%" }}>
              <Icon /> {!(sidebarCollapsed && !isMobile) && l}
            </button>
          ))}
        </nav>
        <div style={{ borderTop: `1px solid ${SIDEBAR.border}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: (sidebarCollapsed && !isMobile) ? "0" : "0 10px", justifyContent: (sidebarCollapsed && !isMobile) ? "center" : "flex-start", fontFamily: SANS, fontWeight: 500, fontSize: 11.5, color: live ? C.green : SIDEBAR.muted }} title="Synced live via Supabase Realtime">
            <span style={{ width: 7, height: 7, borderRadius: 99, background: live ? C.green : SIDEBAR.muted, display: "inline-block", animation: live ? "pulseDot 1.6s infinite" : "none", flexShrink: 0 }} />
            {!(sidebarCollapsed && !isMobile) && (live ? "Synced" : "Offline")}
          </div>
          {!(sidebarCollapsed && !isMobile) && (
            <div style={{ padding: "0 10px", fontSize: 12, color: SIDEBAR.text, lineHeight: 1.4 }}>
              {profile.name}<br /><span style={{ color: SIDEBAR.muted, fontSize: 11 }}>{ROLES[role]?.label}</span>
            </div>
          )}
          <button onClick={onSignOut} title={(sidebarCollapsed && !isMobile) ? "Sign out" : undefined} style={{ ...miniBtn, width: "100%", background: SIDEBAR.bgActive, color: SIDEBAR.text, borderColor: SIDEBAR.border }}>{(sidebarCollapsed && !isMobile) ? "⏻" : "Sign out"}</button>
        </div>
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: isMobile ? "10px 12px" : "12px 20px", borderBottom: `1px solid ${C.borderSoft}`, background: C.panel, position: "relative", gap: 8 }}>
        {isMobile && (
          <button onClick={() => setMobileSidebarOpen(true)} title="Menu" style={{ ...miniBtn, padding: 8, flexShrink: 0 }}>
            <IconMenu />
          </button>
        )}
        <div style={{ position: "relative", flex: isMobile ? 1 : undefined, width: isMobile ? undefined : 320, minWidth: 0 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: C.faint }}><IconSearch /></span>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder={isMobile ? "Search…" : "Search flights, routes, operators…"}
            style={{ ...inputStyle, paddingLeft: 36, background: C.panel2, border: `1px solid ${C.borderSoft}`, width: "100%" }} />
          {searchQuery.trim() && (
            <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, width: "100%", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.12)", zIndex: 50, maxHeight: 280, overflow: "auto" }}>
              {(() => {
                const q = searchQuery.trim().toLowerCase();
                const matchedFlights = flights.filter(f => f.ref.toLowerCase().includes(q) || f.origin.toLowerCase().includes(q) || f.destination.toLowerCase().includes(q)).slice(0, 5);
                const matchedOps = operators.filter(o => o.name.toLowerCase().includes(q)).slice(0, 5);
                if (!matchedFlights.length && !matchedOps.length) return <div style={{ padding: 14, fontSize: 12.5, color: C.faint }}>No matches.</div>;
                return <>
                  {matchedFlights.map(f => (
                    <div key={f.id} onClick={() => { setTab("schedule"); setSelectedFlightId(f.id); setSearchQuery(""); }}
                      style={{ padding: "9px 14px", fontSize: 12.5, cursor: "pointer", borderBottom: `1px solid ${C.borderSoft}` }}>
                      <span style={{ fontFamily: MONO, color: C.amber, fontWeight: 600 }}>{f.ref}</span> <span style={{ color: C.muted }}>{f.origin}→{f.destination}</span>
                    </div>
                  ))}
                  {matchedOps.map(o => (
                    <div key={o.id} onClick={() => { setTab("operators"); setSearchQuery(""); }}
                      style={{ padding: "9px 14px", fontSize: 12.5, cursor: "pointer", borderBottom: `1px solid ${C.borderSoft}` }}>
                      <span style={{ color: C.text }}>{o.name}</span> <span style={{ color: C.faint }}>· tour operator</span>
                    </div>
                  ))}
                </>;
              })()}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 8 : 16, flexShrink: 0 }}>
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowNotifPanel(v => !v)} style={{ ...miniBtn, position: "relative", padding: 8, borderRadius: 999 }}>
              <IconBell />
              {notifications.length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 7, height: 7, borderRadius: 99, background: C.red }} />}
            </button>
            {showNotifPanel && (
              <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: "min(300px, 88vw)", background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.14)", zIndex: 50, maxHeight: 320, overflow: "auto" }}>
                <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${C.borderSoft}` }}>Notifications</div>
                {notifications.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.faint }}>Nothing yet — actions across the app show up here.</div>}
                {notifications.map(n => <NotificationRow key={n.id} n={n} />)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 30, height: 30, borderRadius: 999, background: C.amberSoft, color: C.amber, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{(profile.name || "U")[0].toUpperCase()}</div>
            {!isMobile && (
              <div style={{ lineHeight: 1.3 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{profile.name}</div>
                <div style={{ fontSize: 10.5, color: C.faint }}>{new Date().toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "auto" }}>
      {tab === "schedule" && (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: "auto" }}>
            <ScheduleBoard resources={resources} flights={flights} operators={operators} days={days} viewStart={effectiveViewStart} onShiftView={shiftView} onJumpToday={jumpToToday} onJumpToDate={jumpToDate}
              viewMode={viewMode} setViewMode={setViewMode} rangeFrom={rangeFrom} setRangeFrom={setRangeFrom} rangeTo={rangeTo} setRangeTo={setRangeTo} DAYS={DAYS}
              showLocal={showLocal} setShowLocal={setShowLocal} onDropFlight={dropFlight}
              selectedFlightId={selectedFlightId} setSelectedFlightId={setSelectedFlightId} flightInventory={flightInventory}
              perms={perms} onNewFlight={() => { setAddFlightPrefill(null); setShowAddFlight(true); }} onBulkImport={() => setShowBulkImport(true)} onRotationGen={() => setShowRotationGen(true)}
              onBulkRetime={() => setShowBulkRetime(true)} onBulkDelete={() => setShowBulkDelete(true)} onGenSCR={() => openSCR(null, null)}
              onUpdateFlight={updateFlight} onDeleteFlight={deleteFlight} onDuplicateFlight={duplicateFlight} onSetFlightColor={setFlightColor} onQuickCreate={quickCreateFlight}
              onSchedulingEngine={() => setShowSchedulingEngine(true)} ganttScale={ganttScale} onGanttScaleChange={persistGanttScale} maintenanceBlocks={maintenanceBlocks}
              acknowledgedIssueIds={acknowledgedIssueIds} onAcknowledgeIssue={acknowledgeIssue} onUnacknowledgeIssue={unacknowledgeIssue}
              draftMode={draftMode} setDraftMode={setDraftMode} draftChanges={draftChanges} onApproveDraft={approveDraftChange} onDiscardDraft={discardDraftChange} onApproveAllDrafts={approveAllDrafts} onDiscardAllDrafts={discardAllDrafts} />
          </div>
          {selectedFlight && (
            <FlightDrawer key={selectedFlight.id} flight={selectedFlight} resources={resources} operators={operators} allotments={allotments.filter(a => a.flightId === selectedFlight.id)}
              inventory={flightInventory(selectedFlight.id)} perms={perms}
              onUpdateFlight={patch => updateFlight(selectedFlight.id, patch)}
              onAddAllotment={(opId, seats, price) => addAllotment(selectedFlight.id, opId, seats, price)}
              onPatchAllotment={patchAllotment} onRemoveAllotment={removeAllotment}
              onOpenSCR={role => openSCR([selectedFlight], role)}
              onDeleteFlight={deleteFlight}
              onClose={() => setSelectedFlightId(null)} />
          )}
        </div>
      )}
      {tab === "operators" && <OperatorsPanel operators={operators} setOperators={setOperators} flights={flights} allotments={allotments} perms={perms}
        onAddOperator={addOperator} onBulkImportOperators={commitBulkOperators} onDeleteOperator={deleteOperator} onAddAllotment={addAllotment} />}
      {tab === "team" && perms.manageUsers && <TeamPanel profiles={profiles} currentUserId={profile.id} onUpdateRole={updateUserRole} onCreateUser={createTeamUser} onDeleteUser={deleteTeamUser} onResetPassword={resetTeamUserPassword} pushToast={pushToast} />}
      {tab === "dashboard" && <Dashboard flights={flights} allotments={allotments} resources={resources} operators={operators} flightInventory={flightInventory} perms={perms}
        tasks={tasks} onAddTask={addTask} onToggleTask={toggleTask} notifications={notifications} setTab={setTab} setSelectedFlightId={setSelectedFlightId} />}
      {tab === "aircraft" && <AircraftPanel resources={resources} flights={flights} perms={perms} onAddResource={addResource} onUpdateResource={updateResource} onDeleteResource={deleteResource}
        maintenanceBlocks={maintenanceBlocks} onAddMaintenanceBlock={addMaintenanceBlock} onDeleteMaintenanceBlock={deleteMaintenanceBlock} />}
      </div>

      {showAddFlight && <AddFlightModal resources={resources} prefill={addFlightPrefill} onClose={() => { setShowAddFlight(false); setAddFlightPrefill(null); }} onCreate={insertSingleFlight} checkConflict={checkConflict} />}
      {showBulkImport && <BulkImportModal resources={resources} flights={flights} onClose={() => setShowBulkImport(false)} onCommit={commitBulkRows} />}
      {showRotationGen && <RotationGenModal resources={resources} flights={flights} onClose={() => setShowRotationGen(false)} onCommit={commitRotationDates} />}
      {showSchedulingEngine && <SchedulingEngineModal resources={resources} flights={flights} isGrounded={isGrounded} onClose={() => setShowSchedulingEngine(false)} onCommit={commitSchedulingEngineRows} />}
      {showBulkRetime && <BulkRetimeModal resources={resources} flights={flights} onClose={() => setShowBulkRetime(false)} onCommit={bulkRetime} />}
      {showBulkDelete && <BulkDeleteModal resources={resources} flights={flights} allotments={allotments} onClose={() => setShowBulkDelete(false)} onCommit={bulkDeleteFlights} />}
      {showSCR && <SCRModal resources={resources} flights={flights} onClose={() => { setShowSCR(false); setScrSeed(null); }} seedFlights={scrSeed?.flights} seedRole={scrSeed?.role} />}
      </div>
      </>
      )}
      <Toast items={toasts} onDismiss={dismissToast} />
      <ChatWidget open={chatOpen} setOpen={setChatOpen} messages={chatMessages} busy={chatBusy} onSend={sendChatMessage} onClear={clearChatHistory} />
    </div>
  );
}

// ---------- schedule board ----------
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]; // every 3h — labeled 0000/0300/.../2100, always UTC
function hourTickLabel(h) { return String(h).padStart(2, "0") + "00"; }
// computeScheduleIssues now lives in lib/scheduling-utils.js (imported at the top) — extracted
// alongside the other pure logic so it can be unit tested directly.

function ScheduleBoard({ resources, flights, operators, days, viewStart, onShiftView, onJumpToday, onJumpToDate, selectedFlightId, setSelectedFlightId, flightInventory, perms, onNewFlight, onBulkImport, onRotationGen, showLocal, setShowLocal, onDropFlight, onBulkRetime, onBulkDelete, onGenSCR, viewMode, setViewMode, rangeFrom, setRangeFrom, rangeTo, setRangeTo, DAYS, onUpdateFlight, onDeleteFlight, onDuplicateFlight, onSetFlightColor, onQuickCreate, onSchedulingEngine, ganttScale, onGanttScaleChange, maintenanceBlocks, acknowledgedIssueIds, onAcknowledgeIssue, onUnacknowledgeIssue, draftMode, setDraftMode, draftChanges, onApproveDraft, onDiscardDraft, onApproveAllDrafts, onDiscardAllDrafts }) {
  // ---- back to hand-rolled rendering ----
  // vis-timeline gave us native pan/zoom/resize, but every bug we hit in it (the async
  // population race, the timezone disguise, the move/resize conflation, three attempts at
  // right-click) came from not being able to run a real browser here to verify a third-party
  // library's undocumented behavior. Code we write ourselves doesn't have that problem — when
  // something's wrong, the actual logic is right here to read, not something to guess at.
  const [liveScale, setLiveScale] = useState(ganttScale);
  useEffect(() => { setLiveScale(ganttScale); }, [ganttScale]);
  const PERIOD_COL_MIN = 20, PERIOD_COL_MAX = 180;
  const sliderT = Math.min(1, Math.max(0, (liveScale - 0.7) / 0.7));
  const COL = viewMode === "day" ? 720 : Math.round(PERIOD_COL_MIN + sliderT * (PERIOD_COL_MAX - PERIOD_COL_MIN));
  const LABELW = 160;
  const isNarrow = viewMode !== "day" && COL < 70;
  const showHourTicks = viewMode === "day" || COL >= 160;
  const TICK = COL / HOUR_TICKS.length;
  const HOUR_TICK = COL / 24; // fine per-hour gridline spacing — kept separate from the 3-hourly label ticks above so the axis labels don't get crowded while the grid itself still marks every hour
  function colFor(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return Math.round((x.getTime() - viewStart.getTime()) / 86400000); }

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  const now = new Date(nowTick);
  const nowCol = colFor(now);
  const nowVisible = nowCol >= 0 && nowCol < days.length;
  const nowX = LABELW + nowCol * COL + ((now.getUTCHours() * 60 + now.getUTCMinutes()) / 1440) * COL;

  const [showDestLegend, setShowDestLegend] = useState(false);
  const [showDraftPanel, setShowDraftPanel] = useState(false);
  const [hoverFlightId, setHoverFlightId] = useState(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const hoverTimerRef = useRef(null);
  const draftByFlightId = useMemo(() => {
    const m = new Map();
    draftChanges.forEach(d => { if (d.flightId) m.set(d.flightId, d); });
    return m;
  }, [draftChanges]);
  const pendingCreates = draftChanges.filter(d => d.changeType === "create");
  const [showIssues, setShowIssues] = useState(false);
  const allIssues = useMemo(() => computeScheduleIssues(flights, resources), [flights, resources]);
  const activeIssues = allIssues.filter(i => !acknowledgedIssueIds.has(i.id));
  const acknowledgedIssuesList = allIssues.filter(i => acknowledgedIssueIds.has(i.id));
  const errorCount = activeIssues.filter(i => i.severity === "error").length;
  const [issuesTab, setIssuesTab] = useState("active"); // "active" | "acknowledged"
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [contextMenu, setContextMenu] = useState(null); // { type: 'flight'|'create', ... }
  const [multiSelectIds, setMultiSelectIds] = useState(() => new Set());
  const [marquee, setMarquee] = useState(null); // { startX, startY, curX, curY }
  const [panDrag, setPanDrag] = useState(null); // { startClientX, startClientY, panStartScrollLeft, panStartScrollTop }
  const [resizeDrag, setResizeDrag] = useState(null); // { flightId, edge, startClientX, origDep, origArr, deltaMin }
  const panDragRef = useRef(null);
  const boardRef = useRef(null);
  const [touchDrag, setTouchDrag] = useState(null); // { flightId, ref, x, y }
  const touchDragRef = useRef(null);
  const longPressTimerRef = useRef(null);
  const touchStartPosRef = useRef(null);

  function matchesFilter(f) {
    if (!filterText.trim()) return true;
    const q = filterText.trim().toLowerCase();
    return f.ref?.toLowerCase().includes(q) || f.origin?.toLowerCase().includes(q) || f.destination?.toLowerCase().includes(q);
  }

  // ---- touch drag (mobile move) — long-press distinguishes drag intent from a normal scroll ----
  function handleFlightTouchStart(e, f) {
    if (!perms.editFlight || !draftMode) return;
    const t = e.touches[0];
    touchStartPosRef.current = { x: t.clientX, y: t.clientY };
    longPressTimerRef.current = setTimeout(() => {
      const drag = { flightId: f.id, ref: f.ref, x: t.clientX, y: t.clientY };
      touchDragRef.current = drag;
      setTouchDrag(drag);
    }, 350);
  }
  function handleFlightTouchMoveBeforeDrag(e) {
    if (touchDragRef.current || !touchStartPosRef.current || !longPressTimerRef.current) return;
    const t = e.touches[0];
    const dx = Math.abs(t.clientX - touchStartPosRef.current.x), dy = Math.abs(t.clientY - touchStartPosRef.current.y);
    if (dx > 10 || dy > 10) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }
  function handleFlightTouchEndBeforeDrag() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
  }
  const dragActive = !!touchDrag;
  useEffect(() => {
    if (!dragActive) return;
    function onMove(e) {
      e.preventDefault();
      const t = e.touches[0];
      const next = { ...touchDragRef.current, x: t.clientX, y: t.clientY };
      touchDragRef.current = next;
      setTouchDrag(next);
    }
    function onEnd() {
      const drag = touchDragRef.current;
      if (drag) {
        const el = document.elementFromPoint(drag.x, drag.y);
        const rowEl = el?.closest("[data-resource-id]");
        if (rowEl) {
          const resourceId = rowEl.getAttribute("data-resource-id");
          const idsToMove = (multiSelectIds.has(drag.flightId) && multiSelectIds.size > 1) ? [...multiSelectIds] : [drag.flightId];
          idsToMove.forEach(id => onDropFlight(id, resourceId)); // drag only ever reassigns the aircraft — date/time are untouched
        }
      }
      touchDragRef.current = null;
      setTouchDrag(null);
    }
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd);
    document.addEventListener("touchcancel", onEnd);
    return () => {
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [dragActive]);

  // ---- resize (mouse, desktop) ----
  useEffect(() => {
    if (!resizeDrag) return;
    function onMove(e) {
      const deltaPx = e.clientX - resizeDrag.startClientX;
      const deltaMin = Math.round(((deltaPx / COL) * 1440) / 15) * 15;
      setResizeDrag(rd => ({ ...rd, deltaMin }));
    }
    function onUp() {
      const deltaMin = resizeDrag.deltaMin || 0;
      if (deltaMin !== 0) {
        if (resizeDrag.edge === "left") {
          const newDep = ((resizeDrag.origDep + deltaMin) % 1440 + 1440) % 1440;
          onUpdateFlight(resizeDrag.flightId, { depTime: minutesToHHMM(newDep) });
        } else {
          const newArr = ((resizeDrag.origArr + deltaMin) % 1440 + 1440) % 1440;
          onUpdateFlight(resizeDrag.flightId, { arrTime: minutesToHHMM(newArr) });
        }
      }
      setResizeDrag(null);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [resizeDrag, COL]);

  // ---- pan (mouse, desktop) — both axes, only while the button is actually held ----
  const panDragActive = !!panDrag;
  useEffect(() => {
    if (!panDragActive) return;
    function onMove(e) {
      const pd = panDragRef.current;
      if (boardRef.current) {
        boardRef.current.scrollLeft = pd.panStartScrollLeft - (e.clientX - pd.startClientX);
        boardRef.current.scrollTop = pd.panStartScrollTop - (e.clientY - pd.startClientY);
      }
    }
    function onUp() { panDragRef.current = null; setPanDrag(null); }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [panDragActive]);

  // ---- marquee (shift+drag) ----
  useEffect(() => {
    if (!marquee) return;
    function onMove(e) { setMarquee(m => ({ ...m, curX: e.clientX, curY: e.clientY })); }
    function onUp(e) {
      const x1 = Math.min(marquee.startX, e.clientX), x2 = Math.max(marquee.startX, e.clientX);
      const y1 = Math.min(marquee.startY, e.clientY), y2 = Math.max(marquee.startY ?? marquee.startY, e.clientY);
      const picked = new Set();
      if (boardRef.current) {
        boardRef.current.querySelectorAll("[data-flight-id]").forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) picked.add(el.getAttribute("data-flight-id"));
        });
      }
      setMultiSelectIds(picked);
      setMarquee(null);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [marquee]);

  useEffect(() => {
    if (!contextMenu) return;
    function close() { setContextMenu(null); }
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => { document.removeEventListener("click", close); document.removeEventListener("contextmenu", close); };
  }, [contextMenu]);

  useEffect(() => {
    function onKeyDown(e) {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
      if (typing) return;
      if (e.key === "Escape") { setMultiSelectIds(new Set()); setSelectedFlightId(null); setContextMenu(null); return; }
      if (!perms.editFlight) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (multiSelectIds.size > 0) {
          if (window.confirm(`Delete ${multiSelectIds.size} selected flight(s)? This can't be undone.`)) {
            multiSelectIds.forEach(id => onDeleteFlight(id));
            setMultiSelectIds(new Set());
          }
        } else if (selectedFlightId) {
          if (window.confirm("Delete this flight? This can't be undone.")) onDeleteFlight(selectedFlightId);
        }
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && selectedFlightId && multiSelectIds.size === 0) {
        const f = flights.find(x => x.id === selectedFlightId);
        if (f) onUpdateFlight(selectedFlightId, { start: addDays(f.start, e.key === "ArrowLeft" ? -1 : 1) });
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selectedFlightId, multiSelectIds, perms.editFlight, flights]);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", gap: 2, background: C.panel2, borderRadius: 999, padding: 3 }}>
            {[["day", "Day"], ["period", "Period"]].map(([k, l]) => (
              <button key={k} onClick={() => setViewMode(k)} style={{ background: viewMode === k ? C.panel : "transparent", color: viewMode === k ? C.text : C.muted, border: "none", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: viewMode === k ? 600 : 500, cursor: "pointer", fontFamily: SANS, boxShadow: viewMode === k ? "0 1px 3px rgba(58,54,47,0.10)" : "none" }}>{l}</button>
            ))}
          </div>
          {viewMode === "period" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input type="date" value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} style={{ ...inputStyle, padding: "6px 8px" }} />
              <span style={{ fontSize: 11.5, color: C.muted }}>to</span>
              <input type="date" value={rangeTo} min={rangeFrom} onChange={e => setRangeTo(e.target.value)} style={{ ...inputStyle, padding: "6px 8px" }} />
            </div>
          )}
          <div style={{ display: "flex", gap: 4, borderLeft: `1px solid ${C.borderSoft}`, paddingLeft: 12 }}>
            <button onClick={() => onShiftView(-1)} style={navBtn}>◀</button>
            <button onClick={onJumpToday} style={navBtn}>Today</button>
            <button onClick={() => onShiftView(1)} style={navBtn}>▶</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input value={filterText} onChange={e => setFilterText(e.target.value)} placeholder="Filter (ref, route)…"
            style={{ ...inputStyle, width: 150, fontSize: 12 }} />
          <button onClick={() => setShowLocal(v => !v)} title="Times are always stored in UTC — this only changes the display" style={{ ...navBtn, background: showLocal ? C.cyanSoft : "transparent", borderColor: showLocal ? C.cyan : C.border, color: showLocal ? C.cyan : C.text }}>
            {showLocal ? "Local time" : "UTC"}
          </button>
          <button onClick={() => setShowIssues(v => !v)} title="Turnaround, routing, capacity and double-booking checks"
            style={{ ...navBtn, background: showIssues ? C.redSoft : (errorCount > 0 ? C.redSoft : activeIssues.length > 0 ? C.amberSoft : "transparent"), borderColor: activeIssues.length > 0 ? (errorCount > 0 ? C.red : C.amber) : C.border, color: activeIssues.length > 0 ? (errorCount > 0 ? C.red : C.amber) : C.text, fontWeight: activeIssues.length > 0 ? 600 : 500 }}>
            Issues{activeIssues.length > 0 ? ` (${activeIssues.length})` : ""}
          </button>
          {perms.editFlight && (
            <button onClick={() => setDraftMode(v => !v)} title="While on, your own drags/resizes/deletes/duplicates and drawer edits are queued for review instead of applied live — other users editing without it on are unaffected"
              style={{ ...navBtn, background: draftMode ? C.amber : "transparent", color: draftMode ? ON_ACCENT : C.text, borderColor: draftMode ? C.amber : C.border, fontWeight: draftMode ? 600 : 500 }}>
              {draftMode ? "Draft mode: ON" : "Draft mode: OFF"}
            </button>
          )}
          {draftChanges.length > 0 && (
            <button onClick={() => setShowDraftPanel(v => !v)}
              style={{ ...navBtn, background: showDraftPanel ? C.amberSoft : C.amberSoft, borderColor: C.amber, color: C.amber, fontWeight: 600 }}>
              Draft changes ({draftChanges.length})
            </button>
          )}
          <div title="Box size / zoom (in Period view)" style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px", border: `1px solid ${C.border}`, borderRadius: 8, height: 32 }}>
            <span style={{ fontSize: 10 }}>A</span>
            <input type="range" min={0.7} max={1.4} step={0.05} value={liveScale}
              onChange={e => setLiveScale(+e.target.value)}
              onMouseUp={e => onGanttScaleChange(+e.target.value)}
              onTouchEnd={e => onGanttScaleChange(liveScale)}
              style={{ width: 70, accentColor: C.amber }} />
            <span style={{ fontSize: 13 }}>A</span>
          </div>
          <div style={{ position: "relative" }}>
            <button onClick={e => { e.stopPropagation(); setShowMoreMenu(v => !v); }} style={navBtn}>More ▾</button>
            {showMoreMenu && (
              <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.16)", zIndex: 60, minWidth: 170, padding: 6 }}>
                <button onClick={() => { onGenSCR(); setShowMoreMenu(false); }} style={ctxMenuItem}>Generate SCR</button>
                {perms.editFlight && <>
                  <button onClick={() => { onRotationGen(); setShowMoreMenu(false); }} style={ctxMenuItem}>Generate rotation</button>
                  <button onClick={() => { onSchedulingEngine(); setShowMoreMenu(false); }} style={{ ...ctxMenuItem, fontWeight: 600 }}>Scheduling engine</button>
                  <button onClick={() => { onBulkImport(); setShowMoreMenu(false); }} style={ctxMenuItem}>Bulk import</button>
                  <button onClick={() => { onBulkRetime(); setShowMoreMenu(false); }} style={ctxMenuItem}>Bulk retime</button>
                  <button onClick={() => { onBulkDelete(); setShowMoreMenu(false); }} style={{ ...ctxMenuItem, color: C.red }}>Bulk delete</button>
                </>}
              </div>
            )}
          </div>
          {perms.editFlight && <button onClick={onNewFlight} style={{ ...navBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ New flight</button>}
        </div>
      </div>
      {showLocal && <div style={{ fontSize: 11, color: C.faint, marginTop: -6, marginBottom: 10 }}>Showing each flight's departure/arrival in its own station's local time. "?" means that station isn't in the timezone table yet.</div>}

      <div ref={boardRef} style={{ overflowX: "auto", overflowY: "auto", maxHeight: "70vh", border: `1px solid ${C.border}`, borderRadius: 12 }}>
        <div style={{ minWidth: LABELW + days.length * COL, position: "relative" }}>
          {nowVisible && (
            <div title={`Now — ${now.toISOString().slice(11, 16)} UTC`}
              style={{ position: "absolute", left: nowX, top: 0, bottom: 0, width: 2, background: C.red, zIndex: 20, pointerEvents: "none" }}>
              <div style={{ position: "absolute", top: -5, left: -4, width: 10, height: 10, borderRadius: 999, background: C.red, boxShadow: `0 0 0 3px ${C.redSoft}` }} />
            </div>
          )}
          <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 25, background: C.panel, borderBottom: `1px solid ${C.border}` }}>
            <div style={{ width: LABELW, flexShrink: 0, padding: "8px 12px", fontSize: 11, color: C.faint, fontFamily: MONO, position: "sticky", left: 0, zIndex: 30, background: C.panel }}>Aircraft</div>
            {days.map((d, i) => {
              const dow = d.getUTCDay();
              const isWeekend = dow === 0 || dow === 6;
              const isToday = iso(d) === iso(new Date());
              return <div key={i} onClick={() => { if (viewMode !== "day") onJumpToDate(d); }}
                title={viewMode !== "day" ? "Click to view this day alone" : undefined}
                style={{ width: COL, flexShrink: 0, textAlign: "center", padding: "8px 0 2px", fontSize: 12, fontFamily: MONO, color: isToday ? C.amber : C.text, borderLeft: `1.5px solid ${C.border}`, background: isToday ? C.amberSoft : (isWeekend ? C.panel2 : "transparent"), cursor: viewMode !== "day" ? "pointer" : "default" }}>
                <div style={{ fontWeight: 700, color: isToday ? C.amber : C.text }}>{d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</div>
                <div style={{ fontWeight: 700, color: isToday ? C.amber : C.text }}>{d.getUTCDate()}/{d.getUTCMonth() + 1}</div>
                {showHourTicks && (
                  <div style={{ display: "flex", borderTop: `1px solid ${C.borderSoft}`, marginTop: 2 }}>
                    {HOUR_TICKS.map((h, hi) => <div key={hi} style={{ width: TICK, fontSize: 8.5, color: C.faint }}>{h}</div>)}
                  </div>
                )}
              </div>;
            })}
          </div>

          {(() => {
            const sortedResources = [...resources].sort((a, b) => (a.variant || "").localeCompare(b.variant || "") || a.code.localeCompare(b.code));
            const filterActive = filterText.trim().length > 0;
            const anyMatch = !filterActive || flights.some(matchesFilter);
            let lastVariant = null;
            return (
              <>
                {filterActive && !anyMatch && (
                  <div style={{ padding: "28px 16px", textAlign: "center", color: C.muted, fontSize: 12.5 }}>
                    Nothing matches "{filterText}". Try a flight number or a 3-4 letter airport code.
                  </div>
                )}
                {sortedResources.map(res => {
                  const showDivider = res.variant !== lastVariant;
                  lastVariant = res.variant;
                  const resFlights = flights.filter(f => f.resourceId === res.id).map(f => ({ f, c: colFor(f.start) })).filter(x => x.c >= 0 && x.c < days.length);
                  const laneOf = new Map();
                  let maxLanes = 1;
                  if (resFlights.length > 0) {
                    const cById = new Map(resFlights.map(x => [x.f.id, x.c]));
                    const geomFn = f => {
                      const c = cById.get(f.id);
                      const g = effectiveGeometry(f, isNarrow);
                      if (isNarrow) return { offsetFrac: c + g.offsetFrac, widthFrac: g.widthFrac };
                      const bufferFrac = 42 / COL;
                      return { offsetFrac: c + g.offsetFrac - bufferFrac / 2, widthFrac: g.widthFrac + bufferFrac };
                    };
                    const { laneOf: allLaneOf, laneCount } = assignLanes(resFlights.map(x => x.f), geomFn);
                    allLaneOf.forEach((lane, fid) => laneOf.set(fid, lane));
                    maxLanes = Math.max(maxLanes, laneCount);
                  }
                  const BAR_H = Math.round((isNarrow ? 44 : 30) * liveScale);
                  const BAR_GAP = Math.round(8 * liveScale), TOP_PAD = Math.round(12 * liveScale);
                  const rowHeight = Math.max(Math.round(58 * liveScale), TOP_PAD + maxLanes * (BAR_H + BAR_GAP));

                  // Maintenance blocks for this aircraft, clipped to the visible day range —
                  // rendered as a shaded region spanning however many days they cover.
                  const resMaint = (maintenanceBlocks || []).filter(m => m.resourceId === res.id);

                  return (
                    <React.Fragment key={res.id}>
                    {showDivider && (
                      <div style={{ display: "flex", alignItems: "center", padding: "5px 12px", background: C.panel2, borderBottom: `1px solid ${C.borderSoft}`, borderTop: lastVariant !== null ? `1px solid ${C.border}` : "none" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 600, color: C.muted }}>{res.variant || "Unclassified"}</span>
                      </div>
                    )}
                    <div style={{ display: "flex", borderBottom: `1px solid ${C.text}`, position: "relative", minHeight: rowHeight }}>

              <div style={{ width: LABELW, flexShrink: 0, padding: "8px 12px", display: "flex", flexDirection: "column", justifyContent: "center", borderRight: `1px solid ${C.border}`, background: C.panel2, position: "sticky", left: 0, zIndex: 15 }}>
                <div style={{ display: "flex", alignItems: "center" }}>
                  <span style={{ fontFamily: MONO, fontWeight: 700, color: C.text }}>{res.code}</span>
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 10.5, color: C.text, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 5, padding: "1px 6px", marginLeft: 8 }}>{res.capacity}Y</span>
                </div>
                {maxLanes > 1 && <div style={{ fontSize: 9.5, color: C.faint, marginTop: 2 }}>up to {maxLanes} flights/day</div>}
              </div>
              <div data-resource-id={res.id} style={{ position: "relative", display: "flex", cursor: perms.editFlight ? (panDragActive ? "grabbing" : "grab") : "default" }}
                onDragOver={e => { if (perms.editFlight) e.preventDefault(); }}
                onDrop={e => {
                  if (!perms.editFlight) return;
                  e.preventDefault();
                  const flightId = e.dataTransfer.getData("text/flight-id");
                  if (!flightId) return;
                  // Dragging a flight that's part of the current multi-select moves the whole
                  // selection to the same aircraft, not just the one bar you happened to grab.
                  const idsToMove = (multiSelectIds.has(flightId) && multiSelectIds.size > 1) ? [...multiSelectIds] : [flightId];
                  idsToMove.forEach(id => onDropFlight(id, res.id));
                }}
                onMouseDown={e => {
                  if (!perms.editFlight) return;
                  if (e.shiftKey) { setMarquee({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY }); return; }
                  const initial = { startClientX: e.clientX, startClientY: e.clientY, panStartScrollLeft: boardRef.current ? boardRef.current.scrollLeft : 0, panStartScrollTop: boardRef.current ? boardRef.current.scrollTop : 0 };
                  panDragRef.current = initial;
                  setPanDrag(initial);
                }}
                onContextMenu={e => {
                  if (!perms.editFlight) return;
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = e.clientX - rect.left;
                  const totalDayFloat = relX / COL;
                  const dayIndex = Math.floor(totalDayFloat);
                  const hourFrac = Math.max(0, totalDayFloat - dayIndex);
                  const depMinutes = Math.round((hourFrac * 1440) / 15) * 15;
                  setContextMenu({ type: "create", resourceId: res.id, resourceCode: res.code, date: iso(addDays(viewStart, dayIndex)), depTime: minutesToHHMM(depMinutes), x: e.clientX, y: e.clientY });
                }}>
                {days.map((d, i) => {
                  const dow = d.getUTCDay();
                  const isWeekend = dow === 0 || dow === 6;
                  const isToday = iso(d) === iso(new Date());
                  const dayGrounded = resMaint.some(m => { const d0 = new Date(d); d0.setUTCHours(0, 0, 0, 0); const d1 = addDays(d0, 1); return m.start < d1 && m.end > d0; });
                  return <div key={i} title={dayGrounded ? "Maintenance / grounded" : undefined} style={{
                    width: COL, flexShrink: 0, height: rowHeight,
                    borderLeft: `1.5px solid ${C.border}`,
                    backgroundColor: isToday ? C.amberSoft : (isWeekend ? C.panel2 : "transparent"),
                    backgroundImage: dayGrounded
                      ? `repeating-linear-gradient(45deg, rgba(224,71,59,0.05), rgba(224,71,59,0.05) 6px, rgba(224,71,59,0.12) 6px, rgba(224,71,59,0.12) 12px)`
                      : `repeating-linear-gradient(to right, transparent, transparent ${(showHourTicks ? HOUR_TICK : TICK) - 1}px, ${C.borderSoft}99 ${(showHourTicks ? HOUR_TICK : TICK) - 1}px, ${C.borderSoft}99 ${showHourTicks ? HOUR_TICK : TICK}px)`,
                  }} />;
                })}
                {resFlights.map(({ f, c }) => {
                  const isFerry = f.legType === "ferry";
                  const geom = effectiveGeometry(f, isNarrow);
                  const leftPx = c * COL + geom.offsetFrac * COL + 3;
                  const widthPx = Math.max(geom.widthFrac * COL - 6, isNarrow ? COL - 6 : 34);
                  const lane = laneOf.get(f.id) || 0;
                  const barTop = TOP_PAD + lane * (BAR_H + BAR_GAP);
                  const destColor = f.color || colorForDestination(f.destination);
                  const stripeColor = f.status === "cancelled" ? C.red : destColor;
                  const pillRadius = isNarrow ? 7 : BAR_H / 2;
                  const stripeW = isNarrow ? 5 : 6;
                  const barBg = isFerry ? `repeating-linear-gradient(45deg, ${C.panel}, ${C.panel} 5px, ${C.panel2} 5px, ${C.panel2} 10px)` : stripeColor + "14";
                  const barBorderStyle = f.status === "cancelled" ? `1.5px solid ${C.red}` : (isFerry || f.status === "tentative") ? `1px dashed ${C.border}` : `1px solid ${C.border}`;
                  const pendingDraft = draftByFlightId.get(f.id);
                  const finalBorderStyle = pendingDraft ? `2px dashed ${C.amber}` : barBorderStyle;
                  const depLabel = f.depTime ? formatStationTime(f.start, f.depTime, f.origin, showLocal) : null;
                  const arrLabel = f.arrTime ? formatStationTime(f.start, f.arrTime, f.destination, showLocal) : null;
                  const isBeingTouchDragged = touchDrag?.flightId === f.id;
                  const isBeingResized = resizeDrag?.flightId === f.id;
                  const selected = f.id === selectedFlightId;
                  const multiSelected = multiSelectIds.has(f.id);
                  const dimmed = !matchesFilter(f);
                  const boxFontScale = isNarrow ? 1 : (widthPx < 55 ? 0.74 : widthPx < 80 ? 0.87 : 1);
                  return (
                    <React.Fragment key={f.id}>
                      <div className="flight-bar" draggable={perms.editFlight && draftMode}
                        data-flight-id={f.id}
                        onDragStart={e => e.dataTransfer.setData("text/flight-id", f.id)}
                        onTouchStart={e => handleFlightTouchStart(e, f)}
                        onTouchMove={handleFlightTouchMoveBeforeDrag}
                        onTouchEnd={handleFlightTouchEndBeforeDrag}
                        onMouseDown={e => e.stopPropagation()}
                        onMouseEnter={e => {
                          const x = e.clientX, y = e.clientY;
                          clearTimeout(hoverTimerRef.current);
                          hoverTimerRef.current = setTimeout(() => { setHoverFlightId(f.id); setHoverPos({ x, y }); }, 350);
                        }}
                        onMouseLeave={() => { clearTimeout(hoverTimerRef.current); setHoverFlightId(null); }}
                        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setContextMenu({ type: "flight", flightId: f.id, x: e.clientX, y: e.clientY }); }}
                        onClick={e => {
                          if (e.shiftKey) {
                            setMultiSelectIds(prev => { const next = new Set(prev); next.has(f.id) ? next.delete(f.id) : next.add(f.id); return next; });
                          } else {
                            setMultiSelectIds(new Set());
                            setSelectedFlightId(selected ? null : f.id);
                          }
                        }}
                        title={`${f.ref} · ${f.origin}→${f.destination}${f.depTime ? ` · ${f.depTime}–${f.arrTime || "?"}` : ""}${isFerry ? " · ferry/positioning" : ""}${pendingDraft ? ` · PENDING: ${pendingDraft.summary}` : ""}${perms.editFlight ? (draftMode ? " · drag to reassign aircraft · shift-click to multi-select · right-click for more" : " · turn on Draft mode to drag/reassign this flight · shift-click to multi-select · right-click for more") : ""}`}
                        style={{ position: "absolute", left: leftPx, top: barTop, width: widthPx, height: BAR_H,
                          background: multiSelected ? C.amberSoft : barBg, opacity: isBeingTouchDragged ? 0.35 : (dimmed ? 0.22 : (pendingDraft?.changeType === "delete" ? 0.45 : 1)),
                          border: multiSelected ? `1.5px solid ${C.amber}` : finalBorderStyle,
                          borderRadius: pillRadius, cursor: (perms.editFlight && draftMode) ? "grab" : "pointer", overflow: "hidden", touchAction: (perms.editFlight && draftMode) ? "pan-y" : "auto" }}>
                        {pendingDraft && (
                          <div style={{ position: "absolute", top: -6, right: -4, width: 14, height: 14, borderRadius: 999, background: C.amber, color: ON_ACCENT, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 5 }}>!</div>
                        )}
                        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: stripeW, background: stripeColor, borderRadius: `${pillRadius}px 0 0 ${pillRadius}px` }} />
                        <div style={{ position: "absolute", left: stripeW, right: 0, top: 0, bottom: 0, display: "flex", flexDirection: "column", justifyContent: "center", padding: isNarrow ? "0 6px" : (widthPx < 55 ? "0 5px 0 7px" : "0 10px 0 12px") }}>
                          {isNarrow ? (
                            <>
                              <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.text, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.ref}{isFerry ? " · F" : ""}</div>
                              <div style={{ fontFamily: MONO, fontSize: 8, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.origin} {depLabel || "—"}</div>
                              <div style={{ fontFamily: MONO, fontSize: 8, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.destination} {arrLabel || "—"}</div>
                            </>
                          ) : (
                            <div style={{ display: "flex", alignItems: "center", height: "100%", gap: Math.round(5 * boxFontScale), overflow: "hidden" }}>
                              <span style={{ fontFamily: MONO, fontSize: 10.5 * boxFontScale, color: C.text, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>{f.ref}</span>
                              <span style={{ fontFamily: MONO, fontSize: 9 * boxFontScale, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {f.origin} {depLabel || "--"}-{arrLabel || "--"} {f.destination}{isFerry ? " · FERRY" : ""}
                              </span>
                            </div>
                          )}
                        </div>
                        {perms.editFlight && !isNarrow && (
                          <>
                            <div onMouseDown={e => { e.stopPropagation(); setResizeDrag({ flightId: f.id, edge: "left", startClientX: e.clientX, origDep: timeToMinutes(f.depTime) ?? 0, origArr: timeToMinutes(f.arrTime) ?? 90, deltaMin: 0 }); }}
                              style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }} />
                            <div onMouseDown={e => { e.stopPropagation(); setResizeDrag({ flightId: f.id, edge: "right", startClientX: e.clientX, origDep: timeToMinutes(f.depTime) ?? 0, origArr: timeToMinutes(f.arrTime) ?? 90, deltaMin: 0 }); }}
                              style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 7, cursor: "ew-resize" }} />
                          </>
                        )}
                      </div>
                      {isBeingResized && (
                        <div style={{ position: "absolute", left: leftPx + widthPx / 2, top: barTop - 22, transform: "translateX(-50%)", background: C.text, color: "#fff", fontSize: 10.5, fontFamily: MONO, padding: "2px 6px", borderRadius: 5, whiteSpace: "nowrap", pointerEvents: "none", zIndex: 30 }}>
                          {resizeDrag.edge === "left" ? "dep " : "arr "}
                          {minutesToHHMM((((resizeDrag.edge === "left" ? resizeDrag.origDep : resizeDrag.origArr) + (resizeDrag.deltaMin || 0)) % 1440 + 1440) % 1440)}
                        </div>
                      )}
                      {(selected || multiSelected) && !isNarrow && (
                        <>
                          <div style={{ position: "absolute", left: leftPx - 3, top: barTop - 3, width: 9, height: 9, borderTop: `2px solid ${C.amber}`, borderLeft: `2px solid ${C.amber}`, pointerEvents: "none" }} />
                          <div style={{ position: "absolute", left: leftPx + widthPx - 6, top: barTop - 3, width: 9, height: 9, borderTop: `2px solid ${C.amber}`, borderRight: `2px solid ${C.amber}`, pointerEvents: "none" }} />
                          <div style={{ position: "absolute", left: leftPx - 3, top: barTop + BAR_H - 6, width: 9, height: 9, borderBottom: `2px solid ${C.amber}`, borderLeft: `2px solid ${C.amber}`, pointerEvents: "none" }} />
                          <div style={{ position: "absolute", left: leftPx + widthPx - 6, top: barTop + BAR_H - 6, width: 9, height: 9, borderBottom: `2px solid ${C.amber}`, borderRight: `2px solid ${C.amber}`, pointerEvents: "none" }} />
                        </>
                      )}
                    </React.Fragment>
                  );
                })}
                {pendingCreates.filter(d => d.patch.resourceId === res.id).map(d => {
                  const startDate = new Date(d.patch.start);
                  const c = colFor(startDate);
                  if (c < 0 || c >= days.length) return null;
                  const geom = flightGeometry({ depTime: d.patch.depTime, arrTime: d.patch.arrTime });
                  const leftPx = c * COL + geom.offsetFrac * COL + 3;
                  const widthPx = Math.max(geom.widthFrac * COL - 6, isNarrow ? COL - 6 : 34);
                  return (
                    <div key={d.id} title={`Pending: ${d.summary}`} style={{
                      position: "absolute", left: leftPx, top: TOP_PAD, width: widthPx, height: BAR_H,
                      border: `2px dashed ${C.amber}`, background: C.amberSoft, borderRadius: isNarrow ? 7 : BAR_H / 2,
                      display: "flex", alignItems: "center", padding: "0 8px", fontSize: 10.5, fontFamily: MONO, color: C.amber, fontWeight: 600, overflow: "hidden", whiteSpace: "nowrap",
                    }}>
                      + {d.patch.ref || "new"}
                    </div>
                  );
                })}
              </div>
            </div>
            </React.Fragment>
                  );
                })}
              </>
            );
          })()}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 11, color: C.muted, flexWrap: "wrap", alignItems: "center" }}>
        <LegendSwatch color={C.green} label="Healthy fill" />
        <LegendSwatch color={C.amber} label="Near full (≥92%)" />
        <LegendSwatch color={C.red} label="Oversold" />
        <button onClick={() => setShowDestLegend(v => !v)} style={{ ...miniBtn, padding: "3px 10px", fontSize: 11 }}>{showDestLegend ? "Hide" : "Show"} destination colors</button>
      </div>
      {showDestLegend && (
        <div style={{ display: "flex", gap: 12, marginTop: 8, flexWrap: "wrap", fontSize: 11, color: C.muted }}>
          {[...new Set(flights.map(f => f.destination))].sort().map(d => <LegendSwatch key={d} color={colorForDestination(d)} label={d} />)}
        </div>
      )}

      {marquee && (
        <div style={{ position: "fixed", left: Math.min(marquee.startX, marquee.curX), top: Math.min(marquee.startY, marquee.curY), width: Math.abs(marquee.curX - marquee.startX), height: Math.abs(marquee.curY - marquee.startY), background: C.amberSoft + "99", border: `1.5px dashed ${C.amber}`, zIndex: 998, pointerEvents: "none" }} />
      )}
      {touchDrag && (
        <div style={{ position: "fixed", left: touchDrag.x + 14, top: touchDrag.y - 16, background: C.amber, color: ON_ACCENT, padding: "5px 10px", borderRadius: 8, fontSize: 11.5, fontFamily: MONO, fontWeight: 600, pointerEvents: "none", zIndex: 999, boxShadow: "0 6px 18px rgba(0,0,0,0.3)" }}>
          Moving {touchDrag.ref} — release over a day to drop
        </div>
      )}
      {hoverFlightId && (() => {
        const f = flights.find(x => x.id === hoverFlightId);
        const inv = f ? flightInventory(f.id) : null;
        if (!f || !inv) return null;
        return (
          <div style={{ position: "fixed", left: Math.min(hoverPos.x + 14, window.innerWidth - 260), top: hoverPos.y + 18, width: 240, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.2)", zIndex: 999, padding: 10, pointerEvents: "none", fontFamily: SANS }}>
            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 12.5, marginBottom: 2 }}>{f.ref} · {f.origin}→{f.destination}</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>{inv.allocated}/{inv.capacity} seats sold{inv.oversoldBy > 0 ? ` · oversold by ${inv.oversoldBy}` : ""}</div>
            {inv.live.length === 0 ? (
              <div style={{ fontSize: 11.5, color: C.faint }}>No tour operator allotments on this flight yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {inv.live.map(a => {
                  const op = operators.find(o => o.id === a.operatorId);
                  return (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5 }}>
                      <span style={{ color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 110 }}>{op?.name || "Unknown operator"}</span>
                      <span style={{ fontFamily: MONO, color: C.muted }}>{a.seatsAllocated} × ${a.pricePerSeat}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}
      {contextMenu && contextMenu.type === "create" && (
        <div onClick={e => e.stopPropagation()} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.2)", zIndex: 300, minWidth: 200, padding: 6, fontSize: 12.5 }}>
          <div style={{ padding: "4px 8px 6px", fontFamily: MONO, fontSize: 11, color: C.muted, borderBottom: `1px solid ${C.borderSoft}`, marginBottom: 4 }}>{contextMenu.resourceCode} · {contextMenu.date} · {contextMenu.depTime}</div>
          <button onClick={() => {
            onQuickCreate({ resourceId: contextMenu.resourceId, date: contextMenu.date, depTime: contextMenu.depTime, arrTime: minutesToHHMM((timeToMinutes(contextMenu.depTime) + 120) % 1440) });
            setContextMenu(null);
          }} style={ctxMenuItem}>+ New flight here</button>
        </div>
      )}
      {contextMenu && contextMenu.type === "flight" && (() => {
        const f = flights.find(x => x.id === contextMenu.flightId);
        if (!f) return null;
        return (
          <div onClick={e => e.stopPropagation()} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.2)", zIndex: 300, minWidth: 190, padding: 6, fontSize: 12.5 }}>
            <div style={{ padding: "4px 8px 6px", fontFamily: MONO, fontWeight: 700, color: C.text, borderBottom: `1px solid ${C.borderSoft}`, marginBottom: 4 }}>{f.ref}</div>
            {perms.editFlight && <>
              <button onClick={() => { onDuplicateFlight(f.id); setContextMenu(null); }} style={ctxMenuItem}>Duplicate → next day</button>
              <button onClick={() => { window.confirm(`Delete ${f.ref}? This can't be undone.`) && onDeleteFlight(f.id); setContextMenu(null); }} style={{ ...ctxMenuItem, color: C.red }}>Delete</button>
              <div style={{ padding: "6px 8px 2px", fontSize: 10, color: C.faint, fontWeight: 600 }}>Color</div>
              <div style={{ display: "flex", gap: 5, padding: "2px 8px 6px", flexWrap: "wrap" }}>
                {FLIGHT_COLORS.slice(0, 9).map(c => (
                  <button key={c} onClick={() => { onSetFlightColor(f.id, c); setContextMenu(null); }} title={c} style={{ width: 16, height: 16, borderRadius: 4, background: c, border: f.color === c ? `2px solid ${C.text}` : "1px solid rgba(0,0,0,0.1)", cursor: "pointer", padding: 0 }} />
                ))}
                <button onClick={() => { onSetFlightColor(f.id, null); setContextMenu(null); }} title="Reset to destination color" style={{ width: 16, height: 16, borderRadius: 4, background: C.panel, border: `1px solid ${C.border}`, cursor: "pointer", padding: 0, fontSize: 9, color: C.faint, lineHeight: 1 }}>×</button>
              </div>
            </>}
            {!perms.editFlight && <div style={{ padding: "6px 8px", color: C.faint }}>Read-only for your role</div>}
          </div>
        );
      })()}
      {multiSelectIds.size > 0 && (
        <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: C.text, color: "#fff", padding: "8px 8px 8px 16px", borderRadius: 999, display: "flex", alignItems: "center", gap: 10, boxShadow: "0 10px 30px rgba(0,0,0,0.25)", zIndex: 97, fontSize: 12.5 }}>
          <span>{multiSelectIds.size} flight{multiSelectIds.size === 1 ? "" : "s"} selected</span>
          {perms.editFlight && (
            <button onClick={() => {
              if (window.confirm(`Delete ${multiSelectIds.size} selected flight(s)? This can't be undone.`)) {
                multiSelectIds.forEach(id => onDeleteFlight(id));
                setMultiSelectIds(new Set());
              }
            }} style={{ ...miniBtn, background: C.red, color: "#fff", borderColor: C.red, padding: "5px 12px" }}>Delete</button>
          )}
          <button onClick={() => setMultiSelectIds(new Set())} style={{ background: "none", border: "none", color: "#fff", opacity: 0.7, cursor: "pointer", padding: "5px 6px" }}>Clear</button>
        </div>
      )}
      {showIssues && (
        <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 380, maxWidth: "92vw", background: C.panel, borderLeft: `1px solid ${C.border}`, boxShadow: "-12px 0 32px rgba(30,42,61,0.14)", zIndex: 200, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Issues</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Turnaround, routing, capacity, double-booking — advisory only, nothing here is blocked.</div>
            </div>
            <button onClick={() => setShowIssues(false)} style={{ background: "none", border: "none", fontSize: 18, color: C.faint, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
          </div>
          <div style={{ display: "flex", borderBottom: `1px solid ${C.borderSoft}`, padding: "8px 12px 0" }}>
            {[["active", `Active (${activeIssues.length})`], ["acknowledged", `Acknowledged (${acknowledgedIssuesList.length})`]].map(([k, l]) => (
              <button key={k} onClick={() => setIssuesTab(k)} style={{ background: "none", border: "none", borderBottom: issuesTab === k ? `2px solid ${C.amber}` : "2px solid transparent", color: issuesTab === k ? C.text : C.muted, fontWeight: issuesTab === k ? 600 : 500, fontSize: 12.5, padding: "6px 10px", cursor: "pointer", fontFamily: SANS }}>{l}</button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            {issuesTab === "active" && activeIssues.length === 0 && (
              <div style={{ padding: "32px 16px", textAlign: "center", color: C.faint, fontSize: 12.5 }}>Nothing outstanding — every issue is either resolved or acknowledged.</div>
            )}
            {issuesTab === "active" && activeIssues.map(issue => (
              <div key={issue.id} style={{ background: issue.flightId === selectedFlightId ? C.amberSoft : C.panel2, border: `1px solid ${issue.severity === "error" ? C.red : C.amber}33`, borderLeft: `3px solid ${issue.severity === "error" ? C.red : C.amber}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontFamily: SANS }}>
                <button onClick={() => {
                  setSelectedFlightId(issue.flightId);
                  setMultiSelectIds(new Set());
                  // Using the flight bar's own DOM element (already rendered if its day is in
                  // the currently loaded range) covers both axes at once — no manual day/lane
                  // math that could drift out of sync with the actual layout.
                  requestAnimationFrame(() => {
                    document.querySelector(`[data-flight-id="${issue.flightId}"]`)?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
                  });
                }} style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: 0, cursor: "pointer" }}>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: issue.severity === "error" ? C.red : C.amber, marginBottom: 3 }}>{issue.kind}</div>
                  <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4 }}>{issue.message}</div>
                </button>
                {perms.editFlight && (
                  <button onClick={() => onAcknowledgeIssue(issue.id)} style={{ ...miniBtn, marginTop: 6, padding: "3px 9px", fontSize: 11 }}>Acknowledge</button>
                )}
              </div>
            ))}
            {issuesTab === "acknowledged" && acknowledgedIssuesList.length === 0 && (
              <div style={{ padding: "32px 16px", textAlign: "center", color: C.faint, fontSize: 12.5 }}>No acknowledged issues.</div>
            )}
            {issuesTab === "acknowledged" && acknowledgedIssuesList.map(issue => (
              <div key={issue.id} style={{ background: C.panel2, border: `1px solid ${C.borderSoft}`, borderLeft: `3px solid ${C.faint}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontFamily: SANS, opacity: 0.75 }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: C.faint, marginBottom: 3 }}>{issue.kind}</div>
                <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4 }}>{issue.message}</div>
                {perms.editFlight && (
                  <button onClick={() => onUnacknowledgeIssue(issue.id)} style={{ ...miniBtn, marginTop: 6, padding: "3px 9px", fontSize: 11, color: C.red, borderColor: C.red }}>Delete</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showDraftPanel && (
        <div style={{ position: "fixed", top: 0, left: 0, bottom: 0, width: 380, maxWidth: "92vw", background: C.panel, borderRight: `1px solid ${C.border}`, boxShadow: "12px 0 32px rgba(30,42,61,0.14)", zIndex: 200, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.borderSoft}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Draft changes</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Queued while Draft mode is on — nothing here is live until you approve it.</div>
            </div>
            <button onClick={() => setShowDraftPanel(false)} style={{ background: "none", border: "none", fontSize: 18, color: C.faint, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>
          </div>
          {draftChanges.length > 0 && perms.editFlight && (
            <div style={{ display: "flex", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${C.borderSoft}` }}>
              <button onClick={onApproveAllDrafts} style={{ ...miniBtn, background: C.green, color: "#fff", borderColor: C.green, flex: 1 }}>Approve all ({draftChanges.length})</button>
              <button onClick={() => { if (window.confirm(`Discard all ${draftChanges.length} pending draft changes? This can't be undone.`)) onDiscardAllDrafts(); }} style={{ ...miniBtn, color: C.red, borderColor: C.red, flex: 1 }}>Discard all</button>
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
            {draftChanges.length === 0 && (
              <div style={{ padding: "32px 16px", textAlign: "center", color: C.faint, fontSize: 12.5 }}>No pending draft changes.</div>
            )}
            {draftChanges.map(d => (
              <div key={d.id} style={{ background: C.amberSoft, border: `1px solid ${C.amber}55`, borderLeft: `3px solid ${C.amber}`, borderRadius: 8, padding: "8px 10px", marginBottom: 6, fontFamily: SANS }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.3, color: C.amber, marginBottom: 3 }}>{d.changeType}</div>
                <div style={{ fontSize: 12, color: C.text, lineHeight: 1.4, marginBottom: 6 }}>{d.summary}</div>
                {perms.editFlight && (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => onApproveDraft(d.id)} style={{ ...miniBtn, background: C.green, color: "#fff", borderColor: C.green, padding: "3px 9px", fontSize: 11 }}>Approve</button>
                    <button onClick={() => onDiscardDraft(d.id)} style={{ ...miniBtn, color: C.red, borderColor: C.red, padding: "3px 9px", fontSize: 11 }}>Discard</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <style>{`.flight-bar:hover { box-shadow: 0 3px 10px rgba(30,42,61,0.16); transform: translateY(-1px); }`}</style>
    </div>
  );
}
const ctxMenuItem = { display: "block", width: "100%", textAlign: "left", background: "none", border: "none", padding: "7px 8px", borderRadius: 6, cursor: "pointer", fontSize: 12.5, color: C.text };
function LegendSwatch({ color, label }) {
  return <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 16, height: 6, background: color, borderRadius: 2 }} />{label}</span>;
}

// ---------- flight drawer ----------
function FlightDrawer({ flight, resources, operators, allotments, inventory, perms, onUpdateFlight, onAddAllotment, onPatchAllotment, onRemoveAllotment, onOpenSCR, onDeleteFlight, onClose }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [addingOp, setAddingOp] = useState(operators[0].id);
  const [addingSeats, setAddingSeats] = useState(20);
  const [addingPrice, setAddingPrice] = useState(rateFor(operators[0], flight.destination));
  const [draftDep, setDraftDep] = useState(flight.depTime || "");
  const [draftArr, setDraftArr] = useState(flight.arrTime || "");
  const activeAllotments = allotments.filter(a => a.status !== "cancelled");
  const timeDirty = draftDep !== (flight.depTime || "") || draftArr !== (flight.arrTime || "");

  return (
    <div style={{ width: 380, flexShrink: 0, borderLeft: `1px solid ${C.borderSoft}`, boxShadow: "-8px 0 24px rgba(58,54,47,0.05)", background: C.panel, overflow: "auto", padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div style={{ fontFamily: MONO, fontSize: 14, color: C.amber }}>{flight.ref}</div>
        <button onClick={onClose} style={{ ...miniBtn, padding: "3px 8px" }}>✕</button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
        <FieldRow label="Route">
          <span style={{ fontFamily: MONO, fontSize: 13 }}>{flight.origin} → {flight.destination}</span>
        </FieldRow>
        <FieldRow label="Date">
          {perms.editFlight
            ? <input type="date" value={iso(flight.start)} onChange={e => onUpdateFlight({ start: new Date(e.target.value) })} style={inputStyle} />
            : <span style={{ fontFamily: MONO, fontSize: 13 }}>{iso(flight.start)}</span>}
        </FieldRow>
        <FieldRow label="Departs / arrives (UTC)">
          {perms.editFlight
            ? <div style={{ display: "flex", gap: 4 }}>
                <input type="time" value={draftDep} onChange={e => setDraftDep(e.target.value)} style={{ ...inputStyle, width: 78 }} />
                <input type="time" value={draftArr} onChange={e => setDraftArr(e.target.value)} style={{ ...inputStyle, width: 78 }} />
              </div>
            : <span style={{ fontFamily: MONO, fontSize: 13 }}>{flight.depTime || "—"}–{flight.arrTime || "—"}</span>}
        </FieldRow>
        {perms.editFlight && timeDirty && (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => { setDraftDep(flight.depTime || ""); setDraftArr(flight.arrTime || ""); }} style={{ ...miniBtn, fontSize: 10.5 }}>Revert</button>
            <button onClick={() => onUpdateFlight({ depTime: draftDep, arrTime: draftArr })} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600, fontSize: 10.5 }}>Confirm time change</button>
          </div>
        )}
        {(flight.depTime || flight.arrTime) && (
          <div style={{ fontSize: 11, color: C.muted, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "6px 8px" }}>
            Local: {flight.origin} {formatStationTime(flight.start, flight.depTime, flight.origin, true)} → {flight.destination} {formatStationTime(flight.start, flight.arrTime, flight.destination, true)}
          </div>
        )}
        <FieldRow label="Aircraft">
          {perms.editFlight
            ? <select value={flight.resourceId} onChange={e => onUpdateFlight({ resourceId: e.target.value })} style={inputStyle}>
                {resources.map(r => <option key={r.id} value={r.id}>{r.code} · {r.capacity} seats</option>)}
              </select>
            : <span style={{ fontFamily: MONO, fontSize: 13 }}>{resources.find(r => r.id === flight.resourceId)?.code}</span>}
        </FieldRow>
        <FieldRow label="Capacity">
          {perms.editFlight
            ? <input type="number" value={flight.capacity} onChange={e => onUpdateFlight({ capacity: +e.target.value })} style={inputStyle} />
            : <span style={{ fontFamily: MONO, fontSize: 13 }}>{flight.capacity}</span>}
        </FieldRow>
        <FieldRow label="Box color">
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {FLIGHT_COLORS.map(c => (
              <button key={c} onClick={() => onUpdateFlight({ color: c })} title={c}
                style={{ width: 18, height: 18, borderRadius: "50%", background: c, border: flight.color === c ? `2px solid ${C.text}` : `1px solid ${C.border}`, cursor: "pointer", padding: 0 }} />
            ))}
            <button onClick={() => onUpdateFlight({ color: null })} title="Use status color"
              style={{ width: 18, height: 18, borderRadius: "50%", background: C.panel, border: !flight.color ? `2px solid ${C.text}` : `1px solid ${C.border}`, cursor: "pointer", padding: 0, fontSize: 9, color: C.faint }}>✕</button>
          </div>
        </FieldRow>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginBottom: 6 }}>Slot requests</div>
        <div style={{ fontSize: 10.5, color: C.muted, marginBottom: 8 }}>Pre-filled SCR drafts for this flight — review and generate, nothing is sent from here.</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => onOpenSCR("origin")} style={{ ...miniBtn, flex: 1, fontSize: 11 }}>Departure @ {flight.origin}</button>
          <button onClick={() => onOpenSCR("destination")} style={{ ...miniBtn, flex: 1, fontSize: 11 }}>Arrival @ {flight.destination}</button>
        </div>
      </div>

      {perms.editFlight && (
        <div style={{ marginBottom: 14, borderTop: `1px solid ${C.borderSoft}`, paddingTop: 12 }}>
          {!confirmDelete ? (
            <button onClick={() => setConfirmDelete(true)} style={{ ...miniBtn, width: "100%", color: C.red, borderColor: C.red }}>Delete this flight</button>
          ) : (
            <div>
              <div style={{ fontSize: 11.5, color: C.red, marginBottom: 8 }}>
                {allotments.filter(a => a.status !== "cancelled" && a.status !== "released").length > 0
                  ? `This flight has ${allotments.filter(a => a.status !== "cancelled" && a.status !== "released").length} active allotment(s) — deleting it removes those too. This can't be undone.`
                  : "This can't be undone."}
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button onClick={() => setConfirmDelete(false)} style={{ ...miniBtn, flex: 1 }}>Cancel</button>
                <button onClick={() => onDeleteFlight(flight.id)} style={{ ...miniBtn, flex: 1, background: C.red, color: ON_ACCENT, borderColor: C.red, fontWeight: 600 }}>Confirm delete</button>
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
        <MiniStat label="Capacity" value={inventory.capacity} />
        <MiniStat label="Allocated" value={inventory.allocated} color={inventory.oversoldBy > 0 ? C.red : C.text} />
        <MiniStat label="Unsold" value={inventory.unsold} color={C.green} />
      </div>
      {inventory.oversoldBy > 0 && (
        <div style={{ background: C.redSoft, border: `1px solid ${C.red}55`, color: C.red, fontSize: 12, padding: "8px 10px", borderRadius: 10, marginBottom: 12 }}>
          Oversold by {inventory.oversoldBy} seats — reduce an allotment below or increase capacity.
        </div>
      )}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>Est. revenue on this flight: <span style={{ color: C.text, fontFamily: MONO }}>${inventory.revenue.toLocaleString()}</span></div>

      <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginBottom: 8 }}>Allotments</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
        {activeAllotments.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No seats allocated yet.</div>}
        {activeAllotments.map(a => {
          const op = operators.find(o => o.id === a.operatorId);
          const released = a.status === "released";
          return (
            <div key={a.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 8, opacity: released ? 0.55 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12.5, color: C.text }}>{op?.name}</span>
                <Badge color={released ? C.faint : a.allotmentType === "option" ? C.amber : C.cyan}>{released ? "RELEASED" : a.allotmentType.toUpperCase()}</Badge>
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 5, fontSize: 11.5, color: C.muted, alignItems: "center" }}>
                {perms.editAllotments && !released ? (
                  <>
                    <input type="number" value={a.seatsAllocated} onChange={e => onPatchAllotment(a.id, { seatsAllocated: +e.target.value })} style={{ ...inputStyle, width: 56, padding: "3px 6px" }} />
                    seats @ $
                    <input type="number" value={a.pricePerSeat} onChange={e => onPatchAllotment(a.id, { pricePerSeat: +e.target.value })} style={{ ...inputStyle, width: 56, padding: "3px 6px" }} />
                  </>
                ) : <span style={{ fontFamily: MONO }}>{a.seatsAllocated} seats @ ${a.pricePerSeat}</span>}
              </div>
              {a.allotmentType === "option" && a.optionReleaseAt && !released && (
                <div style={{ fontSize: 10.5, color: C.faint, marginTop: 4 }}>Auto-releases {iso(a.optionReleaseAt)} if not confirmed</div>
              )}
              {perms.editAllotments && !released && (
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button onClick={() => onRemoveAllotment(a.id)} style={{ ...miniBtn, borderColor: C.red, color: C.red, fontSize: 10.5, padding: "3px 8px" }}>Remove</button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {perms.editAllotments && (
        <div style={{ border: `1px dashed ${C.border}`, borderRadius: 10, padding: 8 }}>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>Add allotment</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <select value={addingOp} onChange={e => { setAddingOp(e.target.value); setAddingPrice(rateFor(operators.find(o => o.id === e.target.value), flight.destination)); }} style={{ ...inputStyle, flex: 1 }}>
              {operators.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <input type="number" value={addingSeats} onChange={e => setAddingSeats(+e.target.value)} title="Seats" style={{ ...inputStyle, width: 60 }} />
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ fontSize: 11, color: C.muted, whiteSpace: "nowrap" }}>Price/seat for this flight</span>
            <span style={{ fontSize: 11, color: C.faint }}>$</span>
            <input type="number" value={addingPrice} onChange={e => setAddingPrice(+e.target.value)} title="Price per seat, this flight only" style={{ ...inputStyle, width: 70 }} />
            <button onClick={() => onAddAllotment(addingOp, addingSeats, addingPrice)} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600, marginLeft: "auto" }}>Add</button>
          </div>
          <div style={{ fontSize: 10, color: C.faint, marginTop: 4 }}>Defaults to {operators.find(o => o.id === addingOp)?.name}'s rate to {flight.destination} — override it here without changing their rate table.</div>
        </div>
      )}
      {!perms.editAllotments && <div style={{ fontSize: 11.5, color: C.faint }}>Allotment editing is limited to commercial staff, liaisons, and management.</div>}
    </div>
  );
}
function FieldRow({ label, children }) {
  return <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
    <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
    <div style={{ width: 170 }}>{children}</div>
  </div>;
}
function MiniStat({ label, value, color = C.text }) {
  return <div style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, padding: "6px 8px", textAlign: "center" }}>
    <div style={{ fontSize: 9.5, color: C.faint, fontWeight: 600 }}>{label}</div>
    <div style={{ fontFamily: MONO, fontSize: 15, color }}>{value}</div>
  </div>;
}

// ---------- single flight insertion ----------
function AddFlightModal({ resources, prefill, onClose, onCreate, checkConflict }) {
  const [form, setForm] = useState(() => {
    const r = prefill?.resourceId ? resources.find(x => x.id === prefill.resourceId) : resources[0];
    return {
      ref: "", origin: prefill?.origin || "LGW", destination: prefill?.destination || "PMI",
      resourceId: r?.id || resources[0].id, date: prefill?.date || iso(addDays(today, 7)),
      depTime: prefill?.depTime || "08:00", arrTime: prefill?.arrTime || "11:00", capacity: r?.capacity || resources[0].capacity,
    };
  });
  const [scrLeg, setScrLeg] = useState("destination"); // which airport the slot request is for
  const [creatorRef, setCreatorRef] = useState("");
  const [step, setStep] = useState("form"); // "form" | "scr"
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);
  const conflict = checkConflict(form.resourceId, new Date(form.date), null);

  // Builds the SCR straight from what's typed above — no need for this flight to exist on the
  // schedule yet. The "draft" flight object only exists inside this function call.
  function generateSCR() {
    const draftFlight = { id: "draft", ref: form.ref.trim() || "DV----", origin: form.origin, destination: form.destination, start: new Date(form.date), depTime: form.depTime, arrTime: form.arrTime };
    const clearanceAirport = scrLeg === "destination" ? form.destination : form.origin;
    const code = airlineCodeFromRef(draftFlight.ref);
    const line = newSCRLine({
      arrFlightId: scrLeg === "destination" ? draftFlight.id : "",
      depFlightId: scrLeg === "origin" ? draftFlight.id : "",
      periodFrom: form.date, periodTo: form.date,
      days: [String(jsToIataDay(draftFlight.start.getUTCDay()))],
      seats: form.capacity, acType: acTypeCodeFor(resources.find(r => r.id === form.resourceId)?.variant),
      ...(code ? { [scrLeg === "destination" ? "arrDesignator" : "depDesignator"]: code } : {}),
    });
    const header = { creatorRef, season: iataSeasonFor(draftFlight.start), messageDate: iso(today), clearanceAirport, si: "", gi: "BRGDS" };
    setOutput(buildSCRMessage(header, [line], [draftFlight]));
    setCopied(false);
    setStep("scr");
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 420, maxWidth: "92vw" }}>
        {step === "form" && (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>New flight</div>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 12 }}>Fill this in, generate the slot request first, then confirm to put it on the schedule.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Flight number"><input value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value.toUpperCase() })} placeholder="auto (DV####)" style={inputStyle} /></FieldSm>
                <FieldSm label="Aircraft">
                  <select value={form.resourceId} onChange={e => { const r = resources.find(x => x.id === e.target.value); setForm({ ...form, resourceId: e.target.value, capacity: r.capacity }); }} style={inputStyle}>
                    {resources.map(r => <option key={r.id} value={r.id}>{r.code} · {r.capacity} seats</option>)}
                  </select>
                </FieldSm>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Origin"><input value={form.origin} onChange={e => setForm({ ...form, origin: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
                <FieldSm label="Destination"><input value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Departure (UTC)"><input type="time" value={form.depTime} onChange={e => setForm({ ...form, depTime: e.target.value })} style={inputStyle} /></FieldSm>
                <FieldSm label="Arrival (UTC)"><input type="time" value={form.arrTime} onChange={e => setForm({ ...form, arrTime: e.target.value })} style={inputStyle} /></FieldSm>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Date"><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inputStyle} /></FieldSm>
                <FieldSm label="Capacity"><input type="number" value={form.capacity} onChange={e => setForm({ ...form, capacity: +e.target.value })} style={inputStyle} /></FieldSm>
              </div>
              <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginTop: 4 }}>Slot request</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Request for">
                  <select value={scrLeg} onChange={e => setScrLeg(e.target.value)} style={inputStyle}>
                    <option value="destination">Arrival @ {form.destination || "destination"}</option>
                    <option value="origin">Departure @ {form.origin || "origin"}</option>
                  </select>
                </FieldSm>
                <FieldSm label="Your reference (optional)"><input value={creatorRef} onChange={e => setCreatorRef(e.target.value)} placeholder="ops@yourairline.com" style={inputStyle} /></FieldSm>
              </div>
            </div>
            {conflict && (
              <div style={{ background: C.redSoft, border: `1px solid ${C.red}55`, color: C.red, fontSize: 12, padding: "8px 10px", borderRadius: 10, marginTop: 12 }}>
                Heads up: {resources.find(r => r.id === form.resourceId)?.code} already flies {conflict.ref} on {form.date}. You can still add this one — just flagging it.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={generateSCR} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Generate SCR</button>
            </div>
          </>
        )}

        {step === "scr" && (
          <>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Slot request — {form.ref || "new flight"}</div>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>Copy this and send it to the coordinator. Nothing is added to the schedule until you confirm below.</div>
            <textarea readOnly value={output} rows={8} style={{ ...inputStyle, fontFamily: MONO, fontSize: 12.5, resize: "vertical", whiteSpace: "pre" }} />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
              <button onClick={() => setStep("form")} style={miniBtn}>Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { try { navigator.clipboard.writeText(output); } catch (e) {} setCopied(true); }} style={{ ...miniBtn, background: copied ? C.greenSoft : GRADIENT_PRIMARY, boxShadow: copied ? "none" : GLOW_PRIMARY, color: copied ? C.green : ON_ACCENT, borderColor: copied ? C.green : C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
                <button onClick={() => onCreate({ ...form, start: new Date(form.date), ref: form.ref.trim() || undefined })} disabled={!copied}
                  title={!copied ? "Copy the message above first" : undefined}
                  style={{ ...miniBtn, background: copied ? C.green : C.faint, color: ON_ACCENT, borderColor: copied ? C.green : C.faint, fontWeight: 600 }}>Confirm — add to schedule</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
function FieldSm({ label, children }) {
  return <div style={{ flex: 1, minWidth: 140, display: "flex", flexDirection: "column", gap: 4 }}>
    <label style={{ fontSize: 10.5, color: C.muted, fontWeight: 600 }}>{label}</label>
    {children}
  </div>;
}

// ---------- bulk import (matched to the roster-grid format) ----------
const SAMPLE_PASTE = `date,flight_no,origin,destination,dep_time,arr_time,resource,leg_type
2027-06-05,5335,CXR,ALA,0800,1530,G-CHTR,revenue
2027-06-12,5335,CXR,ALA,0800,1530,G-CHTR,revenue
2027-06-19,5335,CXR,ALA,0800,1530,G-CHTR,revenue
2027-06-26,5335,CXR,ALA,0800,1530,G-CHTR,revenue
2027-06-04,5340,ALA,DAD,2130,0430,G-CHTR,ferry
2027-06-01,5386,NQZ,FAE,1000,1700,G-VOYG,revenue`;

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- Excel roster-grid importer ----------
// Built against a real roster file, not a guessed format. Verified against the actual
// workbook: every tail sheet's first week starts Monday 2026-09-14, and — critically — that
// single anchor date, advanced 7 days per week block, reproduces every block's stated
// day-of-month with zero mismatches across all 10 sheets, even though the row-spacing between
// week blocks is NOT uniform (it's usually 12 rows but varies — 10, 11, 13 — around
// month/season boundaries). So blocks are found dynamically (by scanning for the row where the
// date-of-month number actually appears), never assumed to be evenly spaced.
const ROSTER_ANCHOR_MONDAY = new Date(Date.UTC(2026, 8, 14)); // 2026-09-14, confirmed against the file
const ROSTER_ROUTE_RE = /^([A-Za-z]{3,4})\s+(\d{3,4})\s*-\s*(\d{3,4})\s+([A-Za-z]{3,4})$/;

function mapSheetToResourceCode(sheetName, resources) {
  const m4 = sheetName.match(/\b(\d{4})\b/);
  if (m4) {
    const code = "UP-B" + m4[1];
    if (resources.some(r => r.code === code)) return code;
  }
  const m757 = sheetName.match(/757-0?(\d)\b/);
  if (m757) {
    const code = "UP-B570" + m757[1];
    if (resources.some(r => r.code === code)) return code;
  }
  return null;
}

function parseRosterWorkbook(workbook, resources, flights) {
  const parsedRows = [];
  const skippedSheets = [];
  const annotations = [];
  let rowCounter = 0;

  workbook.SheetNames.forEach(sheetName => {
    const resourceCode = mapSheetToResourceCode(sheetName, resources);
    if (!resourceCode) { skippedSheets.push(sheetName); return; }
    const resource = resources.find(r => r.code === resourceCode);
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: true, defval: null });

    const headerRowIdx = [];
    grid.forEach((row, i) => { if (typeof row[2] === "number") headerRowIdx.push(i); });

    headerRowIdx.forEach((hIdx, blockI) => {
      const monday = addDays(ROSTER_ANCHOR_MONDAY, 7 * blockI);
      const dataStart = hIdx + 2;
      const dataEnd = (blockI + 1 < headerRowIdx.length ? headerRowIdx[blockI + 1] : grid.length) - 1;
      for (let r = dataStart; r <= dataEnd && r < grid.length; r++) {
        const row = grid[r] || [];
        for (let w = 0; w < 7; w++) {
          const col = 2 + 2 * w;
          const flightCell = row[col - 1];
          const routeCell = row[col];
          if (routeCell == null || routeCell === "") continue;
          const routeStr = String(routeCell).trim();
          const match = ROSTER_ROUTE_RE.exec(routeStr);
          if (!match) {
            annotations.push({ sheet: sheetName, text: routeStr });
            continue;
          }
          const [, origin, dep, arr, destination] = match;
          const date = addDays(monday, w);
          const depTime = dep.padStart(4, "0").replace(/^(\d{2})(\d{2})$/, "$1:$2");
          const arrTime = arr.padStart(4, "0").replace(/^(\d{2})(\d{2})$/, "$1:$2");
          const flightNo = flightCell != null ? String(flightCell).replace(/\D/g, "") : "";
          rowCounter++;
          let status = "ok", detail = "";
          const dupe = flights.find(f => f.resourceId === resource.id && iso(f.start) === iso(date));
          if (dupe) { status = "conflict"; detail = `${resource.code} already flies ${dupe.ref} that day`; }
          parsedRows.push({
            row_number: rowCounter, date, flightNo, origin: origin.toUpperCase(), destination: destination.toUpperCase(),
            depTime, arrTime, resourceId: resource.id, resourceCode: resource.code, legType: "revenue",
            status, detail, include: true, dow: date.getUTCDay(), // conflicts are advisory, not blocking — only genuine parse errors would exclude a row, and none exist by this point
          });
        }
      }
    });
  });

  return { parsedRows, skippedSheets: [...new Set(skippedSheets)], annotations };
}

// Shared by both the CSV-paste path and the Excel path — same recurring-pattern grouping
// either way, so the preview/SCR/confirm UI never needs to know which source produced the rows.
function groupIntoPatternsAndRemaining(parsed) {
  const groups = {};
  parsed.forEach(r => {
    if (r.status !== "ok") return;
    const key = [r.flightNo, r.resourceId, r.origin, r.destination, r.dow, r.legType].join("|");
    (groups[key] = groups[key] || []).push(r);
  });
  const detectedPatterns = Object.values(groups).filter(g => g.length >= 3).map(g => ({
    key: g.map(r => r.row_number).join(","), rows: g, flightNo: g[0].flightNo, resourceId: g[0].resourceId,
    origin: g[0].origin, destination: g[0].destination, depTime: g[0].depTime, arrTime: g[0].arrTime,
    dow: g[0].dow, legType: g[0].legType, include: true,
  }));
  const patternedRowNumbers = new Set(detectedPatterns.flatMap(p => p.rows.map(r => r.row_number)));
  const remaining = parsed.filter(r => !patternedRowNumbers.has(r.row_number));
  return { patterns: detectedPatterns, rows: remaining };
}

function BulkImportModal({ resources, flights, onClose, onCommit }) {
  const [mode, setMode] = useState("paste"); // "paste" | "excel"
  const [raw, setRaw] = useState(SAMPLE_PASTE);
  const [rows, setRows] = useState(null);
  const [patterns, setPatterns] = useState(null);
  const [scrRole, setScrRole] = useState("destination");
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);
  const [excelMeta, setExcelMeta] = useState(null); // { fileName, skippedSheets, annotationCount }
  const [excelError, setExcelError] = useState(null);
  const [excelBusy, setExcelBusy] = useState(false);

  function resourceByCode(code) { return resources.find(r => r.code.toLowerCase() === (code || "").toLowerCase()); }

  function parse() {
    const lines = raw.trim().split("\n").filter(Boolean);
    const header = lines[0].toLowerCase().split(",").map(h => h.trim());
    const idx = (name) => header.findIndex(h => h.includes(name));
    const dateI = idx("date"), flightI = idx("flight"), origI = idx("orig"), destI = idx("dest"),
      depI = idx("dep"), arrI = idx("arr"), resI = idx("resource") >= 0 ? idx("resource") : idx("aircraft"), legI = idx("leg");

    const parsed = lines.slice(1).map((line, i) => {
      const cols = line.split(",").map(c => c.trim());
      const dateStr = cols[dateI], flightNo = cols[flightI], origin = cols[origI]?.toUpperCase(), destination = cols[destI]?.toUpperCase();
      const depTime = cols[depI], arrTime = cols[arrI], resCode = cols[resI], legType = (cols[legI] || "revenue").toLowerCase();
      const resource = resourceByCode(resCode);
      const date = dateStr ? new Date(dateStr) : null;
      let status = "ok", detail = "";
      if (!date || !origin || !destination || !resource) { status = "error"; detail = "Missing or unrecognized field" + (!resource ? ` (aircraft "${resCode}" not in fleet)` : ""); }
      else if (legType === "revenue") {
        const dupe = flights.find(f => f.resourceId === resource.id && iso(f.start) === dateStr);
        if (dupe) { status = "conflict"; detail = `${resource.code} already flies ${dupe.ref} that day`; }
      }
      return {
        row_number: i + 1, date, flightNo, origin, destination, depTime, arrTime,
        resourceId: resource?.id, resourceCode: resCode, legType, status, detail,
        include: status !== "error", dow: date ? date.getUTCDay() : null, // conflicts are advisory, not blocking — only genuinely bad data (missing/unrecognized fields) excludes a row
      };
    });

    const { patterns: detectedPatterns, rows: remaining } = groupIntoPatternsAndRemaining(parsed);
    setPatterns(detectedPatterns);
    setRows(remaining);
  }

  async function handleExcelFile(file) {
    setExcelError(null);
    setExcelBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: "array" });
      const { parsedRows, skippedSheets, annotations } = parseRosterWorkbook(workbook, resources, flights);
      if (parsedRows.length === 0) {
        setExcelError("No recognizable flight rows found. Check that this is the roster-grid workbook (one sheet per tail number) and that the sheet names include the tail's registration digits.");
        setExcelBusy(false);
        return;
      }
      const { patterns: detectedPatterns, rows: remaining } = groupIntoPatternsAndRemaining(parsedRows);
      setPatterns(detectedPatterns);
      setRows(remaining);
      setExcelMeta({ fileName: file.name, skippedSheets, annotationCount: annotations.length });
    } catch (err) {
      setExcelError(`Could not read this file: ${err.message}`);
    } finally {
      setExcelBusy(false);
    }
  }

  const statusColor = { ok: C.green, conflict: C.amber, error: C.red };
  const okRowCount = rows?.filter(r => r.status === "ok" && r.include).length ?? 0;
  const patternCount = patterns?.filter(p => p.include).length ?? 0;
  const totalFlightsFromPatterns = patterns?.filter(p => p.include).reduce((s, p) => s + p.rows.length, 0) ?? 0;

  function acceptedRows() {
    const rowsAccepted = rows.filter(r => r.include && r.status !== "error");
    const patternRowsAccepted = patterns.filter(p => p.include).flatMap(p => p.rows);
    return [...rowsAccepted, ...patternRowsAccepted];
  }

  // Ferry/positioning legs aren't commercial, so they're left out of the SCR draft — same
  // reasoning as everywhere else this app auto-drafts a slot request. They're still created
  // normally once "Confirm" is clicked, just not part of what gets requested.
  function generateSCR() {
    const accepted = acceptedRows().filter(r => r.legType !== "ferry");
    if (accepted.length === 0) { setOutput("No commercial (non-ferry) flights selected — nothing to request a slot for.\nYou can still confirm below to add whatever's selected to the schedule."); setCopied(false); return; }
    const draftFlights = accepted.map((r, i) => ({
      id: "draft" + i, resourceId: r.resourceId, origin: r.origin, destination: r.destination, start: r.date,
      ref: r.flightNo ? "DV" + r.flightNo : ("DV" + (4600 + i)), depTime: r.depTime, arrTime: r.arrTime,
    }));
    const seed = deriveSCRSeedFromFlights(draftFlights, resources, scrRole);
    const header = { creatorRef: "", season: iataSeasonFor(draftFlights[0].start), messageDate: iso(today), clearanceAirport: seed.clearanceAirport, si: "", gi: "BRGDS" };
    setOutput(buildSCRMessage(header, seed.lines, draftFlights));
    setCopied(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 720, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk import flights</div>

        {!rows && (
          <>
            <div style={{ display: "flex", gap: 2, background: C.panel2, borderRadius: 999, padding: 3, marginBottom: 14, width: "fit-content" }}>
              <button onClick={() => setMode("paste")} style={{ background: mode === "paste" ? C.panel : "transparent", color: mode === "paste" ? C.text : C.muted, border: "none", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: mode === "paste" ? 600 : 500, cursor: "pointer", fontFamily: SANS }}>Paste CSV rows</button>
              <button onClick={() => setMode("excel")} style={{ background: mode === "excel" ? C.panel : "transparent", color: mode === "excel" ? C.text : C.muted, border: "none", borderRadius: 999, padding: "6px 14px", fontSize: 12, fontWeight: mode === "excel" ? 600 : 500, cursor: "pointer", fontFamily: SANS }}>Upload Excel roster</button>
            </div>

            {mode === "paste" && (
              <>
                <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>
                  Paste rows in the same shape as the roster grid: flight number, route, times, aircraft, and leg type (revenue vs. ferry/positioning). Recurring weekly rows get grouped into a pattern automatically. Nothing is written until you commit at the end.
                </div>
                <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={9} style={{ ...inputStyle, fontFamily: MONO, fontSize: 11.5, resize: "vertical" }} />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  <button onClick={onClose} style={miniBtn}>Cancel</button>
                  <button onClick={parse} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview</button>
                </div>
              </>
            )}

            {mode === "excel" && (
              <>
                <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>
                  Upload the actual roster workbook — one sheet per tail number, flight number and route in adjacent cells under each weekday column. Sheets that don't match a tail in your fleet (summary sheets, aircraft not in the fleet list) are skipped and listed below, not silently dropped. Nothing is written until you commit at the end.
                </div>
                <div style={{ border: `1.5px dashed ${C.border}`, borderRadius: 12, padding: 24, textAlign: "center" }}>
                  <input type="file" accept=".xlsx,.xls" onChange={e => { const f = e.target.files?.[0]; if (f) handleExcelFile(f); }} style={{ fontSize: 12.5 }} />
                  {excelBusy && <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>Reading workbook…</div>}
                  {excelError && <div style={{ fontSize: 11.5, color: C.red, marginTop: 8 }}>{excelError}</div>}
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
                  <button onClick={onClose} style={miniBtn}>Cancel</button>
                </div>
              </>
            )}
          </>
        )}
        {rows && !output && (
          <>
            {excelMeta && (
              <div style={{ background: C.cyanSoft, border: `1px solid ${C.cyan}55`, borderRadius: 10, padding: 10, marginBottom: 12, fontSize: 11.5, color: C.text }}>
                Parsed <strong>{excelMeta.fileName}</strong>. {excelMeta.skippedSheets.length > 0 && <>Skipped sheets (no matching aircraft in fleet): <strong>{excelMeta.skippedSheets.join(", ")}</strong>. </>}
                {excelMeta.annotationCount > 0 && <>{excelMeta.annotationCount} non-flight annotation{excelMeta.annotationCount === 1 ? "" : "s"} (tour-operator labels, NOTAMs, etc.) found and left out — informational only, not imported.</>}
              </div>
            )}
            {patterns.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, margin: "10px 0 6px" }}>Detected recurring patterns</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                  {patterns.map((p, i) => (
                    <div key={p.key} style={{ border: `1px solid ${C.cyan}55`, background: C.cyanSoft, borderRadius: 10, padding: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                        <input type="checkbox" checked={p.include} onChange={e => setPatterns(ps => ps.map((x, xi) => xi === i ? { ...x, include: e.target.checked } : x))} />
                        <span style={{ fontFamily: MONO }}>{p.flightNo}</span>
                        <span>{p.origin}→{p.destination}</span>
                        <span style={{ color: C.muted }}>{DOW_SHORT[p.dow]}s · {p.depTime}–{p.arrTime}</span>
                        {p.legType === "ferry" && <Badge color={C.muted}>FERRY</Badge>}
                      </label>
                      <span style={{ fontSize: 11, color: C.cyan }}>{p.rows.length} occurrences → rotation template</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {rows.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginBottom: 6 }}>Individual rows</div>
                <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 12 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left" }}>
                      <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Date</th><th style={{ padding: "6px 8px" }}>Flt</th><th style={{ padding: "6px 8px" }}>Route</th><th style={{ padding: "6px 8px" }}>A/C</th><th style={{ padding: "6px 8px" }}>Leg</th><th style={{ padding: "6px 8px" }}>Status</th>
                    </tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: r.status === "error" ? 0.6 : 1 }}>
                          <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={r.include} disabled={r.status === "error"} onChange={e => setRows(rs => rs.map((x, xi) => xi === i ? { ...x, include: e.target.checked } : x))} /></td>
                          <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.date ? iso(r.date) : "—"}</td>
                          <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.flightNo}</td>
                          <td style={{ padding: "6px 8px" }}>{r.origin}→{r.destination}</td>
                          <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.resourceCode}</td>
                          <td style={{ padding: "6px 8px" }}>{r.legType === "ferry" ? <Badge color={C.muted}>FERRY</Badge> : <span style={{ color: C.muted }}>revenue</span>}</td>
                          <td style={{ padding: "6px 8px" }}><Badge color={statusColor[r.status]}>{r.status.toUpperCase()}</Badge>{r.detail && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{r.detail}</div>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{patternCount} pattern{patternCount === 1 ? "" : "s"} ({totalFlightsFromPatterns} flights) + {okRowCount} individual row{okRowCount === 1 ? "" : "s"} selected</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button onClick={() => { setRows(null); setPatterns(null); setExcelMeta(null); setExcelError(null); }} style={miniBtn}>Back</button>
                <button onClick={() => setScrRole("destination")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "destination" ? C.amber : "transparent", color: scrRole === "destination" ? ON_ACCENT : C.text, borderColor: scrRole === "destination" ? C.amber : C.border }}>Arrival</button>
                <button onClick={() => setScrRole("origin")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "origin" ? C.amber : "transparent", color: scrRole === "origin" ? ON_ACCENT : C.text, borderColor: scrRole === "origin" ? C.amber : C.border }}>Departure</button>
                <button onClick={generateSCR} disabled={okRowCount + totalFlightsFromPatterns === 0} style={{ ...miniBtn, background: (okRowCount + totalFlightsFromPatterns) ? GRADIENT_PRIMARY : C.faint, boxShadow: (okRowCount + totalFlightsFromPatterns) ? GLOW_PRIMARY : "none", color: ON_ACCENT, borderColor: (okRowCount + totalFlightsFromPatterns) ? C.amber : C.faint, fontWeight: 600 }}>Generate SCR</button>
              </div>
            </div>
          </>
        )}

        {output && (
          <>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>Copy this and send it to the coordinator. Nothing is added to the schedule until you confirm below.</div>
            <textarea readOnly value={output} rows={8} style={{ ...inputStyle, fontFamily: MONO, fontSize: 12.5, resize: "vertical", whiteSpace: "pre" }} />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
              <button onClick={() => setOutput(null)} style={miniBtn}>Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { try { navigator.clipboard.writeText(output); } catch (e) {} setCopied(true); }} style={{ ...miniBtn, background: copied ? C.greenSoft : GRADIENT_PRIMARY, boxShadow: copied ? "none" : GLOW_PRIMARY, color: copied ? C.green : ON_ACCENT, borderColor: copied ? C.green : C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
                <button onClick={() => onCommit(acceptedRows())} disabled={!copied}
                  title={!copied ? "Copy the message above first" : undefined}
                  style={{ ...miniBtn, background: copied ? C.green : C.faint, color: ON_ACCENT, borderColor: copied ? C.green : C.faint, fontWeight: 600 }}>Confirm — add {okRowCount + totalFlightsFromPatterns} flight{(okRowCount + totalFlightsFromPatterns) === 1 ? "" : "s"}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}



// ---------- scheduling engine ----------
// A real assignment algorithm, not a mock: given a set of route requirements (route,
// frequency, aircraft type, date range), it expands every requirement into individual dated
// legs, then greedily assigns each one to whichever eligible aircraft has flown the fewest
// legs so far in this run — spreading load across the fleet rather than dumping everything on
// one tail. Eligibility excludes aircraft already grounded by a maintenance block that day,
// already double-booked with a real existing flight, or already claimed by an earlier
// requirement in this same run. This is honestly a greedy heuristic, not a global optimizer —
// it processes requirements in date order and never goes back to reshuffle an earlier
// assignment to make a later one fit better.
function emptyRequirement() {
  return {
    id: Math.random().toString(36).slice(2), origin: "", destination: "", aircraftType: "any",
    dateMode: "weekly", // "weekly" | "everyN" | "specific"
    daysOfWeek: [1, 3, 5], intervalDays: 2, specificDates: [],
    depTime: "08:00", arrTime: "11:00", startDate: iso(addDays(today, 7)), endDate: iso(addDays(today, 70)), ref: "",
    hasReturn: false, returnRef: "", returnDepTime: "16:00", returnArrTime: "19:00", returnDayOffset: 0,
  };
}
// Each date this requirement matches becomes one "occurrence" — one leg if it's one-way, two
// legs (outbound + return, reversed route) if hasReturn is set. Both legs of one occurrence
// are always assigned the SAME aircraft, checked against BOTH dates before committing — a
// round trip can't fly outbound on one tail and come home on another. The return leg's date
// defaults to the same day as the outbound (a same-day turnaround) but can be offset forward
// for a rotation that doesn't return until a later day.
function runSchedulingEngine(requirements, resources, flights, isGrounded) {
  const occurrences = [];
  requirements.forEach((req, ri) => {
    if (!req.origin || !req.destination) return;
    let reqDates = [];
    if (req.dateMode === "specific") {
      reqDates = [...(req.specificDates || [])].sort().map(s => new Date(s));
    } else if (req.dateMode === "everyN") {
      const start = new Date(req.startDate), end = new Date(req.endDate);
      const step = Math.max(1, req.intervalDays || 1);
      for (let d = new Date(start); d <= end; d = addDays(d, step)) reqDates.push(new Date(d));
    } else {
      const start = new Date(req.startDate), end = new Date(req.endDate);
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        if (req.daysOfWeek.includes(d.getUTCDay())) reqDates.push(new Date(d));
      }
    }
    reqDates.forEach(d => {
      const legs = [{ date: d, origin: req.origin.toUpperCase(), destination: req.destination.toUpperCase(), depTime: req.depTime, arrTime: req.arrTime, refField: "ref" }];
      if (req.hasReturn) {
        legs.push({
          date: addDays(d, req.returnDayOffset || 0), origin: req.destination.toUpperCase(), destination: req.origin.toUpperCase(),
          depTime: req.returnDepTime, arrTime: req.returnArrTime, refField: "returnRef",
        });
      }
      occurrences.push({ reqIndex: ri, aircraftType: req.aircraftType, legs });
    });
  });
  occurrences.sort((a, b) => a.legs[0].date - b.legs[0].date);

  const loadCount = new Map(resources.map(r => [r.id, 0]));
  const assignedThisRun = new Set(); // `${resourceId}|${dateISO}`
  const refByReqField = new Map(); // one auto-generated ref per requirement+leg — same flight number every occurrence, not a new one each date

  const results = [];
  occurrences.forEach(occ => {
    const req = requirements[occ.reqIndex];
    const dateKeys = occ.legs.map(leg => iso(leg.date));
    const eligible = resources.filter(r => {
      if (occ.aircraftType !== "any" && r.variant !== occ.aircraftType) return false;
      return dateKeys.every(dateKey => {
        if (isGrounded(r.id, new Date(dateKey))) return false;
        if (assignedThisRun.has(`${r.id}|${dateKey}`)) return false;
        return !flights.some(f => f.resourceId === r.id && iso(f.start) === dateKey);
      });
    });
    let chosen = null;
    if (eligible.length > 0) {
      eligible.sort((a, b) => loadCount.get(a.id) - loadCount.get(b.id));
      chosen = eligible[0];
      loadCount.set(chosen.id, loadCount.get(chosen.id) + 1);
      dateKeys.forEach(dateKey => assignedThisRun.add(`${chosen.id}|${dateKey}`));
    }
    const anyTypeInFleet = resources.some(r => occ.aircraftType === "any" || r.variant === occ.aircraftType);
    const detail = !anyTypeInFleet ? `No ${occ.aircraftType} in the fleet` : "All matching aircraft busy or grounded on one of this rotation's dates";
    occ.legs.forEach(leg => {
      const refKey = `${occ.reqIndex}|${leg.refField}`;
      if (!refByReqField.has(refKey)) {
        const explicit = (req[leg.refField] || "").trim();
        refByReqField.set(refKey, explicit || ("DV" + (4800 + Math.floor(Math.random() * 900))));
      }
      const ref = refByReqField.get(refKey);
      results.push(chosen
        ? { date: leg.date, origin: leg.origin, destination: leg.destination, depTime: leg.depTime, arrTime: leg.arrTime, ref, status: "ok", detail: "", resourceId: chosen.id, resourceCode: chosen.code, include: true }
        : { date: leg.date, origin: leg.origin, destination: leg.destination, depTime: leg.depTime, arrTime: leg.arrTime, ref, status: "unassigned", detail, resourceId: null, resourceCode: null, include: false });
    });
  });
  return results;
}

// A small self-contained month-grid calendar for hand-picking exact, non-recurring dates —
// click a day to toggle it, navigate months with the arrows. Selected dates are the actual
// output; there's no pattern to describe, which is the point for a "one flight every 10 days
// for three months, but only on the days I actually pick" kind of schedule.
function MultiDatePicker({ selected, onChange }) {
  const [viewMonth, setViewMonth] = useState(() => { const d = new Date(today); d.setUTCDate(1); return d; });
  const selectedSet = new Set(selected);
  const year = viewMonth.getUTCFullYear(), month = viewMonth.getUTCMonth();
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  function toggle(d) {
    const dateStr = iso(new Date(Date.UTC(year, month, d)));
    const next = selectedSet.has(dateStr) ? selected.filter(x => x !== dateStr) : [...selected, dateStr];
    onChange(next);
  }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 10, width: 260 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <button onClick={() => setViewMonth(d => { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() - 1); return n; })} style={miniBtn}>◀</button>
        <div style={{ fontSize: 12.5, fontWeight: 600 }}>{viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</div>
        <button onClick={() => setViewMonth(d => { const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 1); return n; })} style={miniBtn}>▶</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3, fontSize: 10, color: C.faint, textAlign: "center", marginBottom: 3 }}>
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i}>{d}</div>)}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />;
          const dateStr = iso(new Date(Date.UTC(year, month, d)));
          const isSel = selectedSet.has(dateStr);
          return (
            <button key={i} onClick={() => toggle(d)}
              style={{ width: 30, height: 30, borderRadius: 6, border: isSel ? `1px solid ${C.amber}` : `1px solid ${C.borderSoft}`, background: isSel ? C.amber : "transparent", color: isSel ? ON_ACCENT : C.text, fontSize: 11.5, cursor: "pointer", fontFamily: MONO }}>
              {d}
            </button>
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
        <span style={{ fontSize: 11, color: C.muted }}>{selected.length} date{selected.length === 1 ? "" : "s"} picked</span>
        {selected.length > 0 && <button onClick={() => onChange([])} style={{ ...miniBtn, fontSize: 11, padding: "3px 8px" }}>Clear</button>}
      </div>
    </div>
  );
}

function RequirementRow({ req, resources, onChange, onRemove, canRemove }) {
  const variants = [...new Set(resources.map(r => r.variant).filter(Boolean))];
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <FieldSm label="Origin"><input value={req.origin} onChange={e => onChange({ origin: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
        <FieldSm label="Destination"><input value={req.destination} onChange={e => onChange({ destination: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
        <FieldSm label="Aircraft type">
          <select value={req.aircraftType} onChange={e => onChange({ aircraftType: e.target.value })} style={inputStyle}>
            <option value="any">Any available</option>
            {variants.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        </FieldSm>
        <FieldSm label="Flight number"><input value={req.ref} onChange={e => onChange({ ref: e.target.value.toUpperCase() })} placeholder="auto" style={inputStyle} /></FieldSm>
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
        <FieldSm label="Departure (UTC)"><input type="time" value={req.depTime} onChange={e => onChange({ depTime: e.target.value })} style={inputStyle} /></FieldSm>
        <FieldSm label="Arrival (UTC)"><input type="time" value={req.arrTime} onChange={e => onChange({ arrTime: e.target.value })} style={inputStyle} /></FieldSm>
      </div>

      <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, cursor: "pointer", fontSize: 12 }}>
        <input type="checkbox" checked={req.hasReturn} onChange={e => onChange({ hasReturn: e.target.checked })} />
        Round trip — add a return leg ({req.destination || "destination"} → {req.origin || "origin"})
      </label>
      {req.hasReturn && (
        <div style={{ border: `1px solid ${C.borderSoft}`, borderRadius: 10, padding: 10, marginBottom: 8, background: C.panel2 }}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <FieldSm label="Return flight number"><input value={req.returnRef} onChange={e => onChange({ returnRef: e.target.value.toUpperCase() })} placeholder="auto" style={inputStyle} /></FieldSm>
            <FieldSm label="Return departs (UTC)"><input type="time" value={req.returnDepTime} onChange={e => onChange({ returnDepTime: e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="Return arrives (UTC)"><input type="time" value={req.returnArrTime} onChange={e => onChange({ returnArrTime: e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="Days after outbound">
              <input type="number" min={0} value={req.returnDayOffset} onChange={e => onChange({ returnDayOffset: Math.max(0, +e.target.value) })} style={{ ...inputStyle, width: 70 }} />
            </FieldSm>
          </div>
          <div style={{ fontSize: 10.5, color: C.faint }}>0 = same-day turnaround at {req.destination || "the destination"}. The same aircraft flies both legs — the engine won't assign the outbound to one tail and the return to another.</div>
        </div>
      )}

      <div style={{ display: "flex", gap: 2, background: C.panel2, borderRadius: 999, padding: 3, marginBottom: 10, width: "fit-content" }}>
        {[["weekly", "Days of week"], ["everyN", "Every N days"], ["specific", "Pick dates"]].map(([k, l]) => (
          <button key={k} onClick={() => onChange({ dateMode: k })} style={{ background: req.dateMode === k ? C.panel : "transparent", color: req.dateMode === k ? C.text : C.muted, border: "none", borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: req.dateMode === k ? 600 : 500, cursor: "pointer", fontFamily: SANS, boxShadow: req.dateMode === k ? "0 1px 3px rgba(58,54,47,0.10)" : "none" }}>{l}</button>
        ))}
      </div>

      {(req.dateMode === "weekly" || req.dateMode === "everyN") && (
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 8, alignItems: "flex-end" }}>
          <FieldSm label="Start date"><input type="date" value={req.startDate} onChange={e => onChange({ startDate: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="End date"><input type="date" value={req.endDate} onChange={e => onChange({ endDate: e.target.value })} style={inputStyle} /></FieldSm>
          {req.dateMode === "everyN" && (
            <FieldSm label="Every N days">
              <input type="number" min={1} value={req.intervalDays} onChange={e => onChange({ intervalDays: Math.max(1, +e.target.value) })} style={{ ...inputStyle, width: 70 }} />
            </FieldSm>
          )}
        </div>
      )}

      {req.dateMode === "weekly" && (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {DOW.map((d, i) => (
            <button key={i} onClick={() => onChange({ daysOfWeek: req.daysOfWeek.includes(i) ? req.daysOfWeek.filter(x => x !== i) : [...req.daysOfWeek, i].sort() })}
              style={{ ...miniBtn, padding: "4px 7px", fontSize: 11, background: req.daysOfWeek.includes(i) ? C.amber : "transparent", color: req.daysOfWeek.includes(i) ? ON_ACCENT : C.text, borderColor: req.daysOfWeek.includes(i) ? C.amber : C.border }}>{d}</button>
          ))}
        </div>
      )}
      {req.dateMode === "everyN" && (
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 8 }}>
          Repeats every {req.intervalDays || 1} day{(req.intervalDays || 1) === 1 ? "" : "s"} starting {req.startDate}, through {req.endDate} — not tied to weekdays.
        </div>
      )}
      {req.dateMode === "specific" && (
        <div style={{ marginBottom: 8 }}>
          <MultiDatePicker selected={req.specificDates || []} onChange={dates => onChange({ specificDates: dates })} />
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {canRemove && <button onClick={onRemove} style={{ ...miniBtn, color: C.red, borderColor: C.red }}>Remove route</button>}
      </div>
    </div>
  );
}

function SchedulingEngineModal({ resources, flights, isGrounded, onClose, onCommit }) {
  const [requirements, setRequirements] = useState([emptyRequirement()]);
  const [results, setResults] = useState(null);
  const [scrRole, setScrRole] = useState("destination");
  const [scrSeason, setScrSeason] = useState("");
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);

  function updateReq(id, patch) { setRequirements(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r)); }
  function generate() {
    const r = runSchedulingEngine(requirements, resources, flights, isGrounded);
    setResults(r);
    // Auto-preselect the season from the actual dates generated — editable afterward in case a
    // rotation straddles a season boundary and a different message needs the other side of it.
    const firstOk = r.find(x => x.include);
    if (firstOk) setScrSeason(iataSeasonFor(firstOk.date));
  }

  const included = results?.filter(r => r.include) ?? [];
  const okCount = included.length;
  const unassignedCount = results?.filter(r => r.status === "unassigned").length ?? 0;
  const canGenerate = requirements.some(r => r.origin.trim() && r.destination.trim() && (
    r.dateMode === "specific" ? (r.specificDates || []).length > 0 : (r.dateMode === "everyN" || r.daysOfWeek.length > 0)
  ));

  function generateSCR() {
    const draftFlights = included.map((r, i) => ({ id: "draft" + i, resourceId: r.resourceId, origin: r.origin, destination: r.destination, start: r.date, ref: r.ref, depTime: r.depTime, arrTime: r.arrTime }));
    const seed = deriveSCRSeedFromFlights(draftFlights, resources, scrRole);
    const header = { creatorRef: "", season: scrSeason || iataSeasonFor(draftFlights[0].start), messageDate: iso(today), clearanceAirport: seed.clearanceAirport, si: "", gi: "BRGDS" };
    setOutput(buildSCRMessage(header, seed.lines, draftFlights));
    setCopied(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 680, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Scheduling engine</div>

        {!results && (
          <>
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 14 }}>
              Define the routes you need covered. The engine fills in aircraft automatically — avoiding double-booking and respecting maintenance downtime — and spreads the load evenly across whatever's eligible. It's a greedy fill processed in date order, not a global optimizer: it won't rearrange an earlier assignment to make a later requirement fit better.
            </div>
            {requirements.map(req => (
              <RequirementRow key={req.id} req={req} resources={resources} onChange={patch => updateReq(req.id, patch)}
                onRemove={() => setRequirements(rs => rs.filter(r => r.id !== req.id))} canRemove={requirements.length > 1} />
            ))}
            <button onClick={() => setRequirements(rs => [...rs, emptyRequirement()])} style={{ ...miniBtn, marginBottom: 14 }}>+ Add another route</button>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={generate} disabled={!canGenerate} style={{ ...miniBtn, background: canGenerate ? GRADIENT_PRIMARY : C.faint, boxShadow: canGenerate ? GLOW_PRIMARY : "none", color: ON_ACCENT, borderColor: canGenerate ? C.amber : C.faint, fontWeight: 600 }}>Generate schedule</button>
            </div>
          </>
        )}

        {results && !output && (
          <>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 12, maxHeight: 340, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left", position: "sticky", top: 0 }}>
                  <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Date</th><th style={{ padding: "6px 8px" }}>Flight</th><th style={{ padding: "6px 8px" }}>Route</th><th style={{ padding: "6px 8px" }}>Aircraft</th><th style={{ padding: "6px 8px" }}>Status</th>
                </tr></thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: r.status === "unassigned" ? 0.65 : 1 }}>
                      <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={r.include} disabled={r.status === "unassigned"} onChange={e => setResults(rs => rs.map((x, xi) => xi === i ? { ...x, include: e.target.checked } : x))} /></td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{iso(r.date)}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.ref}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO, fontSize: 11 }}>{r.origin}→{r.destination} {r.depTime}–{r.arrTime}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.resourceCode || "—"}</td>
                      <td style={{ padding: "6px 8px" }}>
                        <Badge color={r.status === "ok" ? C.green : C.red}>{r.status === "ok" ? "ASSIGNED" : "UNASSIGNED"}</Badge>
                        {r.detail && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{r.detail}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{okCount} assignable{unassignedCount > 0 ? `, ${unassignedCount} couldn't be assigned` : ""}</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button onClick={() => setResults(null)} style={miniBtn}>Back</button>
                <FieldSm label="Season">
                  <input value={scrSeason} onChange={e => setScrSeason(e.target.value.toUpperCase())} placeholder="e.g. W26" title="Auto-set from the generated dates — override if this rotation should be filed under the other season" style={{ ...inputStyle, width: 56, padding: "6px 6px", textAlign: "center" }} />
                </FieldSm>
                <button onClick={() => setScrRole("destination")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "destination" ? C.amber : "transparent", color: scrRole === "destination" ? ON_ACCENT : C.text, borderColor: scrRole === "destination" ? C.amber : C.border }}>Arrival</button>
                <button onClick={() => setScrRole("origin")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "origin" ? C.amber : "transparent", color: scrRole === "origin" ? ON_ACCENT : C.text, borderColor: scrRole === "origin" ? C.amber : C.border }}>Departure</button>
                <button onClick={generateSCR} disabled={okCount === 0} style={{ ...miniBtn, background: okCount ? GRADIENT_PRIMARY : C.faint, boxShadow: okCount ? GLOW_PRIMARY : "none", color: ON_ACCENT, borderColor: okCount ? C.amber : C.faint, fontWeight: 600 }}>Generate SCR</button>
              </div>
            </div>
          </>
        )}

        {output && (
          <>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>Copy this and send it to the coordinator. Nothing is added to the schedule until you confirm below.</div>
            <textarea readOnly value={output} rows={8} style={{ ...inputStyle, fontFamily: MONO, fontSize: 12.5, resize: "vertical", whiteSpace: "pre" }} />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
              <button onClick={() => setOutput(null)} style={miniBtn}>Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { try { navigator.clipboard.writeText(output); } catch (e) {} setCopied(true); }} style={{ ...miniBtn, background: copied ? C.greenSoft : GRADIENT_PRIMARY, boxShadow: copied ? "none" : GLOW_PRIMARY, color: copied ? C.green : ON_ACCENT, borderColor: copied ? C.green : C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
                <button onClick={() => onCommit(included)} disabled={!copied}
                  title={!copied ? "Copy the message above first" : undefined}
                  style={{ ...miniBtn, background: copied ? C.green : C.faint, color: ON_ACCENT, borderColor: copied ? C.green : C.faint, fontWeight: 600 }}>Confirm — add {okCount} flight{okCount === 1 ? "" : "s"}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}


const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- rotation-template generator ----------
function RotationGenModal({ resources, flights, onClose, onCommit }) {
  const [pattern, setPattern] = useState({
    origin: "LGW", destination: "DBV", resourceId: resources[0].id, capacity: resources[0].capacity,
    daysOfWeek: [5], startDate: iso(addDays(today, 7)), endDate: iso(addDays(today, 70)),
    outboundRef: "", outboundDep: "08:00", outboundArr: "11:00",
    includeReturn: true, returnRef: "", returnOrigin: "", returnDestination: "", returnDep: "12:00", returnArr: "15:00", returnDayOffset: 0,
  });
  const [preview, setPreview] = useState(null);
  const [scrRole, setScrRole] = useState("destination");
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);

  function toggleDay(d) {
    setPattern(p => ({ ...p, daysOfWeek: p.daysOfWeek.includes(d) ? p.daysOfWeek.filter(x => x !== d) : [...p.daysOfWeek, d].sort() }));
  }

  // Same-aircraft out-and-back on the same day is the normal shape of a rotation — the two
  // legs are expected to coexist, so each is checked against real existing flights only, never
  // against its own sibling leg (which isn't in `flights` yet, so this falls out naturally).
  function generate() {
    const start = new Date(pattern.startDate), end = new Date(pattern.endDate);
    const dates = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      if (pattern.daysOfWeek.includes(d.getUTCDay())) dates.push(new Date(d));
    }
    const outRef = pattern.outboundRef.trim() || ("DV" + (4700 + Math.floor(Math.random() * 900)));
    const retRef = pattern.returnRef.trim() || ("DV" + (4700 + Math.floor(Math.random() * 900) + 1));
    const retOrigin = pattern.returnOrigin.trim() || pattern.destination;
    const retDestination = pattern.returnDestination.trim() || pattern.origin;
    const resCode = resources.find(r => r.id === pattern.resourceId)?.code;
    const rows = [];
    dates.forEach(d => {
      const outConflict = flights.find(f => f.resourceId === pattern.resourceId && iso(f.start) === iso(d));
      const outDetail = outConflict ? `${resCode} already flies ${outConflict.ref} that day` : "";
      rows.push({ date: d, leg: "Outbound", ref: outRef, origin: pattern.origin, destination: pattern.destination, depTime: pattern.outboundDep, arrTime: pattern.outboundArr, status: outConflict ? "conflict" : "ok", detail: outDetail, include: true });
      if (pattern.includeReturn) {
        // The return leg gets its own date (outbound date + offset), its own route (not
        // assumed to be the reverse of the outbound — a rotation can be CIT-VKO-ALA, not just
        // out-and-back), and its own independent conflict check.
        const retDate = addDays(d, pattern.returnDayOffset || 0);
        const retConflict = flights.find(f => f.resourceId === pattern.resourceId && iso(f.start) === iso(retDate));
        const retDetail = retConflict ? `${resCode} already flies ${retConflict.ref} that day` : "";
        rows.push({ date: retDate, leg: "Return", ref: retRef, origin: retOrigin, destination: retDestination, depTime: pattern.returnDep, arrTime: pattern.returnArr, status: retConflict ? "conflict" : "ok", detail: retDetail, include: true });
      }
    });
    setPreview(rows);
  }

  const included = preview?.filter(r => r.include) ?? [];
  const okCount = included.length;
  const statusColor = { ok: C.green, conflict: C.amber };

  // Builds the SCR straight from the previewed rows — nothing has been written to the
  // schedule yet at this point, these are still just draft objects.
  function generateSCR() {
    const draftFlights = included.map((r, i) => ({ id: "draft" + i, resourceId: pattern.resourceId, origin: r.origin, destination: r.destination, start: r.date, ref: r.ref, depTime: r.depTime, arrTime: r.arrTime }));
    const seed = deriveSCRSeedFromFlights(draftFlights, resources, scrRole);
    const header = { creatorRef: "", season: iataSeasonFor(draftFlights[0].start), messageDate: iso(today), clearanceAirport: seed.clearanceAirport, si: "", gi: "BRGDS" };
    setOutput(buildSCRMessage(header, seed.lines, draftFlights));
    setCopied(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 560, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Generate rotation</div>

        {!preview && (
          <>
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Define the weekly pattern once — every matching date previews here before anything is written.</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Origin"><input value={pattern.origin} onChange={e => setPattern({ ...pattern, origin: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
                <FieldSm label="Destination"><input value={pattern.destination} onChange={e => setPattern({ ...pattern, destination: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
              </div>
              <FieldSm label="Aircraft">
                <select value={pattern.resourceId} onChange={e => { const r = resources.find(x => x.id === e.target.value); setPattern({ ...pattern, resourceId: e.target.value, capacity: r.capacity }); }} style={inputStyle}>
                  {resources.map(r => <option key={r.id} value={r.id}>{r.code} · {r.capacity} seats</option>)}
                </select>
              </FieldSm>
              <FieldSm label="Days of week">
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {DOW.map((d, i) => (
                    <button key={i} onClick={() => toggleDay(i)} style={{
                      ...miniBtn, padding: "5px 8px",
                      background: pattern.daysOfWeek.includes(i) ? C.amber : "transparent",
                      color: pattern.daysOfWeek.includes(i) ? ON_ACCENT : C.text,
                      borderColor: pattern.daysOfWeek.includes(i) ? C.amber : C.border,
                    }}>{d}</button>
                  ))}
                </div>
              </FieldSm>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Start date"><input type="date" value={pattern.startDate} onChange={e => setPattern({ ...pattern, startDate: e.target.value })} style={inputStyle} /></FieldSm>
                <FieldSm label="End date"><input type="date" value={pattern.endDate} onChange={e => setPattern({ ...pattern, endDate: e.target.value })} style={inputStyle} /></FieldSm>
              </div>
              <FieldSm label="Capacity"><input type="number" value={pattern.capacity} onChange={e => setPattern({ ...pattern, capacity: +e.target.value })} style={inputStyle} /></FieldSm>

              <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginTop: 4 }}>Outbound leg — {pattern.origin}→{pattern.destination}</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <FieldSm label="Flight number"><input value={pattern.outboundRef} onChange={e => setPattern({ ...pattern, outboundRef: e.target.value.toUpperCase() })} placeholder="auto" style={inputStyle} /></FieldSm>
                <FieldSm label="Departure (UTC)"><input type="time" value={pattern.outboundDep} onChange={e => setPattern({ ...pattern, outboundDep: e.target.value })} style={inputStyle} /></FieldSm>
                <FieldSm label="Arrival (UTC)"><input type="time" value={pattern.outboundArr} onChange={e => setPattern({ ...pattern, outboundArr: e.target.value })} style={inputStyle} /></FieldSm>
              </div>

              <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={pattern.includeReturn} onChange={e => setPattern({ ...pattern, includeReturn: e.target.checked })} />
                <span style={{ fontSize: 12.5 }}>Also generate the return leg</span>
              </label>
              {pattern.includeReturn && (
                <>
                  <div style={{ fontSize: 11, color: C.faint, fontWeight: 600 }}>Return leg</div>
                  <div style={{ fontSize: 10, color: C.faint, marginTop: -6 }}>Doesn't have to go back the way it came — e.g. CIT→VKO out, VKO→ALA back. Leave blank to default to the reverse of the outbound route.</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <FieldSm label="Origin"><input value={pattern.returnOrigin} onChange={e => setPattern({ ...pattern, returnOrigin: e.target.value.toUpperCase() })} placeholder={pattern.destination} style={inputStyle} /></FieldSm>
                    <FieldSm label="Destination"><input value={pattern.returnDestination} onChange={e => setPattern({ ...pattern, returnDestination: e.target.value.toUpperCase() })} placeholder={pattern.origin} style={inputStyle} /></FieldSm>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <FieldSm label="Flight number"><input value={pattern.returnRef} onChange={e => setPattern({ ...pattern, returnRef: e.target.value.toUpperCase() })} placeholder="auto" style={inputStyle} /></FieldSm>
                    <FieldSm label="Return after (days)"><input type="number" min={0} value={pattern.returnDayOffset} onChange={e => setPattern({ ...pattern, returnDayOffset: Math.max(0, +e.target.value) })} style={inputStyle} /></FieldSm>
                  </div>
                  <div style={{ fontSize: 10, color: C.faint, marginTop: -4 }}>0 = same day (typical out-and-back turnaround). Use 1+ for layovers — e.g. 1 means the aircraft returns the day after each outbound date.</div>
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <FieldSm label="Departure (UTC)"><input type="time" value={pattern.returnDep} onChange={e => setPattern({ ...pattern, returnDep: e.target.value })} style={inputStyle} /></FieldSm>
                    <FieldSm label="Arrival (UTC)"><input type="time" value={pattern.returnArr} onChange={e => setPattern({ ...pattern, returnArr: e.target.value })} style={inputStyle} /></FieldSm>
                  </div>
                </>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={generate} disabled={pattern.daysOfWeek.length === 0} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview dates</button>
            </div>
          </>
        )}

        {preview && !output && (
          <>
            <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Review, then generate the slot request before anything is written to the schedule.</div>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 12, maxHeight: 320, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left", position: "sticky", top: 0 }}>
                  <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Date</th><th style={{ padding: "6px 8px" }}>Leg</th><th style={{ padding: "6px 8px" }}>Flight</th><th style={{ padding: "6px 8px" }}>Route</th><th style={{ padding: "6px 8px" }}>Status</th>
                </tr></thead>
                <tbody>
                  {preview.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.borderSoft}` }}>
                      <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={r.include} onChange={e => setPreview(rs => rs.map((x, xi) => xi === i ? { ...x, include: e.target.checked } : x))} /></td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{iso(r.date)} <span style={{ color: C.faint }}>{DOW[r.date.getUTCDay()]}</span></td>
                      <td style={{ padding: "6px 8px", color: C.muted }}>{r.leg}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.ref}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO, fontSize: 11 }}>{r.origin}→{r.destination} {r.depTime}–{r.arrTime}</td>
                      <td style={{ padding: "6px 8px" }}><Badge color={statusColor[r.status]}>{r.status.toUpperCase()}</Badge>{r.detail && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{r.detail}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{okCount} of {preview.length} rows selected</span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button onClick={() => setPreview(null)} style={miniBtn}>Back</button>
                <button onClick={() => setScrRole("destination")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "destination" ? C.amber : "transparent", color: scrRole === "destination" ? ON_ACCENT : C.text, borderColor: scrRole === "destination" ? C.amber : C.border }}>Arrival</button>
                <button onClick={() => setScrRole("origin")} style={{ ...miniBtn, padding: "6px 10px", fontSize: 11, background: scrRole === "origin" ? C.amber : "transparent", color: scrRole === "origin" ? ON_ACCENT : C.text, borderColor: scrRole === "origin" ? C.amber : C.border }}>Departure</button>
                <button onClick={generateSCR} disabled={okCount === 0} style={{ ...miniBtn, background: okCount ? GRADIENT_PRIMARY : C.faint, boxShadow: okCount ? GLOW_PRIMARY : "none", color: ON_ACCENT, borderColor: okCount ? C.amber : C.faint, fontWeight: 600 }}>Generate SCR</button>
              </div>
            </div>
          </>
        )}

        {output && (
          <>
            <div style={{ fontSize: 11, color: C.faint, marginBottom: 10 }}>Copy this and send it to the coordinator. Nothing is added to the schedule until you confirm below.</div>
            <textarea readOnly value={output} rows={8} style={{ ...inputStyle, fontFamily: MONO, fontSize: 12.5, resize: "vertical", whiteSpace: "pre" }} />
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 12 }}>
              <button onClick={() => setOutput(null)} style={miniBtn}>Back</button>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { try { navigator.clipboard.writeText(output); } catch (e) {} setCopied(true); }} style={{ ...miniBtn, background: copied ? C.greenSoft : GRADIENT_PRIMARY, boxShadow: copied ? "none" : GLOW_PRIMARY, color: copied ? C.green : ON_ACCENT, borderColor: copied ? C.green : C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
                <button onClick={() => onCommit(included, pattern)} disabled={!copied}
                  title={!copied ? "Copy the message above first" : undefined}
                  style={{ ...miniBtn, background: copied ? C.green : C.faint, color: ON_ACCENT, borderColor: copied ? C.green : C.faint, fontWeight: 600 }}>Confirm — add {okCount} flight{okCount === 1 ? "" : "s"}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- bulk retime (whole season or a filtered subset) ----------
// ---------- bulk delete ----------
function BulkDeleteModal({ resources, flights, allotments, onClose, onCommit }) {
  const [filter, setFilter] = useState({ from: iso(today), to: iso(addDays(today, 180)), resourceId: "all", originContains: "", destContains: "" });
  const [matches, setMatches] = useState(null);
  const [excluded, setExcluded] = useState(new Set());

  function preview() {
    const f = flights.filter(fl =>
      iso(fl.start) >= filter.from && iso(fl.start) <= filter.to &&
      (filter.resourceId === "all" || fl.resourceId === filter.resourceId) &&
      (!filter.originContains || fl.origin.includes(filter.originContains.toUpperCase())) &&
      (!filter.destContains || fl.destination.includes(filter.destContains.toUpperCase()))
    );
    setMatches(f);
    setExcluded(new Set());
  }

  const included = matches ? matches.filter(f => !excluded.has(f.id)) : [];
  const activeAllotmentCount = included.reduce((s, f) => s + allotments.filter(a => a.flightId === f.id && a.status !== "cancelled" && a.status !== "released").length, 0);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 620, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk delete flights</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Filter to the flights you want gone, review exactly what's affected, then commit. This can't be undone.</div>

        {!matches && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <FieldSm label="From"><input type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="To"><input type="date" value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value })} style={inputStyle} /></FieldSm>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <FieldSm label="Aircraft">
                <select value={filter.resourceId} onChange={e => setFilter({ ...filter, resourceId: e.target.value })} style={inputStyle}>
                  <option value="all">All aircraft</option>
                  {resources.map(r => <option key={r.id} value={r.id}>{r.code}</option>)}
                </select>
              </FieldSm>
              <FieldSm label="Origin contains"><input value={filter.originContains} onChange={e => setFilter({ ...filter, originContains: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="Dest. contains"><input value={filter.destContains} onChange={e => setFilter({ ...filter, destContains: e.target.value })} style={inputStyle} /></FieldSm>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={preview} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview</button>
            </div>
          </>
        )}

        {matches && (
          <>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden", marginBottom: 12, maxHeight: 320, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left", position: "sticky", top: 0 }}>
                  <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Ref</th><th style={{ padding: "6px 8px" }}>Route</th><th style={{ padding: "6px 8px" }}>Date</th><th style={{ padding: "6px 8px" }}>Active allotments</th>
                </tr></thead>
                <tbody>
                  {matches.map(f => {
                    const activeCount = allotments.filter(a => a.flightId === f.id && a.status !== "cancelled" && a.status !== "released").length;
                    return (
                      <tr key={f.id} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: excluded.has(f.id) ? 0.5 : 1 }}>
                        <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={!excluded.has(f.id)} onChange={e => setExcluded(prev => { const n = new Set(prev); e.target.checked ? n.delete(f.id) : n.add(f.id); return n; })} /></td>
                        <td style={{ padding: "6px 8px", fontFamily: MONO }}>{f.ref}</td>
                        <td style={{ padding: "6px 8px" }}>{f.origin}→{f.destination}</td>
                        <td style={{ padding: "6px 8px", fontFamily: MONO, color: C.muted }}>{iso(f.start)}</td>
                        <td style={{ padding: "6px 8px", color: activeCount ? C.red : C.faint, fontWeight: activeCount ? 600 : 400 }}>{activeCount || "—"}</td>
                      </tr>
                    );
                  })}
                  {matches.length === 0 && <tr><td colSpan={5} style={{ padding: 12, textAlign: "center", color: C.faint }}>No flights matched that filter.</td></tr>}
                </tbody>
              </table>
            </div>
            {activeAllotmentCount > 0 && (
              <div style={{ fontSize: 12, color: C.red, marginBottom: 10 }}>{activeAllotmentCount} active allotment(s) across the selected flights will be deleted too.</div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{included.length} of {matches.length} flights selected</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setMatches(null)} style={miniBtn}>Back</button>
                <button onClick={() => onCommit(included.map(f => f.id))} disabled={included.length === 0} style={{ ...miniBtn, background: included.length ? C.red : C.faint, color: ON_ACCENT, borderColor: included.length ? C.red : C.faint, fontWeight: 600 }}>Delete {included.length}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BulkRetimeModal({ resources, flights, onClose, onCommit }) {
  const [filter, setFilter] = useState({ from: iso(today), to: iso(addDays(today, 180)), resourceId: "all", originContains: "", destContains: "" });
  const [change, setChange] = useState({ dayShift: 0, timeMode: "shift", minuteShift: 60, newDepTime: "" });
  const [matches, setMatches] = useState(null);
  const [excluded, setExcluded] = useState(new Set());

  function useCurrentSeason() {
    const season = iataSeasonFor(today);
    // Approximate the season's own bounds by scanning forward/back from today for the boundary.
    let from = today, to = today;
    for (let i = 0; i < 400; i++) { const d = addDays(today, -i); if (iataSeasonFor(d) !== season) break; from = d; }
    for (let i = 0; i < 400; i++) { const d = addDays(today, i); if (iataSeasonFor(d) !== season) break; to = d; }
    setFilter({ ...filter, from: iso(from), to: iso(to) });
  }

  function preview() {
    const f = flights.filter(fl =>
      iso(fl.start) >= filter.from && iso(fl.start) <= filter.to &&
      (filter.resourceId === "all" || fl.resourceId === filter.resourceId) &&
      (!filter.originContains || fl.origin.includes(filter.originContains.toUpperCase())) &&
      (!filter.destContains || fl.destination.includes(filter.destContains.toUpperCase()))
    );
    setMatches(f);
    setExcluded(new Set());
  }

  const included = matches ? matches.filter(f => !excluded.has(f.id)) : [];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 620, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk retime</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Shift dates and/or times across a whole season (or any filtered set) in one go. Nothing changes until you commit below.</div>

        {!matches && (
          <>
            <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginBottom: 6 }}>Which flights</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <FieldSm label="From"><input type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="To"><input type="date" value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value })} style={inputStyle} /></FieldSm>
              <div style={{ display: "flex", alignItems: "flex-end" }}><button onClick={useCurrentSeason} style={miniBtn}>This season ({iataSeasonFor(today)})</button></div>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <FieldSm label="Aircraft">
                <select value={filter.resourceId} onChange={e => setFilter({ ...filter, resourceId: e.target.value })} style={inputStyle}>
                  <option value="all">All aircraft</option>
                  {resources.map(r => <option key={r.id} value={r.id}>{r.code}</option>)}
                </select>
              </FieldSm>
              <FieldSm label="Origin contains"><input value={filter.originContains} onChange={e => setFilter({ ...filter, originContains: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="Dest. contains"><input value={filter.destContains} onChange={e => setFilter({ ...filter, destContains: e.target.value })} style={inputStyle} /></FieldSm>
            </div>

            <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, marginBottom: 6 }}>What changes</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <FieldSm label="Shift date by (days)"><input type="number" value={change.dayShift} onChange={e => setChange({ ...change, dayShift: +e.target.value })} style={inputStyle} /></FieldSm>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 4, alignItems: "flex-end" }}>
              <FieldSm label="Time change">
                <select value={change.timeMode} onChange={e => setChange({ ...change, timeMode: e.target.value })} style={inputStyle}>
                  <option value="none">No time change</option>
                  <option value="shift">Shift by minutes (e.g. clock change)</option>
                  <option value="set">Set new departure time</option>
                </select>
              </FieldSm>
              {change.timeMode === "shift" && <FieldSm label="Minutes (+/-)"><input type="number" value={change.minuteShift} onChange={e => setChange({ ...change, minuteShift: +e.target.value })} style={inputStyle} /></FieldSm>}
              {change.timeMode === "set" && <FieldSm label="New departure (UTC)"><input type="time" value={change.newDepTime} onChange={e => setChange({ ...change, newDepTime: e.target.value })} style={inputStyle} /></FieldSm>}
            </div>
            <div style={{ fontSize: 10, color: C.faint, marginBottom: 12 }}>Arrival time moves with departure so each flight's duration stays the same.</div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={preview} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview</button>
            </div>
          </>
        )}

        {matches && (
          <>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 12, maxHeight: 320, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left", position: "sticky", top: 0 }}>
                  <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Ref</th><th style={{ padding: "6px 8px" }}>Route</th><th style={{ padding: "6px 8px" }}>Current</th><th style={{ padding: "6px 8px" }}>New</th>
                </tr></thead>
                <tbody>
                  {matches.map(f => {
                    const newStart = change.dayShift ? addDays(f.start, change.dayShift) : f.start;
                    let newDep = f.depTime, newArr = f.arrTime;
                    if (change.timeMode === "shift" && change.minuteShift && f.depTime) {
                      newDep = minutesToHHMM(timeToMinutes(f.depTime) + change.minuteShift);
                      if (f.arrTime) newArr = minutesToHHMM(timeToMinutes(f.arrTime) + change.minuteShift);
                    } else if (change.timeMode === "set" && change.newDepTime) {
                      newDep = change.newDepTime;
                      if (f.depTime && f.arrTime) {
                        const dur = (timeToMinutes(f.arrTime) - timeToMinutes(f.depTime) + 1440) % 1440;
                        newArr = minutesToHHMM(timeToMinutes(change.newDepTime) + dur);
                      }
                    }
                    return (
                      <tr key={f.id} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: excluded.has(f.id) ? 0.5 : 1 }}>
                        <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={!excluded.has(f.id)} onChange={e => setExcluded(prev => { const n = new Set(prev); e.target.checked ? n.delete(f.id) : n.add(f.id); return n; })} /></td>
                        <td style={{ padding: "6px 8px", fontFamily: MONO }}>{f.ref}</td>
                        <td style={{ padding: "6px 8px" }}>{f.origin}→{f.destination}</td>
                        <td style={{ padding: "6px 8px", fontFamily: MONO, color: C.muted }}>{iso(f.start)} {f.depTime || ""}</td>
                        <td style={{ padding: "6px 8px", fontFamily: MONO, color: C.cyan }}>{iso(newStart)} {newDep || ""}</td>
                      </tr>
                    );
                  })}
                  {matches.length === 0 && <tr><td colSpan={5} style={{ padding: 12, textAlign: "center", color: C.faint }}>No flights matched that filter.</td></tr>}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{included.length} of {matches.length} flights selected</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setMatches(null)} style={miniBtn}>Back</button>
                <button onClick={() => onCommit(included, change)} disabled={included.length === 0} style={{ ...miniBtn, background: included.length ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: included.length ? C.amber : C.faint, fontWeight: 600 }}>Apply to {included.length}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- SCR (Slot Clearance Request) message generator ----------
// Format per IATA SSIM Chapter 6.2 — verified against published coordinator guides (Slot
// Coordination Czech Republic, HKIA). This is a formatting tool, not a filing system: it
// builds the plain-text message you paste into an email to the slot coordinator. A single
// SCR message shares one header (creator ref, season, message date, clearance airport) but
// can carry several data lines — one per flight/period/day-pattern combination — which is
// exactly how a real multi-flight or multi-period request is meant to be filed, not as
// separate messages.
// Both tables below are transcribed directly from Schedule Coordination Austria's official
// SCR format spec (itself based on IATA SSIM Ch.6) — action codes are the airline-usable
// subset (the coordinator-side codes K/T/X/H/U/O/W are replies, not something an airline sends).
const SCR_ACTION_CODES = [
  ["N", "New request of slot"], ["D", "Delete confirmed slot"], ["C", "Slot to be changed"],
  ["R", "Revised slot request"], ["A", "Accept offer"], ["P", "Accept offer with pending request time"],
  ["Z", "Decline offer"],
];
const SCR_SERVICE_TYPES = [
  ["J", "Scheduled — passenger, normal service"], ["U", "Scheduled — air ambulance/humanitarian"],
  ["F", "Scheduled — cargo/mail (loose or preloaded)"], ["M", "Scheduled — mail only"],
  ["Q", "Scheduled — passenger/cargo (mixed config)"], ["G", "Additional — passenger, normal service"],
  ["A", "Additional — cargo/mail"], ["R", "Additional — passenger/cargo (mixed config)"],
  ["C", "Charter — passenger only"], ["O", "Charter — special handling (e.g. migrant/immigrant)"],
  ["H", "Charter — cargo/mail"], ["L", "Charter — passenger and cargo/mail"],
  ["P", "Non-revenue (positioning/ferry/delivery/demo)"], ["T", "Technical test"], ["K", "Crew training"],
  ["E", "Special (government)"], ["W", "Military"], ["X", "Technical stop"], ["I", "State/diplomatic"],
];
const IATA_DAYS = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["7", "Sun"]];

function newSCRLine(seed) {
  return {
    id: "l" + Math.random().toString(36).slice(2, 9),
    actionCode: "N", arrFlightId: "", depFlightId: "", arrDesignator: "DV", depDesignator: "DV",
    periodFrom: iso(today), periodTo: iso(today), days: [String(jsToIataDay(today.getUTCDay()))],
    seats: 189, acType: "", inboundService: "C", outboundService: "C",
    ...seed,
  };
}

// Rebuilt against Schedule Coordination Austria's official SCR format spec (itself sourced
// from IATA SSIM Chapter 6) — verified character-by-character against all three of their
// worked examples below. This supersedes an earlier version built from two hand-typed PRG
// examples that turned out to disagree with the authoritative spec in several real ways: no
// "SKD" qualifier exists in the standard (the field is just the other airport's code + time),
// the clearance airport itself is never repeated in the line, the arrival leg is listed
// FIRST (not departure), a single day is still written as a doubled range (not shortened),
// and there's a real, documented space-vs-no-space rule between the action code and the
// flight number depending on whether the line opens with an arrival or a departure.
//   NABC0123 15MAR15MAR 0000060 18973H LNZ0900 C                        (arrival only)
//   N ABC5678 15MAR15MAR 0000060 18973H 1200LNZ C                       (departure only)
//   NABC9876 ABC5432 17MAR28MAR 1230000 18973H LNZ1430 1455LNZ CC       (arrival + departure)
function buildSCRDataLine(line, flights, clearanceAirport) {
  const arrFlight = flights.find(f => f.id === line.arrFlightId) || null;
  const depFlight = flights.find(f => f.id === line.depFlightId) || null;
  const seats = String(line.seats).padStart(3, "0").slice(-3);
  const acType = (line.acType || "").padEnd(3, "_").slice(0, 3);
  const arrFlt = arrFlight ? `${line.arrDesignator}${padFlightNo(arrFlight.ref)}` : "";
  const depFlt = depFlight ? `${line.depDesignator}${padFlightNo(depFlight.ref)}` : "";
  // Always a doubled range, even for a single day — the spec has no shortened single-date form.
  const period = ddmmm(new Date(line.periodFrom)) + ddmmm(new Date(line.periodTo));
  const days = daysOfOpString(line.days.map(Number));
  const hhmmCompact = t => t ? t.replace(":", "") : "----";
  // Arrival block: the flight's ORIGIN (not the clearance airport) + its arrival time here, no
  // blank between them. Departure block: departure time from here + the flight's DESTINATION,
  // no blank. The clearance airport is never itself written into these fields.
  const arrBlock = arrFlight ? `${arrFlight.origin}${hhmmCompact(arrFlight.arrTime)}` : "";
  const depBlock = depFlight ? `${hhmmCompact(depFlight.depTime)}${depFlight.destination}` : "";
  // Arrival leg always comes first when a line covers both directions. No space between the
  // action code and an arrival flight number; a mandatory space before a departure-only one.
  const firstToken = arrFlight ? line.actionCode + arrFlt : `${line.actionCode} ${depFlt}`;
  const secondToken = arrFlight && depFlight ? depFlt : "";
  const svcLetters = [arrFlight ? line.inboundService : "", depFlight ? line.outboundService : ""].filter(Boolean).join("");
  return [firstToken, secondToken, period, days, seats + acType, arrBlock, depBlock, svcLetters].filter(Boolean).join(" ");
}

function buildSCRMessage(header, lines, flights) {
  // Neither confirmed real example includes a creator-reference line at all — the earlier
  // version inserted one unconditionally as line 2, which pushed every following line out of
  // position. If a reference is actually given, it goes in an SI line instead of inventing a
  // fixed structural position for it that isn't attested anywhere.
  const out = ["SCR", header.season, ddmmm(new Date(header.messageDate)), header.clearanceAirport];
  lines.forEach(line => out.push(buildSCRDataLine(line, flights, header.clearanceAirport)));
  if (header.creatorRef) out.push(`SI REF ${header.creatorRef}`);
  if (header.si) out.push(`SI ${header.si}`);
  out.push(`GI ${header.gi || "BRGDS"}`);
  return out.join("\n");
}

// Turns a flight (or a whole batch just created — single insert, bulk import, rotation
// generator) straight into an SCR draft, so the request is ready the moment the schedule
// change exists rather than requiring someone to re-enter the same route/dates by hand.
//
// The real fix here: this used to group by a single route direction and only ever fill in
// EITHER arrFlightId OR depFlightId per line, controlled by a single "role" for the whole
// batch — so a rotation's outbound and return legs always ended up as two separate, single-leg
// lines. That's wrong: the actual format wants a same-aircraft, same-day arrival-into and
// departure-from the clearance airport combined into ONE line (arrival leg first, departure
// leg second — see buildSCRDataLine). This version finds those real pairs first, and only
// falls back to a single-leg line for whatever's left unpaired (e.g. a one-way positioning
// flight with no matching return).
function deriveSCRSeedFromFlights(flightList, resources, role) {
  if (flightList.length === 0) return { clearanceAirport: "", lines: [newSCRLine()] };
  const clearanceAirport = role === "destination" ? flightList[0].destination : flightList[0].origin;

  const arrivals = flightList.filter(f => f.destination === clearanceAirport);
  const departures = flightList.filter(f => f.origin === clearanceAirport);

  // Same-day arrival+departure pairing only makes sense when requesting slots at the
  // turnaround airport (role "destination") — that's a real single movement pair the
  // coordinator expects combined into one line. At the departure/home airport (role
  // "origin"), the outbound departure and the eventual return arrival are two distinct
  // movements days or legs apart in the rotation, not a same-airport turnaround, and stay as
  // two separate lines by design, even if they happen to land on the same calendar day.
  let soloArrivals = arrivals, soloDepartures = departures;
  const pairs = [];
  if (role === "destination") {
    const usedArr = new Set(), usedDep = new Set();
    arrivals.forEach(a => {
      const match = departures.find(d => !usedDep.has(d.id) && d.resourceId === a.resourceId && iso(d.start) === iso(a.start));
      if (match) { pairs.push({ arr: a, dep: match }); usedArr.add(a.id); usedDep.add(match.id); }
    });
    soloArrivals = arrivals.filter(a => !usedArr.has(a.id));
    soloDepartures = departures.filter(d => !usedDep.has(d.id));
  }

  function daysOf(dateGetter, items) { return [...new Set(items.map(dateGetter))].map(String); }
  const lines = [];

  // Paired rotations — same flight-number pair on the same aircraft, across however many
  // dates, becomes one line with a period + frequency, not one line per occurrence.
  const pairGroups = new Map();
  pairs.forEach(p => {
    const key = `${p.arr.ref}|${p.dep.ref}|${p.arr.resourceId}`;
    if (!pairGroups.has(key)) pairGroups.set(key, []);
    pairGroups.get(key).push(p);
  });
  pairGroups.forEach(group => {
    group.sort((a, b) => a.arr.start - b.arr.start);
    const rep = group[0];
    const res = resources.find(r => r.id === rep.arr.resourceId);
    lines.push(newSCRLine({
      arrFlightId: rep.arr.id, depFlightId: rep.dep.id,
      periodFrom: iso(group[0].arr.start), periodTo: iso(group[group.length - 1].arr.start),
      days: daysOf(p => jsToIataDay(p.arr.start.getUTCDay()), group),
      seats: res?.capacity || rep.arr.capacity, acType: res ? acTypeCodeFor(res.variant) : "",
      arrDesignator: airlineCodeFromRef(rep.arr.ref) || "DV", depDesignator: airlineCodeFromRef(rep.dep.ref) || "DV",
    }));
  });

  // Whatever's left over — an arrival with no same-day return, or a departure with no same-day
  // inbound — still becomes a real, correctly single-leg line, exactly as before.
  function soloLines(items, legKey) {
    const groups = new Map();
    items.forEach(f => { const key = `${f.ref}|${f.resourceId}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(f); });
    groups.forEach(group => {
      group.sort((a, b) => a.start - b.start);
      const rep = group[0];
      const res = resources.find(r => r.id === rep.resourceId);
      const code = airlineCodeFromRef(rep.ref);
      lines.push(newSCRLine({
        [legKey === "arr" ? "arrFlightId" : "depFlightId"]: rep.id,
        periodFrom: iso(group[0].start), periodTo: iso(group[group.length - 1].start),
        days: daysOf(f => jsToIataDay(f.start.getUTCDay()), group),
        seats: res?.capacity || rep.capacity, acType: res ? acTypeCodeFor(res.variant) : "",
        ...(code ? { [legKey === "arr" ? "arrDesignator" : "depDesignator"]: code } : {}),
      }));
    });
  }
  soloLines(soloArrivals, "arr");
  soloLines(soloDepartures, "dep");

  return { clearanceAirport, lines: lines.length ? lines : [newSCRLine()] };
}

// Groups a scattered set of picked dates into the fewest valid SCR lines: dates on the same
// weekday that form an unbroken weekly run (each exactly 7 days after the last) collapse into
// one ranged line; anything that breaks the weekly cadence — a one-off, a skipped week — gets
// its own single-date line instead of being silently folded into a range it doesn't belong to.
function groupDatesIntoLineSpecs(dateStrings) {
  const byWeekday = new Map();
  dateStrings.map(s => new Date(s + "T00:00:00Z")).sort((a, b) => a - b).forEach(d => {
    const wd = jsToIataDay(d.getUTCDay());
    if (!byWeekday.has(wd)) byWeekday.set(wd, []);
    byWeekday.get(wd).push(d);
  });
  const specs = [];
  byWeekday.forEach((dates, wd) => {
    let runStart = dates[0], prev = dates[0];
    for (let i = 1; i <= dates.length; i++) {
      const d = dates[i];
      const isConsecutiveWeek = d && (d - prev) === 7 * 86400000;
      if (!isConsecutiveWeek) {
        specs.push({ periodFrom: iso(runStart), periodTo: iso(prev), days: [String(wd)] });
        if (d) runStart = d;
      }
      if (d) prev = d;
    }
  });
  return specs.sort((a, b) => a.periodFrom.localeCompare(b.periodFrom));
}

function CalendarMultiPick({ selected, onToggle }) {
  const [viewMonth, setViewMonth] = useState(() => { const d = new Date(today); d.setUTCDate(1); return d; });
  const year = viewMonth.getUTCFullYear(), month = viewMonth.getUTCMonth();
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const monthLabel = viewMonth.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <button onClick={() => setViewMonth(addDays(viewMonth, -1))} style={{ ...miniBtn, padding: "3px 8px", fontSize: 11 }}>◀</button>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{monthLabel}</span>
        <button onClick={() => { const d = new Date(viewMonth); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(1); setViewMonth(d); }} style={{ ...miniBtn, padding: "3px 8px", fontSize: 11 }}>▶</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 3 }}>
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => <div key={i} style={{ textAlign: "center", fontSize: 9.5, color: C.faint }}>{d}</div>)}
        {cells.map((day, i) => {
          if (!day) return <div key={i} />;
          const dateStr = iso(new Date(Date.UTC(year, month, day)));
          const isSel = selected.includes(dateStr);
          return (
            <button key={i} onClick={() => onToggle(dateStr)}
              style={{ height: 26, borderRadius: 6, border: `1px solid ${isSel ? C.amber : C.border}`, background: isSel ? GRADIENT_PRIMARY : "transparent", color: isSel ? ON_ACCENT : C.text, fontSize: 11, cursor: "pointer", padding: 0 }}>{day}</button>
          );
        })}
      </div>
    </div>
  );
}

function SCRModal({ resources, flights, onClose, seedFlights, seedRole }) {
  const initialRole = seedRole || "destination";
  const initialSeed = seedFlights?.length ? deriveSCRSeedFromFlights(seedFlights, resources, initialRole) : null;
  const [role, setRole] = useState(initialRole);
  const [header, setHeader] = useState({
    creatorRef: "", season: iataSeasonFor(today), messageDate: iso(today),
    clearanceAirport: initialSeed?.clearanceAirport || "", si: "", gi: "BRGDS",
  });
  const [lines, setLines] = useState(initialSeed?.lines || [newSCRLine()]);
  const [output, setOutput] = useState(null);
  const [copied, setCopied] = useState(false);

  // Re-derives lines for the other leg of the same batch — e.g. switching from "arrival at
  // destination" to "departure at origin" for the flights this modal was opened with.
  function switchRole(newRole) {
    setRole(newRole);
    if (!seedFlights?.length) return;
    const seed = deriveSCRSeedFromFlights(seedFlights, resources, newRole);
    setHeader(h => ({ ...h, clearanceAirport: seed.clearanceAirport }));
    setLines(seed.lines);
  }

  function updateLine(id, patch) { setLines(ls => ls.map(l => l.id === id ? { ...l, ...patch } : l)); }
  function removeLine(id) { setLines(ls => ls.filter(l => l.id !== id)); }
  function addLine() { setLines(ls => [...ls, newSCRLine()]); }

  // "Add via calendar" — pick one flight/service config once, then click any number of
  // scattered dates; on confirm, those dates get grouped into the fewest valid lines (weekly
  // runs collapse, one-offs stay separate) and appended in one go.
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [datePickerDraft, setDatePickerDraft] = useState({
    actionCode: "N", arrFlightId: "", depFlightId: "", arrDesignator: "DV", depDesignator: "DV",
    inboundService: "C", outboundService: "C", seats: 189, acType: "", dates: [],
  });
  function pickDraftFlight(which, flightId) {
    const f = flights.find(x => x.id === flightId);
    const patch = { [which === "arr" ? "arrFlightId" : "depFlightId"]: flightId };
    if (f) {
      const res = resources.find(r => r.id === f.resourceId);
      if (res) { patch.seats = res.capacity; patch.acType = acTypeCodeFor(res.variant); }
      const code = airlineCodeFromRef(f.ref);
      if (code) patch[which === "arr" ? "arrDesignator" : "depDesignator"] = code;
    }
    setDatePickerDraft(d => ({ ...d, ...patch }));
  }
  function toggleDraftDate(dateStr) {
    setDatePickerDraft(d => ({ ...d, dates: d.dates.includes(dateStr) ? d.dates.filter(x => x !== dateStr) : [...d.dates, dateStr] }));
  }
  function confirmDatePicker() {
    const specs = groupDatesIntoLineSpecs(datePickerDraft.dates);
    const { dates, ...shared } = datePickerDraft;
    const newLines = specs.map(spec => newSCRLine({ ...shared, ...spec }));
    setLines(ls => [...ls, ...newLines]);
    if (!header.clearanceAirport) {
      const repFlight = flights.find(f => f.id === (shared.arrFlightId || shared.depFlightId));
      if (repFlight) setHeader(h => ({ ...h, clearanceAirport: shared.arrFlightId ? repFlight.destination : repFlight.origin }));
    }
    setDatePickerDraft({ actionCode: "N", arrFlightId: "", depFlightId: "", arrDesignator: "DV", depDesignator: "DV", inboundService: "C", outboundService: "C", seats: 189, acType: "", dates: [] });
    setShowDatePicker(false);
  }

  // Airline designator follows whatever's actually on the selected flight's ref (DV stays DV,
  // VSV stays VSV) rather than a fixed default.
  function pickFlight(lineId, which, flightId) {
    const f = flights.find(x => x.id === flightId);
    const patch = { [which === "arr" ? "arrFlightId" : "depFlightId"]: flightId };
    if (f) {
      if (!header.clearanceAirport) setHeader(h => ({ ...h, clearanceAirport: which === "arr" ? f.destination : f.origin }));
      patch.periodFrom = iso(f.start); patch.periodTo = iso(f.start);
      patch.days = [String(jsToIataDay(f.start.getUTCDay()))];
      const res = resources.find(r => r.id === f.resourceId);
      if (res) { patch.seats = res.capacity; patch.acType = acTypeCodeFor(res.variant); }
      const code = airlineCodeFromRef(f.ref);
      if (code) patch[which === "arr" ? "arrDesignator" : "depDesignator"] = code;
    }
    updateLine(lineId, patch);
  }

  const canGenerate = header.clearanceAirport && lines.length > 0 && lines.every(l => l.arrFlightId || l.depFlightId);

  function generate() {
    setOutput(buildSCRMessage(header, lines, flights));
    setCopied(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 680, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Generate SCR (Slot Clearance Request)</div>
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 12 }}>Format per IATA SSIM Ch.6. One message, one clearance airport, any number of flights/periods as separate data lines below. Aircraft type is a best-effort guess — verify before sending.</div>

        {seedFlights?.length > 0 && !output && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, background: C.panel2, border: `1px solid ${C.border}`, borderRadius: 8, padding: 8 }}>
            <span style={{ fontSize: 11, color: C.muted }}>Pre-filled from {seedFlights.length} flight{seedFlights.length === 1 ? "" : "s"} just added — generating for:</span>
            <button onClick={() => switchRole("destination")} style={{ ...miniBtn, padding: "4px 10px", fontSize: 11, background: role === "destination" ? C.amber : "transparent", color: role === "destination" ? ON_ACCENT : C.text, borderColor: role === "destination" ? C.amber : C.border }}>Arrival (dest.)</button>
            <button onClick={() => switchRole("origin")} style={{ ...miniBtn, padding: "4px 10px", fontSize: 11, background: role === "origin" ? C.amber : "transparent", color: role === "origin" ? ON_ACCENT : C.text, borderColor: role === "origin" ? C.amber : C.border }}>Departure (origin)</button>
          </div>
        )}

        {!output && (
          <>
            <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, margin: "4px 0 6px" }}>Message header (shared by every line below)</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <FieldSm label="Your reference / email"><input value={header.creatorRef} onChange={e => setHeader({ ...header, creatorRef: e.target.value })} placeholder="ops@yourairline.com" style={inputStyle} /></FieldSm>
              <FieldSm label="Clearance airport"><input value={header.clearanceAirport} onChange={e => setHeader({ ...header, clearanceAirport: e.target.value.toUpperCase() })} maxLength={4} style={inputStyle} /></FieldSm>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <FieldSm label="Season"><input value={header.season} onChange={e => setHeader({ ...header, season: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="Message date"><input type="date" value={header.messageDate} onChange={e => setHeader({ ...header, messageDate: e.target.value })} style={inputStyle} /></FieldSm>
            </div>

            <div style={{ fontSize: 11, color: C.faint, fontWeight: 600, margin: "4px 0 8px" }}>Data lines — one per flight/period ({lines.length})</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 10 }}>
              {lines.map((line, i) => (
                <div key={line.id} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, background: C.panel2 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>Line {i + 1}</div>
                    {lines.length > 1 && <button onClick={() => removeLine(line.id)} style={{ ...miniBtn, fontSize: 10.5, color: C.red, borderColor: C.red, padding: "3px 8px" }}>Remove</button>}
                  </div>
                  <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                    <FieldSm label="Action code">
                      <select value={line.actionCode} onChange={e => updateLine(line.id, { actionCode: e.target.value })} style={inputStyle}>
                        {SCR_ACTION_CODES.map(([c, l]) => <option key={c} value={c}>{c} — {l}</option>)}
                      </select>
                    </FieldSm>
                  </div>
                  <div style={{ fontSize: 10.5, color: C.faint, fontWeight: 600, marginBottom: 4 }}>Arrival leg (optional)</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <FieldSm label="Flight">
                      <select value={line.arrFlightId} onChange={e => pickFlight(line.id, "arr", e.target.value)} style={inputStyle}>
                        <option value="">— none —</option>
                        {flights.map(f => <option key={f.id} value={f.id}>{f.ref} {f.origin}→{f.destination} {iso(f.start)}</option>)}
                      </select>
                    </FieldSm>
                    <FieldSm label="Airline code"><input value={line.arrDesignator} onChange={e => updateLine(line.id, { arrDesignator: e.target.value.toUpperCase() })} maxLength={3} style={inputStyle} /></FieldSm>
                    <FieldSm label="Service">
                      <select value={line.inboundService} onChange={e => updateLine(line.id, { inboundService: e.target.value })} style={inputStyle}>
                        {SCR_SERVICE_TYPES.map(([c, l]) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </FieldSm>
                  </div>
                  <div style={{ fontSize: 10.5, color: C.faint, fontWeight: 600, marginBottom: 4 }}>Departure leg (optional)</div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <FieldSm label="Flight">
                      <select value={line.depFlightId} onChange={e => pickFlight(line.id, "dep", e.target.value)} style={inputStyle}>
                        <option value="">— none —</option>
                        {flights.map(f => <option key={f.id} value={f.id}>{f.ref} {f.origin}→{f.destination} {iso(f.start)}</option>)}
                      </select>
                    </FieldSm>
                    <FieldSm label="Airline code"><input value={line.depDesignator} onChange={e => updateLine(line.id, { depDesignator: e.target.value.toUpperCase() })} maxLength={3} style={inputStyle} /></FieldSm>
                    <FieldSm label="Service">
                      <select value={line.outboundService} onChange={e => updateLine(line.id, { outboundService: e.target.value })} style={inputStyle}>
                        {SCR_SERVICE_TYPES.map(([c, l]) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </FieldSm>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <FieldSm label="Period from"><input type="date" value={line.periodFrom} onChange={e => updateLine(line.id, { periodFrom: e.target.value })} style={inputStyle} /></FieldSm>
                    <FieldSm label="Period to"><input type="date" value={line.periodTo} onChange={e => updateLine(line.id, { periodTo: e.target.value })} style={inputStyle} /></FieldSm>
                  </div>
                  <FieldSm label="Days of operation">
                    <div style={{ display: "flex", gap: 4 }}>
                      {IATA_DAYS.map(([v, l]) => (
                        <button key={v} onClick={() => updateLine(line.id, { days: line.days.includes(v) ? line.days.filter(x => x !== v) : [...line.days, v] })}
                          style={{ ...miniBtn, padding: "5px 8px", background: line.days.includes(v) ? C.amber : "transparent", color: line.days.includes(v) ? ON_ACCENT : C.text, borderColor: line.days.includes(v) ? C.amber : C.border }}>{l}</button>
                      ))}
                    </div>
                  </FieldSm>
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <FieldSm label="Seats"><input type="number" value={line.seats} onChange={e => updateLine(line.id, { seats: +e.target.value })} style={inputStyle} /></FieldSm>
                    <FieldSm label="Aircraft type (3-char)"><input value={line.acType} onChange={e => updateLine(line.id, { acType: e.target.value.toUpperCase() })} maxLength={3} style={inputStyle} /></FieldSm>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
              <button onClick={addLine} style={miniBtn}>+ Add another flight/period</button>
              <button onClick={() => setShowDatePicker(v => !v)} style={{ ...miniBtn, background: showDatePicker ? C.amberSoft : "transparent", borderColor: showDatePicker ? C.amber : C.border }}>+ Add via calendar (multiple dates)</button>
            </div>

            {showDatePicker && (
              <div style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: 12, marginBottom: 14, background: C.panel2 }}>
                <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>Pick one flight/service config, then click any dates on the calendar — including scattered, non-weekly ones. On confirm, they're grouped into the fewest correct lines automatically.</div>
                <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                  <FieldSm label="Action code">
                    <select value={datePickerDraft.actionCode} onChange={e => setDatePickerDraft(d => ({ ...d, actionCode: e.target.value }))} style={inputStyle}>
                      {SCR_ACTION_CODES.map(([c, l]) => <option key={c} value={c}>{c} — {l}</option>)}
                    </select>
                  </FieldSm>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <FieldSm label="Arrival flight (optional)">
                    <select value={datePickerDraft.arrFlightId} onChange={e => pickDraftFlight("arr", e.target.value)} style={inputStyle}>
                      <option value="">— none —</option>
                      {flights.map(f => <option key={f.id} value={f.id}>{f.ref} {f.origin}→{f.destination}</option>)}
                    </select>
                  </FieldSm>
                  <FieldSm label="Departure flight (optional)">
                    <select value={datePickerDraft.depFlightId} onChange={e => pickDraftFlight("dep", e.target.value)} style={inputStyle}>
                      <option value="">— none —</option>
                      {flights.map(f => <option key={f.id} value={f.id}>{f.ref} {f.origin}→{f.destination}</option>)}
                    </select>
                  </FieldSm>
                </div>
                <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                  <FieldSm label="Seats"><input type="number" value={datePickerDraft.seats} onChange={e => setDatePickerDraft(d => ({ ...d, seats: +e.target.value }))} style={inputStyle} /></FieldSm>
                  <FieldSm label="Aircraft type"><input value={datePickerDraft.acType} onChange={e => setDatePickerDraft(d => ({ ...d, acType: e.target.value.toUpperCase() }))} maxLength={3} style={inputStyle} /></FieldSm>
                </div>
                <CalendarMultiPick selected={datePickerDraft.dates} onToggle={toggleDraftDate} />
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                  <span style={{ fontSize: 11, color: C.muted }}>{datePickerDraft.dates.length} date{datePickerDraft.dates.length === 1 ? "" : "s"} selected → {groupDatesIntoLineSpecs(datePickerDraft.dates).length} line{groupDatesIntoLineSpecs(datePickerDraft.dates).length === 1 ? "" : "s"}</span>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => setShowDatePicker(false)} style={miniBtn}>Cancel</button>
                    <button onClick={confirmDatePicker} disabled={datePickerDraft.dates.length === 0 || (!datePickerDraft.arrFlightId && !datePickerDraft.depFlightId)}
                      style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Add lines</button>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
              <FieldSm label="SI (supplementary info, optional)"><input value={header.si} onChange={e => setHeader({ ...header, si: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="GI (closing line)"><input value={header.gi} onChange={e => setHeader({ ...header, gi: e.target.value })} style={inputStyle} /></FieldSm>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={generate} disabled={!canGenerate} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Generate message ({lines.length} line{lines.length === 1 ? "" : "s"})</button>
            </div>
          </>
        )}

        {output && (
          <>
            <textarea readOnly value={output} rows={6 + lines.length} style={{ ...inputStyle, fontFamily: MONO, fontSize: 12.5, resize: "vertical", whiteSpace: "pre" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setOutput(null)} style={miniBtn}>Back</button>
              <button onClick={() => { try { navigator.clipboard.writeText(output); } catch (e) {} setCopied(true); }} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OperatorsPanel({ operators, setOperators, flights, allotments, perms, onAddOperator, onBulkImportOperators, onDeleteOperator, onAddAllotment }) {
  const [expanded, setExpanded] = useState(null); // { id, panel: "seats" | "rates" }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showAddOperator, setShowAddOperator] = useState(false);
  const [showBulkOperators, setShowBulkOperators] = useState(false);
  const [flightRateSearch, setFlightRateSearch] = useState("");
  const [flightRateSelected, setFlightRateSelected] = useState(() => new Set());
  const [flightRateSeats, setFlightRateSeats] = useState(10);
  const [flightRatePrice, setFlightRatePrice] = useState("");
  function updateDefaultRate(id, rate) { setOperators(ops => ops.map(o => o.id === id ? { ...o, defaultRate: rate } : o)); }
  function toggle(id, panel) { setExpanded(e => (e && e.id === id && e.panel === panel) ? null : { id, panel }); }
  const flightMatches = flightRateSearch.trim().length >= 2
    ? flights.filter(f => f.ref.toLowerCase().includes(flightRateSearch.toLowerCase()) || `${f.origin}-${f.destination}`.toLowerCase().includes(flightRateSearch.toLowerCase())).slice(0, 30)
    : [];
  function createAllotmentsFromSearch(operatorId) {
    const price = +flightRatePrice;
    if (!price || flightRateSelected.size === 0) return;
    flightRateSelected.forEach(flightId => onAddAllotment(flightId, operatorId, flightRateSeats, price));
    setFlightRateSelected(new Set());
    setFlightRateSearch("");
    setFlightRatePrice("");
  }

  return (
    <div style={{ padding: 16 }}>
      {perms.editContracts && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 10 }}>
          <button onClick={() => setShowBulkOperators(true)} style={miniBtn}>Bulk import operators</button>
          <button onClick={() => setShowAddOperator(true)} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ New operator</button>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600 }}>
            <th style={th}>Tour operator</th><th style={th}>Default rate</th><th style={th}>Allotment type</th><th style={th}>Status</th><th style={th}>Seats</th><th style={th}>Value</th><th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {operators.map(o => {
            const opAllotments = allotments.filter(a => a.operatorId === o.id && a.status !== "cancelled" && a.status !== "released");
            const totalSeats = opAllotments.reduce((s, a) => s + a.seatsAllocated, 0);
            const totalValue = opAllotments.reduce((s, a) => s + a.seatsAllocated * a.pricePerSeat, 0);
            const byDest = {};
            opAllotments.forEach(a => { const f = flights.find(fl => fl.id === a.flightId); if (f) byDest[f.destination] = (byDest[f.destination] || 0) + a.seatsAllocated; });
            const isSeats = expanded?.id === o.id && expanded.panel === "seats";
            const isRates = expanded?.id === o.id && expanded.panel === "rates";
            return (
              <React.Fragment key={o.id}>
                <tr style={{ borderTop: `1px solid ${C.borderSoft}` }}>
                  <td style={td}>{o.name}<span style={{ color: C.faint, marginLeft: 6, fontSize: 11 }}>{o.country}</span></td>
                  <td style={td}>
                    {perms.editContracts
                      ? <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                          <input type="number" value={o.defaultRate ?? ""} placeholder="none" onChange={e => updateDefaultRate(o.id, e.target.value === "" ? null : +e.target.value)} style={{ ...inputStyle, width: 80 }} />
                          {o.defaultRate != null && <button onClick={() => updateDefaultRate(o.id, null)} title="Clear default rate — every allotment for this operator will then need its own explicit price" style={{ ...miniBtn, padding: "3px 7px", fontSize: 10, color: C.red, borderColor: C.red }}>×</button>}
                        </div>
                      : <span style={{ fontFamily: MONO }}>{o.defaultRate != null ? `$${o.defaultRate}` : <span style={{ color: C.faint }}>none</span>}</span>}
                  </td>
                  <td style={td}><Badge color={o.allotmentType === "option" ? C.amber : C.cyan}>{o.allotmentType.toUpperCase()}{o.optionReleaseDays ? ` · ${o.optionReleaseDays}d` : ""}</Badge></td>
                  <td style={td}><Badge color={o.status === "active" ? C.green : C.red}>{o.status.replace("_", " ").toUpperCase()}</Badge></td>
                  <td style={{ ...td, fontFamily: MONO }}>{totalSeats}</td>
                  <td style={{ ...td, fontFamily: MONO, color: C.green, fontWeight: 600 }}>${totalValue.toLocaleString()}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => toggle(o.id, "rates")} style={miniBtn}>{isRates ? "Hide" : "Allocate seats"}</button>
                      <button onClick={() => toggle(o.id, "seats")} style={miniBtn}>{isSeats ? "Hide" : "View seats"}</button>
                      {perms.editContracts && confirmDeleteId !== o.id && <button onClick={() => setConfirmDeleteId(o.id)} style={{ ...miniBtn, color: C.red, borderColor: C.red }}>Delete</button>}
                      {perms.editContracts && confirmDeleteId === o.id && (
                        <>
                          <button onClick={() => { onDeleteOperator(o.id); setConfirmDeleteId(null); }} style={{ ...miniBtn, background: C.red, color: ON_ACCENT, borderColor: C.red }}>Confirm</button>
                          <button onClick={() => setConfirmDeleteId(null)} style={miniBtn}>Cancel</button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
                {isRates && (
                  <tr><td colSpan={7} style={{ padding: "6px 10px 14px", background: C.panel2 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      Allocate seats directly against specific flights for {o.name} — search by flight number or route (e.g. "CIT-HRI"), pick one or several matching dates, set seats and price, then Add. This creates real allotments, the same ones the Schedule board and this operator's "View seats" below both show — editing a flight's allotment either place updates both.
                    </div>
                    {perms.editContracts && (
                      <div>
                        <input value={flightRateSearch} onChange={e => { setFlightRateSearch(e.target.value); setFlightRateSelected(new Set()); }} placeholder="Flight number or route (e.g. AD-AA)…" style={{ ...inputStyle, width: 220, marginBottom: 6 }} />
                        {flightRateSearch.trim().length >= 2 && (
                          <div style={{ maxHeight: 160, overflowY: "auto", border: `1px solid ${C.borderSoft}`, borderRadius: 8, marginBottom: 8 }}>
                            {flightMatches.length === 0 && <div style={{ padding: 8, fontSize: 11.5, color: C.faint }}>No flights match "{flightRateSearch}".</div>}
                            {flightMatches.map(f => (
                              <label key={f.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px", fontSize: 12, fontFamily: MONO, cursor: "pointer", borderBottom: `1px solid ${C.borderSoft}` }}>
                                <input type="checkbox" checked={flightRateSelected.has(f.id)} onChange={() => setFlightRateSelected(prev => { const next = new Set(prev); next.has(f.id) ? next.delete(f.id) : next.add(f.id); return next; })} />
                                <span style={{ fontWeight: 700 }}>{f.ref}</span>
                                <span style={{ color: C.muted }}>{iso(f.start)}</span>
                                <span style={{ color: C.muted }}>{f.origin}→{f.destination}</span>
                              </label>
                            ))}
                            {flightMatches.length > 0 && (
                              <button onClick={() => setFlightRateSelected(new Set(flightMatches.map(f => f.id)))} style={{ ...miniBtn, margin: 6, fontSize: 10.5, padding: "3px 8px" }}>Select all {flightMatches.length}</button>
                            )}
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                          <FieldSm label="Seats"><input type="number" min={1} value={flightRateSeats} onChange={e => setFlightRateSeats(Math.max(1, +e.target.value))} style={{ ...inputStyle, width: 70 }} /></FieldSm>
                          <FieldSm label="Price / seat ($)"><input type="number" value={flightRatePrice} onChange={e => setFlightRatePrice(e.target.value)} style={{ ...inputStyle, width: 90 }} /></FieldSm>
                          <button onClick={() => createAllotmentsFromSearch(o.id)} disabled={flightRateSelected.size === 0 || !flightRatePrice}
                            style={{ ...miniBtn, background: (flightRateSelected.size && flightRatePrice) ? GRADIENT_PRIMARY : C.faint, boxShadow: (flightRateSelected.size && flightRatePrice) ? GLOW_PRIMARY : "none", color: ON_ACCENT, borderColor: (flightRateSelected.size && flightRatePrice) ? C.amber : C.faint, fontWeight: 600 }}>
                            Add{flightRateSelected.size ? ` (${flightRateSelected.size})` : ""}
                          </button>
                        </div>
                      </div>
                    )}
                  </td></tr>
                )}
                {isSeats && (
                  <tr><td colSpan={7} style={{ padding: "6px 10px 14px", background: C.panel2 }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                      {Object.entries(byDest).map(([dest, n]) => <Badge key={dest} color={C.cyan} bg={C.cyanSoft}>{dest}: {n}</Badge>)}
                      {Object.keys(byDest).length === 0 && <span style={{ fontSize: 11.5, color: C.faint }}>No active allotments.</span>}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>All active allotments for {o.name} — one consolidated view instead of a separate tab per flight:</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {opAllotments.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No active allotments.</div>}
                      {opAllotments.map(a => {
                        const fl = flights.find(f => f.id === a.flightId);
                        return <div key={a.id} style={{ display: "flex", gap: 14, fontSize: 12, fontFamily: MONO, color: C.text }}>
                          <span style={{ width: 70 }}>{fl?.ref}</span><span style={{ width: 90, color: C.muted }}>{iso(fl?.start)}</span>
                          <span style={{ width: 90, color: C.muted }}>{fl?.origin}→{fl?.destination}</span>
                          <span>{a.seatsAllocated} seats @ ${a.pricePerSeat}</span>
                          <span style={{ color: C.green }}>${(a.seatsAllocated * a.pricePerSeat).toLocaleString()}</span>
                        </div>;
                      })}
                    </div>
                  </td></tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {showAddOperator && <AddOperatorModal onClose={() => setShowAddOperator(false)} onCreate={op => { onAddOperator(op); setShowAddOperator(false); }} />}
      {showBulkOperators && <BulkImportOperatorsModal existingNames={operators.map(o => o.name.toLowerCase())} onClose={() => setShowBulkOperators(false)} onCommit={rows => { onBulkImportOperators(rows); setShowBulkOperators(false); }} />}
    </div>
  );
}
const th = { padding: "8px 10px" };
const td = { padding: "8px 10px" };

// ---------- tour operator create / bulk import ----------
function AddOperatorModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: "", country: "", defaultRate: 100, ratesByDestination: {}, allotmentType: "fixed", optionReleaseDays: 14, status: "active" });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 380, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>New tour operator</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldSm label="Name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="Country"><input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} style={inputStyle} /></FieldSm>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <FieldSm label="Default rate / seat ($)"><input type="number" value={form.defaultRate} onChange={e => setForm({ ...form, defaultRate: +e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="Allotment type">
              <select value={form.allotmentType} onChange={e => setForm({ ...form, allotmentType: e.target.value })} style={inputStyle}>
                <option value="fixed">Fixed</option>
                <option value="option">Option</option>
              </select>
            </FieldSm>
          </div>
          {form.allotmentType === "option" && (
            <FieldSm label="Option release (days before)"><input type="number" value={form.optionReleaseDays} onChange={e => setForm({ ...form, optionReleaseDays: +e.target.value })} style={inputStyle} /></FieldSm>
          )}
          <FieldSm label="Status">
            <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={inputStyle}>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="blacklisted">Blacklisted</option>
            </select>
          </FieldSm>
          <div style={{ fontSize: 10.5, color: C.faint }}>Per-destination rates can be added afterward from the "Rates" panel on this operator's row.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={miniBtn}>Cancel</button>
          <button disabled={!form.name.trim()} onClick={() => onCreate({ ...form, optionReleaseDays: form.allotmentType === "option" ? form.optionReleaseDays : null })}
            style={{ ...miniBtn, background: form.name.trim() ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: form.name.trim() ? C.amber : C.faint, fontWeight: 600 }}>Create</button>
        </div>
      </div>
    </div>
  );
}

const SAMPLE_OPERATOR_PASTE = `name,country,destination,rate,allotment_type,option_release_days,status
ANEX,RU,,115,fixed,,active
ANEX,RU,SSH,120,,,
ANEX,RU,HKT,118,,,
SILK ROAD TRAVEL,UZ,,105,fixed,,active
STEPPE VOYAGES,KZ,,112,option,10,active
STEPPE VOYAGES,KZ,ALA,120,,,`;

function BulkImportOperatorsModal({ existingNames, onClose, onCommit }) {
  const [raw, setRaw] = useState(SAMPLE_OPERATOR_PASTE);
  const [rows, setRows] = useState(null);

  function parse() {
    const lines = raw.trim().split("\n").filter(Boolean);
    const header = lines[0].toLowerCase().split(",").map(h => h.trim());
    const idx = name => header.findIndex(h => h.includes(name));
    const nameI = idx("name"), countryI = idx("country"), destI = idx("destination"), rateI = idx("rate"),
      typeI = idx("allotment") >= 0 ? idx("allotment") : idx("type"), releaseI = idx("release"), statusI = idx("status");

    const groups = new Map();
    lines.slice(1).forEach(line => {
      const cols = line.split(",").map(c => c.trim());
      const name = cols[nameI];
      if (!name) return;
      const key = name.toLowerCase();
      if (!groups.has(key)) groups.set(key, { name, country: "", defaultRate: null, ratesByDestination: {}, allotmentType: "fixed", optionReleaseDays: null, status: "active" });
      const g = groups.get(key);
      const dest = cols[destI]?.toUpperCase();
      const rate = +cols[rateI];
      if (cols[countryI]) g.country = cols[countryI].toUpperCase();
      if (cols[typeI]) g.allotmentType = cols[typeI].toLowerCase();
      if (cols[releaseI]) g.optionReleaseDays = +cols[releaseI];
      if (cols[statusI]) g.status = cols[statusI].toLowerCase();
      if (dest) g.ratesByDestination[dest] = rate;
      else if (rate) g.defaultRate = rate;
    });

    const parsed = [...groups.values()].map((g, i) => {
      let statusFlag = "ok", detail = "";
      if (!g.name || g.defaultRate == null) { statusFlag = "error"; detail = "Missing name or default rate (a row with a blank destination)"; }
      else if (existingNames.includes(g.name.toLowerCase())) { statusFlag = "conflict"; detail = "Already exists — will be skipped"; }
      return { row_number: i + 1, ...g, statusFlag, detail, include: statusFlag === "ok" };
    });
    setRows(parsed);
  }

  const statusColor = { ok: C.green, conflict: C.amber, error: C.red };
  const okCount = rows?.filter(r => r.include).length ?? 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 640, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk import tour operators</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>One row per operator sets the default rate (leave destination blank); add one more row per operator for each destination-specific rate. Nothing is written until you commit below.</div>
        {!rows && (
          <>
            <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={7} style={{ ...inputStyle, fontFamily: MONO, fontSize: 11.5, resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={parse} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview</button>
            </div>
          </>
        )}
        {rows && (
          <>
            <div style={{ border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden", marginBottom: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ background: C.panel2, color: C.muted, textAlign: "left" }}>
                  <th style={{ padding: "6px 8px" }}></th><th style={{ padding: "6px 8px" }}>Name</th><th style={{ padding: "6px 8px" }}>Country</th><th style={{ padding: "6px 8px" }}>Default</th><th style={{ padding: "6px 8px" }}>Dest. rates</th><th style={{ padding: "6px 8px" }}>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: r.statusFlag === "error" ? 0.6 : 1 }}>
                      <td style={{ padding: "6px 8px" }}><input type="checkbox" checked={r.include} disabled={r.statusFlag === "error"} onChange={e => setRows(rs => rs.map((x, xi) => xi === i ? { ...x, include: e.target.checked } : x))} /></td>
                      <td style={{ padding: "6px 8px" }}>{r.name}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>{r.country}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO }}>${r.defaultRate ?? "—"}</td>
                      <td style={{ padding: "6px 8px", fontFamily: MONO, fontSize: 11 }}>{Object.entries(r.ratesByDestination).map(([d, v]) => `${d}:$${v}`).join(", ") || "—"}</td>
                      <td style={{ padding: "6px 8px" }}><Badge color={statusColor[r.statusFlag]}>{r.statusFlag.toUpperCase()}</Badge>{r.detail && <div style={{ fontSize: 10, color: C.faint, marginTop: 2 }}>{r.detail}</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11.5, color: C.muted }}>{okCount} of {rows.length} rows selected</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setRows(null)} style={miniBtn}>Back</button>
                <button onClick={() => onCommit(rows.filter(r => r.include))} disabled={okCount === 0} style={{ ...miniBtn, background: okCount ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: okCount ? C.amber : C.faint, fontWeight: 600 }}>Import {okCount}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- team / users (management only) ----------
const ROLE_OPTIONS = [
  ["commercial", "Commercial staff"],
  ["tour_operator_liaison", "Tour operator liaison"],
  ["ops_coordinator", "Schedule coordinator (ops)"],
  ["management", "Charter dept management"],
];

function TeamPanel({ profiles, currentUserId, onUpdateRole, onCreateUser, onDeleteUser, onResetPassword, pushToast }) {
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12.5, color: C.muted }}>Roles here are what actually gate permissions everywhere else in the app — not a display label.</div>
        <button onClick={() => setShowAdd(true)} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ Add teammate</button>
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600 }}>
            <th style={th}>Name</th><th style={th}>Email</th><th style={th}>Role</th><th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {profiles.map(p => (
            <tr key={p.id} style={{ borderTop: `1px solid ${C.borderSoft}` }}>
              <td style={td}>{p.name}{p.id === currentUserId && <span style={{ color: C.faint, marginLeft: 6, fontSize: 11 }}>(you)</span>}</td>
              <td style={{ ...td, fontFamily: MONO, fontSize: 12 }}>{p.email}</td>
              <td style={td}>
                <select value={p.role} onChange={e => onUpdateRole(p.id, e.target.value)} disabled={p.id === currentUserId} style={{ ...inputStyle, width: 200 }}>
                  {ROLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </td>
              <td style={td}>
                <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
                  <button onClick={async () => {
                    const tempPassword = await onResetPassword(p.id);
                    if (tempPassword) pushToast(`New temp password for ${p.email}: ${tempPassword} (copy it now — this won't be shown again)`, "ok", true);
                  }} style={{ ...miniBtn, fontSize: 10.5 }}>Reset password</button>
                  {p.id === currentUserId
                    ? <span style={{ fontSize: 10.5, color: C.faint }}>Ask another manager to change your own role</span>
                    : (confirmDeleteId === p.id
                        ? <>
                            <button onClick={() => { onDeleteUser(p.id); setConfirmDeleteId(null); }} style={{ ...miniBtn, background: C.red, color: ON_ACCENT, borderColor: C.red }}>Confirm delete</button>
                            <button onClick={() => setConfirmDeleteId(null)} style={miniBtn}>Cancel</button>
                          </>
                        : <button onClick={() => setConfirmDeleteId(p.id)} style={{ ...miniBtn, color: C.red, borderColor: C.red }}>Delete</button>)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showAdd && <AddUserModal onClose={() => setShowAdd(false)} onCreate={async draft => {
        const tempPassword = await onCreateUser(draft);
        if (tempPassword) pushToast(`${draft.email} created — temp password: ${tempPassword} (copy it now — this won't be shown again)`, "ok", true);
        setShowAdd(false);
      }} />}
    </div>
  );
}

function AddUserModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: "", email: "", role: "commercial" });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 360, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Add a teammate</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldSm label="Name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="Email"><input type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="Role">
            <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })} style={inputStyle}>
              {ROLE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </FieldSm>
          <div style={{ fontSize: 10.5, color: C.faint }}>Creates the login directly with a temporary password (no email needs to be configured) — you'll see it once after creating, to relay to them yourself.</div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={miniBtn}>Cancel</button>
          <button disabled={!form.email.trim()} onClick={() => onCreate(form)}
            style={{ ...miniBtn, background: form.email.trim() ? C.amber : C.faint, color: ON_ACCENT, borderColor: form.email.trim() ? C.amber : C.faint, fontWeight: 600 }}>Create</button>
        </div>
      </div>
    </div>
  );
}

// ---------- notifications ----------
function timeAgo(d) {
  const s = Math.max(1, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const NOTIF_COLOR = { flight: C.cyan, allotment: C.green, operator: ACCENT.violet, aircraft: C.amber, info: C.faint };
function NotificationRow({ n }) {
  return (
    <div style={{ padding: "10px 14px", borderBottom: `1px solid ${C.borderSoft}`, display: "flex", gap: 10 }}>
      <div style={{ width: 8, height: 8, borderRadius: 99, background: NOTIF_COLOR[n.kind] || C.faint, marginTop: 4, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, color: C.text, fontWeight: 500 }}>{n.title}</div>
        <div style={{ fontSize: 11, color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.subtitle}</div>
      </div>
      <div style={{ fontSize: 10.5, color: C.faint, flexShrink: 0 }}>{timeAgo(new Date(n.created_at))}</div>
    </div>
  );
}

// ---------- route map — real Leaflet + OpenStreetMap, built from actual current routes ----------
const STATION_LATLNG = {
  AYT: [36.9, 30.8], SSH: [27.9, 34.4], ALA: [43.2, 77.0], NQZ: [51.2, 71.4], SKD: [39.7, 66.9],
  HRI: [6.28, 81.12], HKT: [8.11, 98.32], CXR: [11.99, 109.22], PQC: [10.23, 103.97], SYX: [18.31, 109.41], SIN: [1.36, 103.99],
};
function RouteMap({ flights }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const routes = [...new Map(flights.map(f => [`${f.origin}|${f.destination}`, f])).values()];
  const stations = [...new Set(flights.flatMap(f => [f.origin, f.destination]))].filter(s => STATION_LATLNG[s]);
  const unknownStations = [...new Set(flights.flatMap(f => [f.origin, f.destination]))].filter(s => !STATION_LATLNG[s]);
  const center = stations.length ? STATION_LATLNG[stations[0]] : [30, 60];

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>Route map</div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10.5, color: C.green, fontWeight: 600 }}>
          <span style={{ width: 6, height: 6, borderRadius: 99, background: C.green, display: "inline-block", animation: "pulseDot 1.6s infinite" }} /> LIVE
        </div>
      </div>
      {mounted ? (
        <MapContainer center={center} zoom={4} style={{ width: "100%", height: 380, borderRadius: 10 }} scrollWheelZoom={true}>
          <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          {routes.map((r, i) => {
            const p1 = STATION_LATLNG[r.origin], p2 = STATION_LATLNG[r.destination];
            if (!p1 || !p2) return null;
            return <Polyline key={i} positions={[p1, p2]} pathOptions={{ color: C.amber, weight: 2.5, opacity: 0.85 }} />;
          })}
          {stations.map((s, i) => (
            <CircleMarker key={s} center={STATION_LATLNG[s]} radius={7} pathOptions={{ color: "#FFFFFF", weight: 2, fillColor: i === 0 ? C.green : C.amber, fillOpacity: 1 }}>
              <Popup>{s}</Popup>
            </CircleMarker>
          ))}
        </MapContainer>
      ) : <div style={{ width: "100%", height: 380, borderRadius: 10, background: C.panel2 }} />}
      <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 10.5, color: C.muted, flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 4 }}><span style={{ width: 8, height: 2, background: C.amber, display: "inline-block" }} /> Scheduled route</span>
        <span>{routes.length} active route{routes.length === 1 ? "" : "s"} · {stations.length} stations</span>
        {unknownStations.length > 0 && <span style={{ color: C.faint }}>Not yet plotted: {unknownStations.join(", ")} (add coordinates to STATION_LATLNG)</span>}
      </div>
    </div>
  );
}

function TasksWidget({ tasks, onAddTask, onToggleTask }) {
  const [draft, setDraft] = useState("");
  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Tasks</div>
        <span style={{ fontSize: 11, color: C.faint }}>{tasks.filter(t => !t.done).length} open</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
        {tasks.map(t => (
          <label key={t.id} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <input type="checkbox" checked={t.done} onChange={() => onToggleTask(t.id)} />
            <span style={{ flex: 1, fontSize: 12.5, color: t.done ? C.faint : C.text, textDecoration: t.done ? "line-through" : "none" }}>{t.title}</span>
            <span style={{ fontSize: 10.5, color: C.faint }}>{t.due_label}</span>
          </label>
        ))}
        {tasks.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No tasks yet.</div>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Add a task…" style={{ ...inputStyle, fontSize: 12 }}
          onKeyDown={e => { if (e.key === "Enter" && draft.trim()) { onAddTask(draft.trim()); setDraft(""); } }} />
        <button onClick={() => { if (draft.trim()) { onAddTask(draft.trim()); setDraft(""); } }} style={miniBtn}>Add</button>
      </div>
    </div>
  );
}

// ---------- dashboard ----------
function Dashboard({ flights, allotments, resources, operators, flightInventory, perms, tasks, onAddTask, onToggleTask, notifications, setTab, setSelectedFlightId }) {
  const invs = flights.map(f => ({ f, inv: flightInventory(f.id) }));
  const totalRevenue = invs.reduce((s, x) => s + x.inv.revenue, 0);
  const totalSeatsSold = invs.reduce((s, x) => s + x.inv.allocated, 0);
  const totalCapacity = invs.reduce((s, x) => s + x.inv.capacity, 0);
  const loadFactor = totalCapacity ? Math.round((totalSeatsSold / totalCapacity) * 100) : 0;
  const activeOperators = operators.filter(o => o.status === "active").length;
  const [flightTableTab, setFlightTableTab] = useState("upcoming");
  const upcoming = [...flights].filter(f => f.start >= today).sort((a, b) => a.start - b.start).slice(0, 8);
  const recent = [...flights].filter(f => f.start < today).sort((a, b) => b.start - a.start).slice(0, 8);
  const STATUS_PILL = { tentative: { bg: C.panel2, color: C.muted, label: "Scheduled" }, confirmed: { bg: C.cyanSoft, color: C.cyan, label: "Confirmed" }, operating: { bg: C.greenSoft, color: C.green, label: "Operating" }, cancelled: { bg: C.redSoft, color: C.red, label: "Cancelled" } };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ background: `linear-gradient(120deg, ${SIDEBAR.bg}, #1B2C4D)`, borderRadius: 16, padding: "26px 30px", color: SIDEBAR.text, marginBottom: 18, position: "relative", overflow: "hidden" }}>
        <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>Charter Operations</div>
        <div style={{ fontSize: 13, color: SIDEBAR.muted }}>Plan · Coordinate · Deliver</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 18 }}>
        <KpiCard icon={<IconCalendar />} color={ACCENT.blue} label="Total flights" value={flights.length} sub="On the board" />
        <KpiCard icon={<IconUsers />} color={ACCENT.violet} label="Seats sold" value={totalSeatsSold.toLocaleString()} sub="Active + confirmed" />
        <KpiCard icon={<IconGauge />} color={ACCENT.teal} label="Load factor" value={`${loadFactor}%`} sub="Sold ÷ capacity" />
        <KpiCard icon={<IconBuilding />} color={ACCENT.green} label="Tour operators" value={activeOperators} sub="Active" />
      </div>

      <RouteMap flights={flights} />

      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16, marginTop: 16 }}>
        <div>
          <div style={{ ...card, marginBottom: 16 }}>
            <div style={{ fontFamily: MONO, fontSize: 20, color: C.amber, marginBottom: 4 }}>${totalRevenue.toLocaleString()}</div>
            <div style={cardTitle}>Revenue on board</div>
          </div>
          <div style={card}>
            <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
              {[["upcoming", "Upcoming flights"], ["recent", "Recent flights"], ["aircraft", "Aircraft status"]].map(([k, l]) => (
                <button key={k} onClick={() => setFlightTableTab(k)} style={{ ...miniBtn, background: flightTableTab === k ? C.amberSoft : "transparent", color: flightTableTab === k ? C.amber : C.muted, borderColor: flightTableTab === k ? C.amber : C.border, fontSize: 11.5 }}>{l}</button>
              ))}
            </div>
            {(flightTableTab === "upcoming" || flightTableTab === "recent") && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 10.5, fontWeight: 600 }}>
                  <th style={th}>Date</th><th style={th}>Flight</th><th style={th}>Route</th><th style={th}>Aircraft</th><th style={th}>Status</th>
                </tr></thead>
                <tbody>
                  {(flightTableTab === "upcoming" ? upcoming : recent).map(f => {
                    const res = resources.find(r => r.id === f.resourceId);
                    const pill = STATUS_PILL[f.status] || STATUS_PILL.tentative;
                    return (
                      <tr key={f.id} onClick={() => { setTab("schedule"); setSelectedFlightId(f.id); }} style={{ borderTop: `1px solid ${C.borderSoft}`, cursor: "pointer" }}>
                        <td style={td}>{iso(f.start)}</td>
                        <td style={{ ...td, fontFamily: MONO }}>{f.ref}</td>
                        <td style={td}>{f.origin}–{f.destination}</td>
                        <td style={{ ...td, fontFamily: MONO }}>{res?.code}</td>
                        <td style={td}><Badge color={pill.color} bg={pill.bg}>{pill.label.toUpperCase()}</Badge></td>
                      </tr>
                    );
                  })}
                  {(flightTableTab === "upcoming" ? upcoming : recent).length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: C.faint }}>Nothing here.</td></tr>}
                </tbody>
              </table>
            )}
            {flightTableTab === "aircraft" && (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 10.5, fontWeight: 600 }}><th style={th}>Aircraft</th><th style={th}>Variant</th><th style={th}>Status</th></tr></thead>
                <tbody>{resources.map(r => <tr key={r.id} style={{ borderTop: `1px solid ${C.borderSoft}` }}><td style={{ ...td, fontFamily: MONO }}>{r.code}</td><td style={td}>{r.variant}</td><td style={td}><Badge color={C.green} bg={C.greenSoft}>ACTIVE</Badge></td></tr>)}</tbody>
              </table>
            )}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <TasksWidget tasks={tasks} onAddTask={onAddTask} onToggleTask={onToggleTask} />
          <div style={card}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Recent notifications</div>
            <div style={{ margin: "0 -16px" }}>
              {notifications.slice(0, 5).map(n => <NotificationRow key={n.id} n={n} />)}
              {notifications.length === 0 && <div style={{ padding: "10px 16px", fontSize: 12, color: C.faint }}>Actions across the app will show up here.</div>}
            </div>
          </div>
        </div>
      </div>
      {perms.reports !== "all" && <div style={{ fontSize: 11.5, color: C.faint, marginTop: 14 }}>Showing scope: {perms.reports}. Management sees fleet-wide financials.</div>}
    </div>
  );
}
function KpiCard({ icon, color, label, value, sub }) {
  return (
    <div style={card}>
      <div style={{ width: 34, height: 34, borderRadius: 10, background: color + "1A", color, display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: C.text }}>{value}</div>
      <div style={{ fontSize: 10.5, color: C.faint }}>{sub}</div>
    </div>
  );
}
const card = { background: C.panel, border: `1px solid ${C.borderSoft}`, borderRadius: 14, padding: 16, boxShadow: "0 1px 2px rgba(30,42,61,0.04), 0 8px 20px rgba(30,42,61,0.03)" };
const cardTitle = { fontSize: 11.5, color: C.muted, fontWeight: 600, marginBottom: 6 };

// ---------- Aircraft (fleet management) ----------
function AircraftPanel({ resources, flights, perms, onAddResource, onUpdateResource, onDeleteResource, maintenanceBlocks, onAddMaintenanceBlock, onDeleteMaintenanceBlock }) {
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showAddMaint, setShowAddMaint] = useState(false);
  return (
    <div style={{ padding: 20 }}>
      {perms.editFlight && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <button onClick={() => setShowAdd(true)} style={{ ...miniBtn, background: GRADIENT_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ Add aircraft</button>
        </div>
      )}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600, background: C.panel2 }}>
            <th style={th}>Registration</th><th style={th}>Variant</th><th style={th}>Capacity</th><th style={th}>Flights on board</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {resources.map(r => (
              <tr key={r.id} style={{ borderTop: `1px solid ${C.borderSoft}` }}>
                <td style={{ ...td, fontFamily: MONO, fontWeight: 600 }}>{r.code}</td>
                <td style={td}>{perms.editFlight ? <input value={r.variant} onChange={e => onUpdateResource(r.id, { variant: e.target.value })} style={{ ...inputStyle, width: 160 }} /> : r.variant}</td>
                <td style={td}>{perms.editFlight ? <input type="number" value={r.capacity} onChange={e => onUpdateResource(r.id, { capacity: +e.target.value })} style={{ ...inputStyle, width: 80 }} /> : r.capacity}</td>
                <td style={td}>{flights.filter(f => f.resourceId === r.id).length}</td>
                <td style={td}>
                  {perms.editFlight && confirmDeleteId !== r.id && <button onClick={() => setConfirmDeleteId(r.id)} style={{ ...miniBtn, color: C.red, borderColor: C.red }}>Remove</button>}
                  {perms.editFlight && confirmDeleteId === r.id && <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { onDeleteResource(r.id); setConfirmDeleteId(null); }} style={{ ...miniBtn, background: C.red, color: ON_ACCENT, borderColor: C.red }}>Confirm</button>
                    <button onClick={() => setConfirmDeleteId(null)} style={miniBtn}>Cancel</button>
                  </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, marginBottom: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Maintenance schedule</div>
        {perms.editFlight && <button onClick={() => setShowAddMaint(true)} style={{ ...miniBtn, fontWeight: 600 }}>+ Add block</button>}
      </div>
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 11, fontWeight: 600, background: C.panel2 }}>
            <th style={th}>Aircraft</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Reason</th><th style={th}></th>
          </tr></thead>
          <tbody>
            {[...maintenanceBlocks].sort((a, b) => a.start - b.start).map(m => {
              const r = resources.find(x => x.id === m.resourceId);
              const isPast = m.end < new Date();
              return (
                <tr key={m.id} style={{ borderTop: `1px solid ${C.borderSoft}`, opacity: isPast ? 0.5 : 1 }}>
                  <td style={{ ...td, fontFamily: MONO, fontWeight: 600 }}>{r?.code || "—"}</td>
                  <td style={{ ...td, fontFamily: MONO }}>{iso(m.start)}</td>
                  <td style={{ ...td, fontFamily: MONO }}>{iso(m.end)}</td>
                  <td style={td}>{m.reason || "—"}</td>
                  <td style={td}>{perms.editFlight && <button onClick={() => onDeleteMaintenanceBlock(m.id)} style={{ ...miniBtn, color: C.red, borderColor: C.red }}>Remove</button>}</td>
                </tr>
              );
            })}
            {maintenanceBlocks.length === 0 && <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: C.faint, padding: 20 }}>No maintenance blocks scheduled. Aircraft here are treated as available every day.</td></tr>}
          </tbody>
        </table>
      </div>

      {showAdd && <AddAircraftModal onClose={() => setShowAdd(false)} onCreate={r => { onAddResource(r); setShowAdd(false); }} />}
      {showAddMaint && <AddMaintenanceModal resources={resources} onClose={() => setShowAddMaint(false)} onCreate={(resourceId, start, end, reason) => { onAddMaintenanceBlock(resourceId, start, end, reason); setShowAddMaint(false); }} />}
    </div>
  );
}
function AddMaintenanceModal({ resources, onClose, onCreate }) {
  const [form, setForm] = useState({ resourceId: resources[0]?.id, startDate: iso(addDays(today, 1)), endDate: iso(addDays(today, 3)), reason: "" });
  const valid = form.resourceId && form.startDate && form.endDate && form.startDate <= form.endDate;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 380, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Add maintenance block</div>
        <div style={{ fontSize: 11, color: C.faint, marginBottom: 14 }}>This aircraft is treated as unavailable for the whole span, inclusive of both dates — the scheduling engine and conflict checks respect it.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldSm label="Aircraft">
            <select value={form.resourceId} onChange={e => setForm({ ...form, resourceId: e.target.value })} style={inputStyle}>
              {resources.map(r => <option key={r.id} value={r.id}>{r.code} · {r.variant}</option>)}
            </select>
          </FieldSm>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <FieldSm label="From"><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="To"><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} style={inputStyle} /></FieldSm>
          </div>
          <FieldSm label="Reason (optional)"><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="C-check, AOG repair, …" style={inputStyle} /></FieldSm>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={miniBtn}>Cancel</button>
          <button disabled={!valid} onClick={() => onCreate(form.resourceId, new Date(form.startDate), addDays(new Date(form.endDate), 1), form.reason)} style={{ ...miniBtn, background: valid ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: valid ? C.amber : C.faint, fontWeight: 600 }}>Add block</button>
        </div>
      </div>
    </div>
  );
}
function AddAircraftModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ code: "", variant: "", capacity: 189 });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 340, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Add aircraft</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldSm label="Registration"><input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
          <FieldSm label="Variant"><input value={form.variant} onChange={e => setForm({ ...form, variant: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="Capacity"><input type="number" value={form.capacity} onChange={e => setForm({ ...form, capacity: +e.target.value })} style={inputStyle} /></FieldSm>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={miniBtn}>Cancel</button>
          <button disabled={!form.code.trim()} onClick={() => onCreate(form)} style={{ ...miniBtn, background: form.code.trim() ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Add</button>
        </div>
      </div>
    </div>
  );
}
