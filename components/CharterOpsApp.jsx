"use client";
import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "../lib/supabaseClient";
import "leaflet/dist/leaflet.css";

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

function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
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
function padFlightNo(ref) { return (ref || "").replace(/^[A-Z]+/, ""); }

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
function hhmm(dateStr) { if (!dateStr) return null; const d = new Date(dateStr); return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0"); }
function combineDateAndTime(baseDate, hhmmStr) {
  if (!hhmmStr) return null;
  const [h, m] = hhmmStr.split(":").map(Number);
  const d = new Date(baseDate);
  d.setUTCHours(h, m, 0, 0);
  return d;
}
// ---------- minutes-of-day helpers (drag/drop targeting + duration-based bar sizing) ----------
function timeToMinutes(hhmmStr) { if (!hhmmStr) return null; const [h, m] = hhmmStr.split(":").map(Number); return h * 60 + m; }
function minutesToHHMM(min) { min = ((min % 1440) + 1440) % 1440; const h = Math.floor(min / 60), m = min % 60; return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"); }
function flightGeometry(f) {
  const dep = timeToMinutes(f.depTime);
  if (dep == null) return { offsetFrac: 0, widthFrac: 1 };
  const arr = timeToMinutes(f.arrTime);
  let dur = arr != null ? arr - dep : 90;
  if (dur <= 0) dur += 1440;
  return { offsetFrac: dep / 1440, widthFrac: dur / 1440 };
}
const FLIGHT_COLORS = ["#FF6B4A", "#0F9B8E", "#1E9E5A", "#D6432E", "#7C6FD1", "#B8860B", "#3B7DD8", "#C2437E"];
function mapFlight(f) { return { id: f.id, ref: f.ref, resourceId: f.resource_id, origin: f.origin, destination: f.destination, start: new Date(f.scheduled_departure), capacity: f.capacity, status: f.status, legType: f.leg_type, version: f.version, depTime: hhmm(f.scheduled_departure), arrTime: hhmm(f.scheduled_arrival), color: f.color || null }; }
function mapAllotment(a) { return { id: a.id, flightId: a.flight_id, operatorId: a.tour_operator_id, contractId: a.contract_id, seatsAllocated: a.seats_allocated, pricePerSeat: Number(a.price_per_seat), allotmentType: a.allotment_type, optionReleaseAt: a.option_release_at ? new Date(a.option_release_at) : null, status: a.status }; }
function mapOperator(o, contract) {
  return {
    id: o.id, name: o.name, country: o.country, status: o.status,
    contractId: contract?.id ?? null,
    defaultRate: contract ? Number(contract.rate_per_seat) : 0,
    ratesByDestination: Object.fromEntries(Object.entries(contract?.rates_by_destination || {}).map(([k, v]) => [k, Number(v)])),
    allotmentType: contract?.default_allotment_type ?? "fixed",
    optionReleaseDays: contract?.default_option_release_days ?? null,
  };
}
function rateFor(op, destination) { return op?.ratesByDestination?.[destination] ?? op?.defaultRate ?? 0; }

async function fetchAll() {
  const [{ data: resources }, { data: flights }, { data: operators }, { data: contracts }, { data: allotments }, { data: tzCache }, { data: profiles }, { data: tasks }, { data: notifications }] = await Promise.all([
    supabase.from("resources").select("*").order("code"),
    supabase.from("flights").select("*").order("scheduled_departure"),
    supabase.from("tour_operators").select("*").order("name"),
    supabase.from("contracts").select("*"),
    supabase.from("allotments").select("*"),
    supabase.from("station_timezones").select("*"),
    supabase.from("profiles").select("*").order("name"),
    supabase.from("tasks").select("*").order("created_at"),
    supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(30),
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
  };
}

// ---------- atoms ----------
function Badge({ children, color, bg = "transparent" }) {
  return <span style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 0.3, padding: "2px 7px", borderRadius: 12, color, background: bg, border: `1px solid ${color}55`, whiteSpace: "nowrap" }}>{children}</span>;
}
function Toast({ items, onDismiss }) {
  return <div style={{ position: "fixed", bottom: 18, right: 18, display: "flex", flexDirection: "column", gap: 8, zIndex: 100 }}>
    {items.map(t => (
      <div key={t.id} style={{ background: C.panel, border: `1px solid ${t.tone === "warn" ? C.red : C.cyan}55`, borderLeft: `3px solid ${t.tone === "warn" ? C.red : C.cyan}`, color: C.text, fontFamily: SANS, fontSize: 13, padding: "10px 14px", borderRadius: 10, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", minWidth: 260, maxWidth: 380, animation: "slideIn 0.25s ease-out", display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span style={{ flex: 1 }}>{t.msg}</span>
        <button onClick={() => onDismiss(t.id)} style={{ background: "none", border: "none", color: C.faint, cursor: "pointer", padding: 0, fontSize: 15, lineHeight: 1, flexShrink: 0 }}>×</button>
      </div>
    ))}
  </div>;
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

export default function CharterOpsApp({ profile, onSignOut }) {
  const role = profile.role;
  const [tab, setTab] = useState("schedule");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showLocal, setShowLocal] = useState(false);
  const [viewMode, setViewMode] = useState("week"); // "day" | "week" | "month" | "period"
  const [periodDays, setPeriodDays] = useState(90); // custom span when viewMode === "period"
  const [viewStart, setViewStart] = useState(addDays(today, -1));
  const VIEW_MODE_DAYS = { day: 1, week: 7, month: 30 };
  const DAYS = viewMode === "period" ? periodDays : VIEW_MODE_DAYS[viewMode];

  const [loaded, setLoaded] = useState(false);
  const [resources, setResources] = useState([]);
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

  // initial load, straight from Supabase — everyone hitting this deployment reads the same rows.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { resources, flights, operators, allotments, profiles, tasks, notifications } = await fetchAll();
      if (cancelled) return;
      setResources(resources); setFlightsRaw(flights); setOperatorsRaw(operators); setAllotmentsRaw(allotments); setProfiles(profiles);
      setTasks(tasks); setNotifications(notifications);
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

  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(viewStart, i)), [viewStart, DAYS]);

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
    const before = flightInventory(flightId);
    const current = flights.find(f => f.id === flightId);
    const dbPatch = {};
    if (patch.start) dbPatch.scheduled_departure = patch.start.toISOString();
    if (patch.resourceId) dbPatch.resource_id = patch.resourceId;
    if (patch.capacity) dbPatch.capacity = patch.capacity;
    if ("color" in patch) dbPatch.color = patch.color;
    // depTime/arrTime are HH:mm strings from the drawer's time inputs — combine them with the
    // flight's existing date rather than overwriting it, since only the time-of-day changed.
    if (patch.depTime !== undefined) dbPatch.scheduled_departure = combineDateAndTime(patch.start || current.start, patch.depTime)?.toISOString() ?? dbPatch.scheduled_departure;
    if (patch.arrTime !== undefined) dbPatch.scheduled_arrival = combineDateAndTime(patch.start || current.start, patch.arrTime)?.toISOString() ?? null;
    const { error } = await supabase.from("flights").update(dbPatch).eq("id", flightId);
    if (error) { pushToast(`Update failed: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => fl.map(f => f.id === flightId ? { ...f, ...patch } : f));
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
  async function deleteFlight(flightId) {
    if (!perms.editFlight) return;
    const flight = flights.find(f => f.id === flightId);
    const affected = allotments.filter(a => a.flightId === flightId && a.status !== "cancelled" && a.status !== "released").length;
    const { error } = await supabase.from("flights").delete().eq("id", flightId);
    if (error) { pushToast(`Could not delete flight: ${error.message}`, "warn"); return; }
    setFlightsRaw(fl => fl.filter(f => f.id !== flightId));
    setAllotmentsRaw(as => as.filter(a => a.flightId !== flightId));
    if (selectedFlightId === flightId) setSelectedFlightId(null);
    pushToast(`${flight?.ref || "Flight"} deleted${affected ? ` — ${affected} active allotment${affected === 1 ? "" : "s"} removed with it` : ""}`, affected ? "warn" : "ok");
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

  // Drag a flight bar from one aircraft's row to another (or to a different day/time on the
  // same row). Duration is preserved so arrival moves with departure. Opens the drawer
  // afterward so the move can be double-checked, not just trusted.
  async function dropFlight(flightId, newResourceId, newStart, newDepTime) {
    if (!perms.editFlight) return;
    const f = flights.find(x => x.id === flightId);
    if (!f) return;
    const dep = timeToMinutes(f.depTime), arr = timeToMinutes(f.arrTime);
    const durMin = (dep != null && arr != null) ? ((arr - dep + 1440) % 1440) : null;
    const newDepMin = timeToMinutes(newDepTime);
    const newArrTime = (durMin != null && newDepMin != null) ? minutesToHHMM(newDepMin + durMin) : f.arrTime;
    const conflict = checkConflict(newResourceId, newStart, flightId);
    await updateFlight(flightId, { resourceId: newResourceId, start: newStart, depTime: newDepTime, arrTime: newArrTime });
    setSelectedFlightId(flightId);
    if (conflict) pushToast(`${f.ref} moved — heads up: ${resources.find(r => r.id === newResourceId)?.code} already has ${conflict.ref} that day`, "warn");
    else pushToast(`${f.ref} moved — double-check the details below`, "ok");
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
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showRotationGen, setShowRotationGen] = useState(false);
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
    const conflict = checkConflict(draft.resourceId, draft.start, null);
    if (conflict && !draft.force) {
      pushToast(`Conflict: ${resources.find(r=>r.id===draft.resourceId)?.code} already flies ${conflict.ref} that day — check "insert anyway" to override`, "warn");
      return false;
    }
    const ref = draft.ref || ("DV" + (4520 + flights.length + Math.floor(Math.random() * 50)));
    const { data, error } = await supabase.from("flights").insert({
      ref, resource_id: draft.resourceId, origin: draft.origin, destination: draft.destination,
      scheduled_departure: (combineDateAndTime(draft.start, draft.depTime) || draft.start).toISOString(),
      scheduled_arrival: combineDateAndTime(draft.start, draft.arrTime)?.toISOString() ?? null,
      capacity: draft.capacity, status: "tentative",
    }).select().single();
    if (error) { pushToast(`Insert failed: ${error.message}`, "warn"); return false; }
    const newFlight = mapFlight(data);
    setFlightsRaw(fl => [...fl, newFlight]);
    pushToast(`${ref} inserted onto the board${conflict ? " (conflict overridden)" : ""} — slot request drafts ready in its flight info`, conflict ? "warn" : "ok");
    pushNotification("Flight added", `${ref} · ${draft.origin}→${draft.destination}`, "flight");
    setShowAddFlight(false);
    setSelectedFlightId(newFlight.id); // opens the drawer straight away — slot-request buttons are right there
    return true;
  }

  async function commitBulkRows(rows) {
    const inserts = rows.map((r, i) => ({
      resource_id: r.resourceId, origin: r.origin, destination: r.destination,
      scheduled_departure: (combineDateAndTime(r.date, r.depTime) || r.date).toISOString(),
      scheduled_arrival: combineDateAndTime(r.date, r.arrTime)?.toISOString() ?? null,
      capacity: resources.find(res => res.id === r.resourceId)?.capacity,
      status: "tentative", ref: r.flightNo ? "DV" + r.flightNo : ("DV" + (4600 + i)), leg_type: r.legType || "revenue",
    }));
    const { data, error } = await supabase.from("flights").insert(inserts).select();
    if (error) { pushToast(`Import failed: ${error.message}`, "warn"); return; }
    const newFlights = (data || []).map(mapFlight);
    setFlightsRaw(fl => [...fl, ...newFlights]);
    const ferryCount = newFlights.filter(f => f.legType === "ferry").length;
    pushToast(`Imported ${newFlights.length} flight${newFlights.length === 1 ? "" : "s"}${ferryCount ? ` (${ferryCount} ferry/positioning, excluded from inventory)` : ""} — SCR draft ready below`, "ok");
    pushNotification("Schedule update", `${newFlights.length} flights imported`, "flight");
    setShowBulkImport(false);
    openSCR(newFlights.filter(f => f.legType !== "ferry"), "destination"); // ferry legs aren't commercial — no slot request needed for them
  }

  async function commitRotationDates(rows, pattern) {
    const inserts = rows.map(r => ({
      resource_id: pattern.resourceId, origin: r.origin, destination: r.destination,
      scheduled_departure: (combineDateAndTime(r.date, r.depTime) || r.date).toISOString(),
      scheduled_arrival: combineDateAndTime(r.date, r.arrTime)?.toISOString() ?? null,
      capacity: pattern.capacity, status: "tentative", ref: r.ref,
    }));
    const { data, error } = await supabase.from("flights").insert(inserts).select();
    if (error) { pushToast(`Rotation commit failed: ${error.message}`, "warn"); return; }
    const newFlights = (data || []).map(mapFlight);
    setFlightsRaw(fl => [...fl, ...newFlights]);
    pushToast(`Generated ${newFlights.length} flights from rotation pattern (${pattern.origin}⇄${pattern.destination})${pattern.includeReturn ? " — outbound + return" : ""} — SCR draft ready below`, "ok");
    pushNotification("Rotation generated", `${newFlights.length} flights · ${pattern.origin}⇄${pattern.destination}`, "flight");
    setShowRotationGen(false);
    openSCR(newFlights, "destination");
  }

  const NAV_ITEMS = [
    ["dashboard", "Dashboard", IconChart],
    ["schedule", "Schedule", IconCalendar],
    ["aircraft", "Aircraft", IconPlane],
    ["quotas", "Quotas", IconGauge],
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
        .leaflet-container { border-radius: 10px; }
      `}</style>

      {!loaded ? (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: C.muted, fontFamily: MONO, fontSize: 13 }}>
          Loading shared schedule…
        </div>
      ) : (
      <>
      <aside style={{ width: sidebarCollapsed ? 64 : 232, flexShrink: 0, display: "flex", flexDirection: "column", background: SIDEBAR.bg, padding: sidebarCollapsed ? "18px 8px" : "18px 12px", position: "relative", transition: "width 0.15s ease, padding 0.15s ease" }}>
        <button onClick={() => setSidebarCollapsed(v => !v)} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          style={{ position: "absolute", top: 20, right: -11, width: 22, height: 22, borderRadius: 999, border: `1px solid ${SIDEBAR.border}`, background: SIDEBAR.bgActive, color: SIDEBAR.muted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, padding: 0, zIndex: 5 }}>
          {sidebarCollapsed ? "›" : "‹"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: sidebarCollapsed ? "0" : "0 8px", marginBottom: 26, justifyContent: sidebarCollapsed ? "center" : "flex-start" }}>
          <span style={{ color: C.amber }}><IconPlaneLogo /></span>
          {!sidebarCollapsed && <div style={{ fontFamily: SANS, fontWeight: 700, letterSpacing: 0.2, fontSize: 14, color: SIDEBAR.text, whiteSpace: "nowrap" }}>CHARTER OPS</div>}
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
          {NAV_ITEMS.map(([k, l, Icon]) => (
            <button key={k} className="sidebar-nav-item" onClick={() => setTab(k)} title={sidebarCollapsed ? l : undefined}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: sidebarCollapsed ? "9px 0" : "9px 10px", justifyContent: sidebarCollapsed ? "center" : "flex-start", borderRadius: 8, border: "none",
                background: tab === k ? SIDEBAR.bgActive : "transparent", color: tab === k ? SIDEBAR.text : SIDEBAR.muted,
                fontSize: 13, fontWeight: tab === k ? 600 : 500, cursor: "pointer", fontFamily: SANS, textAlign: "left", width: "100%" }}>
              <Icon /> {!sidebarCollapsed && l}
            </button>
          ))}
        </nav>
        <div style={{ borderTop: `1px solid ${SIDEBAR.border}`, paddingTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: sidebarCollapsed ? "0" : "0 10px", justifyContent: sidebarCollapsed ? "center" : "flex-start", fontFamily: SANS, fontWeight: 500, fontSize: 11.5, color: live ? C.green : SIDEBAR.muted }} title="Synced live via Supabase Realtime">
            <span style={{ width: 7, height: 7, borderRadius: 99, background: live ? C.green : SIDEBAR.muted, display: "inline-block", animation: live ? "pulseDot 1.6s infinite" : "none", flexShrink: 0 }} />
            {!sidebarCollapsed && (live ? "Synced" : "Offline")}
          </div>
          {!sidebarCollapsed && (
            <div style={{ padding: "0 10px", fontSize: 12, color: SIDEBAR.text, lineHeight: 1.4 }}>
              {profile.name}<br /><span style={{ color: SIDEBAR.muted, fontSize: 11 }}>{ROLES[role]?.label}</span>
            </div>
          )}
          <button onClick={onSignOut} title={sidebarCollapsed ? "Sign out" : undefined} style={{ ...miniBtn, width: "100%", background: SIDEBAR.bgActive, color: SIDEBAR.text, borderColor: SIDEBAR.border }}>{sidebarCollapsed ? "⏻" : "Sign out"}</button>
        </div>
      </aside>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", borderBottom: `1px solid ${C.borderSoft}`, background: C.panel, position: "relative" }}>
        <div style={{ position: "relative", width: 320 }}>
          <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: C.faint }}><IconSearch /></span>
          <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search flights, routes, operators…"
            style={{ ...inputStyle, paddingLeft: 36, background: C.panel2, border: `1px solid ${C.borderSoft}` }} />
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
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ position: "relative" }}>
            <button onClick={() => setShowNotifPanel(v => !v)} style={{ ...miniBtn, position: "relative", padding: 8, borderRadius: 999 }}>
              <IconBell />
              {notifications.length > 0 && <span style={{ position: "absolute", top: 2, right: 2, width: 7, height: 7, borderRadius: 99, background: C.red }} />}
            </button>
            {showNotifPanel && (
              <div style={{ position: "absolute", top: "calc(100% + 8px)", right: 0, width: 300, background: C.panel, border: `1px solid ${C.border}`, borderRadius: 10, boxShadow: "0 12px 32px rgba(30,42,61,0.14)", zIndex: 50, maxHeight: 320, overflow: "auto" }}>
                <div style={{ padding: "10px 14px", fontSize: 12, fontWeight: 600, borderBottom: `1px solid ${C.borderSoft}` }}>Notifications</div>
                {notifications.length === 0 && <div style={{ padding: 16, fontSize: 12, color: C.faint }}>Nothing yet — actions across the app show up here.</div>}
                {notifications.map(n => <NotificationRow key={n.id} n={n} />)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 30, height: 30, borderRadius: 999, background: C.amberSoft, color: C.amber, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700 }}>{(profile.name || "U")[0].toUpperCase()}</div>
            <div style={{ lineHeight: 1.3 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text }}>{profile.name}</div>
              <div style={{ fontSize: 10.5, color: C.faint }}>{new Date().toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, overflow: "auto" }}>
      {tab === "schedule" && (
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ flex: 1, overflow: "auto" }}>
            <ScheduleBoard resources={resources} flights={flights} days={days} viewStart={viewStart} setViewStart={setViewStart}
              viewMode={viewMode} setViewMode={setViewMode} periodDays={periodDays} setPeriodDays={setPeriodDays} DAYS={DAYS}
              showLocal={showLocal} setShowLocal={setShowLocal} onDropFlight={dropFlight}
              selectedFlightId={selectedFlightId} setSelectedFlightId={setSelectedFlightId} flightInventory={flightInventory}
              perms={perms} onNewFlight={() => setShowAddFlight(true)} onBulkImport={() => setShowBulkImport(true)} onRotationGen={() => setShowRotationGen(true)}
              onBulkRetime={() => setShowBulkRetime(true)} onBulkDelete={() => setShowBulkDelete(true)} onGenSCR={() => openSCR(null, null)} />
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
        onAddOperator={addOperator} onBulkImportOperators={commitBulkOperators} onDeleteOperator={deleteOperator} />}
      {tab === "team" && perms.manageUsers && <TeamPanel profiles={profiles} currentUserId={profile.id} onUpdateRole={updateUserRole} onCreateUser={createTeamUser} onDeleteUser={deleteTeamUser} onResetPassword={resetTeamUserPassword} pushToast={pushToast} />}
      {tab === "dashboard" && <Dashboard flights={flights} allotments={allotments} resources={resources} operators={operators} flightInventory={flightInventory} perms={perms}
        tasks={tasks} onAddTask={addTask} onToggleTask={toggleTask} notifications={notifications} setTab={setTab} setSelectedFlightId={setSelectedFlightId} />}
      {tab === "aircraft" && <AircraftPanel resources={resources} flights={flights} perms={perms} onAddResource={addResource} onUpdateResource={updateResource} onDeleteResource={deleteResource} />}
      {tab === "quotas" && <QuotasPanel operators={operators} allotments={allotments} flights={flights} />}
      </div>

      {showAddFlight && <AddFlightModal resources={resources} onClose={() => setShowAddFlight(false)} onCreate={insertSingleFlight} checkConflict={checkConflict} />}
      {showBulkImport && <BulkImportModal resources={resources} flights={flights} onClose={() => setShowBulkImport(false)} onCommit={commitBulkRows} />}
      {showRotationGen && <RotationGenModal resources={resources} flights={flights} onClose={() => setShowRotationGen(false)} onCommit={commitRotationDates} />}
      {showBulkRetime && <BulkRetimeModal resources={resources} flights={flights} onClose={() => setShowBulkRetime(false)} onCommit={bulkRetime} />}
      {showBulkDelete && <BulkDeleteModal resources={resources} flights={flights} allotments={allotments} onClose={() => setShowBulkDelete(false)} onCommit={bulkDeleteFlights} />}
      {showSCR && <SCRModal resources={resources} flights={flights} onClose={() => { setShowSCR(false); setScrSeed(null); }} seedFlights={scrSeed?.flights} seedRole={scrSeed?.role} />}
      </div>
      </>
      )}
      <Toast items={toasts} onDismiss={dismissToast} />
    </div>
  );
}

// ---------- schedule board ----------
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21]; // every 3h — labeled 0000/0300/.../2100, always UTC
function hourTickLabel(h) { return String(h).padStart(2, "0") + "00"; }
function ScheduleBoard({ resources, flights, days, viewStart, setViewStart, selectedFlightId, setSelectedFlightId, flightInventory, perms, onNewFlight, onBulkImport, onRotationGen, showLocal, setShowLocal, onDropFlight, onBulkRetime, onBulkDelete, onGenSCR, viewMode, setViewMode, periodDays, setPeriodDays, DAYS }) {
  const COL = viewMode === "day" ? 720 : viewMode === "week" ? 216 : viewMode === "month" ? 64 : 36;
  const LABELW = 160;
  const showHourTicks = viewMode === "day" || viewMode === "week";
  const TICK = COL / HOUR_TICKS.length;
  function colFor(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return Math.round((x.getTime() - viewStart.getTime()) / 86400000); }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <div style={{ display: "flex", gap: 2, background: C.panel2, borderRadius: 999, padding: 3 }}>
            {[["day", "Day"], ["week", "Week"], ["month", "Month"], ["period", "Period"]].map(([k, l]) => (
              <button key={k} onClick={() => setViewMode(k)} style={{ background: viewMode === k ? C.panel : "transparent", color: viewMode === k ? C.text : C.muted, border: "none", borderRadius: 999, padding: "6px 12px", fontSize: 12, fontWeight: viewMode === k ? 600 : 500, cursor: "pointer", fontFamily: SANS, boxShadow: viewMode === k ? "0 1px 3px rgba(58,54,47,0.10)" : "none" }}>{l}</button>
            ))}
          </div>
          {viewMode === "period" && (
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <input type="number" value={periodDays} min={1} max={365} onChange={e => setPeriodDays(Math.max(1, +e.target.value))} style={{ ...inputStyle, width: 60, padding: "6px 8px" }} />
              <span style={{ fontSize: 11.5, color: C.muted }}>days</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => setShowLocal(v => !v)} title="Times are always stored in UTC — this only changes the display" style={{ ...navBtn, background: showLocal ? C.cyanSoft : "transparent", borderColor: showLocal ? C.cyan : C.border, color: showLocal ? C.cyan : C.text }}>
            {showLocal ? "Local time" : "UTC"}
          </button>
          {perms.editFlight && <button onClick={onRotationGen} style={navBtn}>Generate rotation</button>}
          {perms.editFlight && <button onClick={onBulkRetime} style={navBtn}>Bulk retime</button>}
          {perms.editFlight && <button onClick={onBulkDelete} style={{ ...navBtn, color: C.red, borderColor: C.red + "55" }}>Bulk delete</button>}
          <button onClick={onGenSCR} style={navBtn}>Generate SCR</button>
          {perms.editFlight && <button onClick={onBulkImport} style={navBtn}>Bulk import</button>}
          {perms.editFlight && <button onClick={onNewFlight} style={{ ...navBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ New flight</button>}
          <button onClick={() => setViewStart(addDays(viewStart, -DAYS))} style={navBtn}>◀</button>
          <button onClick={() => { const t = new Date(); t.setUTCHours(0, 0, 0, 0); setViewStart(addDays(t, -1)); }} style={navBtn}>Today</button>
          <button onClick={() => setViewStart(addDays(viewStart, DAYS))} style={navBtn}>▶</button>
        </div>
      </div>
      {showLocal && <div style={{ fontSize: 11, color: C.faint, marginTop: -6, marginBottom: 10 }}>Showing each flight's departure/arrival in its own station's local time. "?" means that station isn't in the timezone table yet.</div>}

      <div style={{ overflowX: "auto", border: `1px solid ${C.border}`, borderRadius: 12 }}>
        <div style={{ minWidth: LABELW + days.length * COL }}>
          <div style={{ display: "flex", background: C.panel2, borderBottom: `1px solid ${C.border}`, flexDirection: "column" }}>
            <div style={{ display: "flex" }}>
              <div style={{ width: LABELW, flexShrink: 0, padding: "8px 12px", fontSize: 11, color: C.faint, fontFamily: MONO }}>RESOURCE</div>
              {days.map((d, i) => {
                const isToday = iso(d) === iso(new Date());
                return <div key={i} style={{ width: COL, flexShrink: 0, textAlign: "center", padding: "8px 0 2px", fontSize: 11, fontFamily: MONO, color: isToday ? C.amber : C.muted, borderLeft: `1px solid ${C.borderSoft}`, background: isToday ? C.amberSoft + "55" : "transparent" }}>
                  <div>{d.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })}</div>
                  <div style={{ color: isToday ? C.amber : C.faint }}>{d.getUTCDate()}/{d.getUTCMonth() + 1}</div>
                </div>;
              })}
            </div>
            {showHourTicks && (
              <div style={{ display: "flex", borderTop: `1px solid ${C.borderSoft}` }}>
                <div style={{ width: LABELW, flexShrink: 0 }} />
                {days.map((d, i) => (
                  <div key={i} style={{ width: COL, flexShrink: 0, display: "flex", borderLeft: `1px solid ${C.borderSoft}` }}>
                    {HOUR_TICKS.map(h => (
                      <div key={h} style={{ width: TICK, flexShrink: 0, textAlign: "left", paddingLeft: 2, fontFamily: MONO, fontSize: 7.5, color: C.faint, borderLeft: h === 0 ? "none" : `1px solid ${C.borderSoft}` }}>{hourTickLabel(h)}</div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          {resources.map(res => (
            <div key={res.id} style={{ display: "flex", borderBottom: `1px solid ${C.borderSoft}`, position: "relative", minHeight: 58 }}>
              <div style={{ width: LABELW, flexShrink: 0, padding: "8px 12px", display: "flex", flexDirection: "column", justifyContent: "center", borderRight: `1px solid ${C.border}`, background: C.panel2 }}>
                <div style={{ fontFamily: MONO, fontSize: 12.5, color: C.text }}>{res.code}</div>
                <div style={{ fontSize: 10.5, color: C.muted }}>{res.variant}</div>
              </div>
              <div style={{ position: "relative", display: "flex" }}
                onDragOver={e => { if (perms.editFlight) e.preventDefault(); }}
                onDrop={e => {
                  if (!perms.editFlight) return;
                  e.preventDefault();
                  const flightId = e.dataTransfer.getData("text/flight-id");
                  if (!flightId) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const relX = e.clientX - rect.left;
                  const totalDayFloat = relX / COL;
                  const dayIndex = Math.floor(totalDayFloat);
                  const hourFrac = Math.max(0, totalDayFloat - dayIndex);
                  const newStart = addDays(viewStart, dayIndex);
                  const depMinutes = Math.round((hourFrac * 1440) / 15) * 15;
                  onDropFlight(flightId, res.id, newStart, minutesToHHMM(depMinutes));
                }}>
                {days.map((d, i) => <div key={i} style={{ width: COL, flexShrink: 0, borderLeft: `1px solid ${C.borderSoft}`, height: 58, backgroundImage: `repeating-linear-gradient(to right, transparent, transparent ${TICK - 1}px, ${C.borderSoft} ${TICK - 1}px, ${C.borderSoft} ${TICK}px)` }} />)}
                {flights.filter(f => f.resourceId === res.id).map(f => {
                  const c = colFor(f.start);
                  if (c < 0 || c >= days.length) return null;
                  const isFerry = f.legType === "ferry";
                  const s = STATUS_STYLE[f.status];
                  const selected = f.id === selectedFlightId;
                  const geom = flightGeometry(f);
                  const leftPx = c * COL + geom.offsetFrac * COL + 3;
                  const widthPx = Math.max(geom.widthFrac * COL - 6, 34);
                  const barBg = isFerry ? "repeating-linear-gradient(45deg, rgba(58,54,47,0.03), rgba(58,54,47,0.03) 5px, rgba(58,54,47,0.07) 5px, rgba(58,54,47,0.07) 10px)" : (f.color ? f.color + "70" : s.bg);
                  const barBorder = selected ? C.amber : (f.color || (isFerry ? C.faint : s.border));
                  const refColor = f.color || (isFerry ? C.muted : s.text);
                  return (
                    <div key={f.id} draggable={perms.editFlight}
                      onDragStart={e => e.dataTransfer.setData("text/flight-id", f.id)}
                      onClick={() => setSelectedFlightId(selected ? null : f.id)}
                      title={`${f.ref} · ${f.origin}→${f.destination}${f.depTime ? ` · ${f.depTime}–${f.arrTime || "?"}` : ""}${isFerry ? " · ferry/positioning" : ""}${perms.editFlight ? " · drag to reassign" : ""}`}
                      style={{ position: "absolute", left: leftPx, top: 12, width: widthPx, height: 30,
                        background: barBg,
                        border: `1.5px ${isFerry ? "dashed" : (s.dash ? "dashed" : "solid")} ${barBorder}`,
                        borderRadius: 7, cursor: perms.editFlight ? "grab" : "pointer", boxShadow: selected ? `0 0 0 2px ${C.amber}55` : "none", overflow: "hidden", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 6px" }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: refColor, fontWeight: 700, whiteSpace: "nowrap" }}>{f.ref}</span>
                        {f.depTime && <span style={{ fontFamily: MONO, fontSize: 8.5, color: refColor, whiteSpace: "nowrap" }}>{formatStationTime(f.start, f.depTime, f.origin, showLocal)}</span>}
                        <span style={{ fontSize: 9, color: refColor, opacity: 0.75 }}>→</span>
                        {f.arrTime && <span style={{ fontFamily: MONO, fontSize: 8.5, color: refColor, whiteSpace: "nowrap" }}>{formatStationTime(f.start, f.arrTime, f.destination, showLocal)}</span>}
                      </div>
                      <div style={{ fontSize: 9, color: refColor, opacity: 0.8, whiteSpace: "nowrap", overflow: "hidden" }}>{f.origin}→{f.destination}{isFerry ? " · FERRY" : ""}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", gap: 16, marginTop: 12, fontSize: 11, color: C.muted, flexWrap: "wrap" }}>
        <LegendSwatch color={C.green} label="Healthy fill" />
        <LegendSwatch color={C.amber} label="Near full (≥92%)" />
        <LegendSwatch color={C.red} label="Oversold" />
      </div>
    </div>
  );
}
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
        <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Slot requests</div>
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

      <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 8 }}>Allotments</div>
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
    <div style={{ fontSize: 9.5, color: C.faint, textTransform: "uppercase" }}>{label}</div>
    <div style={{ fontFamily: MONO, fontSize: 15, color }}>{value}</div>
  </div>;
}

// ---------- single flight insertion ----------
function AddFlightModal({ resources, onClose, onCreate, checkConflict }) {
  const [form, setForm] = useState({ ref: "", origin: "LGW", destination: "PMI", resourceId: resources[0].id, date: iso(addDays(today, 7)), depTime: "08:00", arrTime: "11:00", capacity: resources[0].capacity, force: false });
  const conflict = checkConflict(form.resourceId, new Date(form.date), null);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 400, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>New flight</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <FieldSm label="Flight number"><input value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value.toUpperCase() })} placeholder="auto (DV####)" style={inputStyle} /></FieldSm>
            <FieldSm label="Aircraft">
              <select value={form.resourceId} onChange={e => { const r = resources.find(x => x.id === e.target.value); setForm({ ...form, resourceId: e.target.value, capacity: r.capacity }); }} style={inputStyle}>
                {resources.map(r => <option key={r.id} value={r.id}>{r.code} · {r.capacity} seats</option>)}
              </select>
            </FieldSm>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <FieldSm label="Origin"><input value={form.origin} onChange={e => setForm({ ...form, origin: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
            <FieldSm label="Destination"><input value={form.destination} onChange={e => setForm({ ...form, destination: e.target.value.toUpperCase() })} style={inputStyle} /></FieldSm>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <FieldSm label="Departure (UTC)"><input type="time" value={form.depTime} onChange={e => setForm({ ...form, depTime: e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="Arrival (UTC)"><input type="time" value={form.arrTime} onChange={e => setForm({ ...form, arrTime: e.target.value })} style={inputStyle} /></FieldSm>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <FieldSm label="Date"><input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inputStyle} /></FieldSm>
            <FieldSm label="Capacity"><input type="number" value={form.capacity} onChange={e => setForm({ ...form, capacity: +e.target.value })} style={inputStyle} /></FieldSm>
          </div>
        </div>
        {conflict && (
          <div style={{ background: C.redSoft, border: `1px solid ${C.red}55`, color: C.red, fontSize: 12, padding: "8px 10px", borderRadius: 10, marginTop: 12 }}>
            {resources.find(r => r.id === form.resourceId)?.code} already flies {conflict.ref} on {form.date}.
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, color: C.text }}>
              <input type="checkbox" checked={form.force} onChange={e => setForm({ ...form, force: e.target.checked })} /> Insert anyway (override)
            </label>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose} style={miniBtn}>Cancel</button>
          <button onClick={() => onCreate({ ...form, start: new Date(form.date), ref: form.ref.trim() || undefined })} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Insert flight</button>
        </div>
      </div>
    </div>
  );
}
function FieldSm({ label, children }) {
  return <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
    <label style={{ fontSize: 10.5, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</label>
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

function BulkImportModal({ resources, flights, onClose, onCommit }) {
  const [raw, setRaw] = useState(SAMPLE_PASTE);
  const [rows, setRows] = useState(null);
  const [patterns, setPatterns] = useState(null);

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
        include: status === "ok", dow: date ? date.getUTCDay() : null,
      };
    });

    // detect recurring weekly patterns: same flight number + resource + route + weekday, 3+ occurrences
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

    setPatterns(detectedPatterns);
    setRows(remaining);
  }

  const statusColor = { ok: C.green, conflict: C.amber, error: C.red };
  const okRowCount = rows?.filter(r => r.status === "ok" && r.include).length ?? 0;
  const patternCount = patterns?.filter(p => p.include).length ?? 0;
  const totalFlightsFromPatterns = patterns?.filter(p => p.include).reduce((s, p) => s + p.rows.length, 0) ?? 0;

  function commit() {
    const acceptedRows = rows.filter(r => r.include && r.status !== "error");
    const acceptedPatternRows = patterns.filter(p => p.include).flatMap(p => p.rows);
    onCommit([...acceptedRows, ...acceptedPatternRows]);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 720, maxWidth: "94vw", maxHeight: "88vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk import flights</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 10 }}>
          Paste rows in the same shape as the roster grid: flight number, route, times, aircraft, and leg type (revenue vs. ferry/positioning). Recurring weekly rows get grouped into a pattern automatically. Nothing is written until you commit below.
        </div>
        {!rows && (
          <>
            <textarea value={raw} onChange={e => setRaw(e.target.value)} rows={9} style={{ ...inputStyle, fontFamily: MONO, fontSize: 11.5, resize: "vertical" }} />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={onClose} style={miniBtn}>Cancel</button>
              <button onClick={parse} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Preview</button>
            </div>
          </>
        )}
        {rows && (
          <>
            {patterns.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, margin: "10px 0 6px" }}>Detected recurring patterns</div>
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
                <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Individual rows</div>
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
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => { setRows(null); setPatterns(null); }} style={miniBtn}>Back</button>
                <button onClick={commit} disabled={okRowCount + totalFlightsFromPatterns === 0} style={{ ...miniBtn, background: (okRowCount + totalFlightsFromPatterns) ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: (okRowCount + totalFlightsFromPatterns) ? C.amber : C.faint, fontWeight: 600 }}>Commit {okRowCount + totalFlightsFromPatterns} flight{(okRowCount + totalFlightsFromPatterns) === 1 ? "" : "s"}</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}



// ---------- rotation-template generator ----------
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function RotationGenModal({ resources, flights, onClose, onCommit }) {
  const [pattern, setPattern] = useState({
    origin: "LGW", destination: "DBV", resourceId: resources[0].id, capacity: resources[0].capacity,
    daysOfWeek: [5], startDate: iso(addDays(today, 7)), endDate: iso(addDays(today, 70)),
    outboundRef: "", outboundDep: "08:00", outboundArr: "11:00",
    includeReturn: true, returnRef: "", returnOrigin: "", returnDestination: "", returnDep: "12:00", returnArr: "15:00", returnDayOffset: 0,
  });
  const [preview, setPreview] = useState(null);

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
      rows.push({ date: d, leg: "Outbound", ref: outRef, origin: pattern.origin, destination: pattern.destination, depTime: pattern.outboundDep, arrTime: pattern.outboundArr, status: outConflict ? "conflict" : "ok", detail: outDetail, include: !outConflict });
      if (pattern.includeReturn) {
        // The return leg gets its own date (outbound date + offset), its own route (not
        // assumed to be the reverse of the outbound — a rotation can be CIT-VKO-ALA, not just
        // out-and-back), and its own independent conflict check.
        const retDate = addDays(d, pattern.returnDayOffset || 0);
        const retConflict = flights.find(f => f.resourceId === pattern.resourceId && iso(f.start) === iso(retDate));
        const retDetail = retConflict ? `${resCode} already flies ${retConflict.ref} that day` : "";
        rows.push({ date: retDate, leg: "Return", ref: retRef, origin: retOrigin, destination: retDestination, depTime: pattern.returnDep, arrTime: pattern.returnArr, status: retConflict ? "conflict" : "ok", detail: retDetail, include: !retConflict });
      }
    });
    setPreview(rows);
  }

  const okCount = preview?.filter(r => r.include).length ?? 0;
  const statusColor = { ok: C.green, conflict: C.amber };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 560, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Generate rotation</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Define the weekly pattern once — every matching date previews here before anything is written.</div>

        {!preview && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", gap: 10 }}>
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
              <div style={{ display: "flex", gap: 10 }}>
                <FieldSm label="Start date"><input type="date" value={pattern.startDate} onChange={e => setPattern({ ...pattern, startDate: e.target.value })} style={inputStyle} /></FieldSm>
                <FieldSm label="End date"><input type="date" value={pattern.endDate} onChange={e => setPattern({ ...pattern, endDate: e.target.value })} style={inputStyle} /></FieldSm>
              </div>
              <FieldSm label="Capacity"><input type="number" value={pattern.capacity} onChange={e => setPattern({ ...pattern, capacity: +e.target.value })} style={inputStyle} /></FieldSm>

              <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 4 }}>Outbound leg — {pattern.origin}→{pattern.destination}</div>
              <div style={{ display: "flex", gap: 10 }}>
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
                  <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4 }}>Return leg</div>
                  <div style={{ fontSize: 10, color: C.faint, marginTop: -6 }}>Doesn't have to go back the way it came — e.g. CIT→VKO out, VKO→ALA back. Leave blank to default to the reverse of the outbound route.</div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <FieldSm label="Origin"><input value={pattern.returnOrigin} onChange={e => setPattern({ ...pattern, returnOrigin: e.target.value.toUpperCase() })} placeholder={pattern.destination} style={inputStyle} /></FieldSm>
                    <FieldSm label="Destination"><input value={pattern.returnDestination} onChange={e => setPattern({ ...pattern, returnDestination: e.target.value.toUpperCase() })} placeholder={pattern.origin} style={inputStyle} /></FieldSm>
                  </div>
                  <div style={{ display: "flex", gap: 10 }}>
                    <FieldSm label="Flight number"><input value={pattern.returnRef} onChange={e => setPattern({ ...pattern, returnRef: e.target.value.toUpperCase() })} placeholder="auto" style={inputStyle} /></FieldSm>
                    <FieldSm label="Return after (days)"><input type="number" min={0} value={pattern.returnDayOffset} onChange={e => setPattern({ ...pattern, returnDayOffset: Math.max(0, +e.target.value) })} style={inputStyle} /></FieldSm>
                  </div>
                  <div style={{ fontSize: 10, color: C.faint, marginTop: -4 }}>0 = same day (typical out-and-back turnaround). Use 1+ for layovers — e.g. 1 means the aircraft returns the day after each outbound date.</div>
                  <div style={{ display: "flex", gap: 10 }}>
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

        {preview && (
          <>
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
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPreview(null)} style={miniBtn}>Back</button>
                <button onClick={() => onCommit(preview.filter(r => r.include), pattern)} disabled={okCount === 0} style={{ ...miniBtn, background: okCount ? GRADIENT_PRIMARY : C.faint, color: ON_ACCENT, borderColor: okCount ? C.amber : C.faint, fontWeight: 600 }}>Commit {okCount} flight{okCount === 1 ? "" : "s"}</button>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 620, maxWidth: "94vw", maxHeight: "86vh", overflow: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>Bulk retime</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginBottom: 12 }}>Shift dates and/or times across a whole season (or any filtered set) in one go. Nothing changes until you commit below.</div>

        {!matches && (
          <>
            <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>Which flights</div>
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

            <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>What changes</div>
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
const SCR_ACTION_CODES = [
  ["N", "New request"], ["C", "Schedule to be changed (old data)"], ["R", "Revised schedule (offer acceptable)"],
  ["L", "Revised schedule (no offer acceptable)"], ["D", "Delete schedule"], ["A", "Accept offer — no further improvement"],
  ["P", "Accept offer — maintain on waitlist"], ["Z", "Decline offer"],
];
const SCR_SERVICE_TYPES = [["J", "Scheduled passenger"], ["C", "Charter passenger"], ["G", "Additional passenger"], ["F", "Scheduled cargo/mail"], ["H", "Charter cargo/mail"], ["P", "Positioning/ferry"], ["K", "Training"], ["X", "Technical stop"], ["T", "Technical test"]];
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

function buildSCRDataLine(line, flights, clearanceAirport) {
  const arrFlight = flights.find(f => f.id === line.arrFlightId) || null;
  const depFlight = flights.find(f => f.id === line.depFlightId) || null;
  const seats = String(line.seats).padStart(3, "0").slice(-3);
  const acType = (line.acType || "").padEnd(3, "_").slice(0, 3);
  const arrFlt = arrFlight ? `${line.arrDesignator}${padFlightNo(arrFlight.ref)}` : "";
  const depFlt = depFlight ? `${line.depDesignator}${padFlightNo(depFlight.ref)}` : "";
  const period = ddmmm(new Date(line.periodFrom)) + ddmmm(new Date(line.periodTo));
  const days = daysOfOpString(line.days.map(Number));
  // SCR times are bare 4-digit UTC (e.g. "1200", not "12:00" and no trailing Z) — times are
  // always UTC per SSIM Ch.6, so no local conversion or zone marker belongs in the data line.
  // Per the format (e.g. "MANLHR0745" = previous stn + this stn + ARRIVAL time at this stn),
  // the inbound leg's time is when it lands at the clearance airport (arrTime), and the
  // outbound leg's time is when it leaves the clearance airport (depTime) — not the same field.
  const hhmmCompact = t => t ? t.replace(":", "") : "----";
  const inbound = arrFlight ? `${arrFlight.origin}${clearanceAirport}${hhmmCompact(arrFlight.arrTime)}` : "";
  const outbound = depFlight ? `${hhmmCompact(depFlight.depTime)}${clearanceAirport}${depFlight.destination}` : "";
  const svc = line.inboundService + line.outboundService;
  return [line.actionCode + arrFlt, depFlt, period, days, seats + acType, inbound, outbound, svc].filter(Boolean).join(" ");
}

function buildSCRMessage(header, lines, flights) {
  const out = ["SCR", `/${header.creatorRef}`, header.season, ddmmm(new Date(header.messageDate)), header.clearanceAirport];
  lines.forEach(line => out.push(buildSCRDataLine(line, flights, header.clearanceAirport)));
  if (header.si) out.push(`SI ${header.si}`);
  out.push(`GI ${header.gi || "BRGDS"}`);
  return out.join("\n");
}

// Turns a flight (or a whole batch just created — single insert, bulk import, rotation
// generator) straight into an SCR draft, so the request is ready the moment the schedule
// change exists rather than requiring someone to re-enter the same route/dates by hand.
// role "destination" treats each flight as the arrival leg (this is the airport the flight
// lands at); role "origin" treats it as the departure leg. Flights sharing a route+aircraft
// are grouped into one line spanning their date range, with days-of-operation computed from
// which weekdays actually appear — not assumed.
function deriveSCRSeedFromFlights(flightList, resources, role) {
  const groups = new Map();
  flightList.forEach(f => {
    const key = `${f.origin}|${f.destination}|${f.resourceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });
  const lines = [];
  let clearanceAirport = "";
  groups.forEach(group => {
    group.sort((a, b) => a.start - b.start);
    const rep = group[0];
    const res = resources.find(r => r.id === rep.resourceId);
    const station = role === "destination" ? rep.destination : rep.origin;
    if (!clearanceAirport) clearanceAirport = station;
    const days = [...new Set(group.map(f => jsToIataDay(f.start.getUTCDay())))].map(String);
    lines.push(newSCRLine({
      arrFlightId: role === "destination" ? rep.id : "",
      depFlightId: role === "origin" ? rep.id : "",
      periodFrom: iso(group[0].start), periodTo: iso(group[group.length - 1].start),
      days, seats: res?.capacity || rep.capacity, acType: res ? guessAcType(res.variant) : "",
    }));
  });
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
      if (res) { patch.seats = res.capacity; patch.acType = guessAcType(res.variant); }
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

  function pickFlight(lineId, which, flightId) {
    const f = flights.find(x => x.id === flightId);
    const patch = { [which === "arr" ? "arrFlightId" : "depFlightId"]: flightId };
    if (f) {
      if (!header.clearanceAirport) setHeader(h => ({ ...h, clearanceAirport: which === "arr" ? f.destination : f.origin }));
      patch.periodFrom = iso(f.start); patch.periodTo = iso(f.start);
      patch.days = [String(jsToIataDay(f.start.getUTCDay()))];
      const res = resources.find(r => r.id === f.resourceId);
      if (res) { patch.seats = res.capacity; patch.acType = guessAcType(res.variant); }
    }
    updateLine(lineId, patch);
  }

  const canGenerate = header.clearanceAirport && lines.length > 0 && lines.every(l => l.arrFlightId || l.depFlightId);

  function generate() {
    setOutput(buildSCRMessage(header, lines, flights));
    setCopied(false);
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
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
            <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, margin: "4px 0 6px" }}>Message header (shared by every line below)</div>
            <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
              <FieldSm label="Your reference / email"><input value={header.creatorRef} onChange={e => setHeader({ ...header, creatorRef: e.target.value })} placeholder="ops@yourairline.com" style={inputStyle} /></FieldSm>
              <FieldSm label="Clearance airport"><input value={header.clearanceAirport} onChange={e => setHeader({ ...header, clearanceAirport: e.target.value.toUpperCase() })} maxLength={4} style={inputStyle} /></FieldSm>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <FieldSm label="Season"><input value={header.season} onChange={e => setHeader({ ...header, season: e.target.value })} style={inputStyle} /></FieldSm>
              <FieldSm label="Message date"><input type="date" value={header.messageDate} onChange={e => setHeader({ ...header, messageDate: e.target.value })} style={inputStyle} /></FieldSm>
            </div>

            <div style={{ fontSize: 11, color: C.faint, textTransform: "uppercase", letterSpacing: 0.4, margin: "4px 0 8px" }}>Data lines — one per flight/period ({lines.length})</div>
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
                  <div style={{ fontSize: 10.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Arrival leg (optional)</div>
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
                  <div style={{ fontSize: 10.5, color: C.faint, textTransform: "uppercase", letterSpacing: 0.3, marginBottom: 4 }}>Departure leg (optional)</div>
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
              <button onClick={() => { navigator.clipboard.writeText(output); setCopied(true); }} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OperatorsPanel({ operators, setOperators, flights, allotments, perms, onAddOperator, onBulkImportOperators, onDeleteOperator }) {
  const [expanded, setExpanded] = useState(null); // { id, panel: "seats" | "rates" }
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showAddOperator, setShowAddOperator] = useState(false);
  const [showBulkOperators, setShowBulkOperators] = useState(false);
  const [newDest, setNewDest] = useState({});
  function updateDefaultRate(id, rate) { setOperators(ops => ops.map(o => o.id === id ? { ...o, defaultRate: rate } : o)); }
  function setDestRate(id, dest, rate) {
    setOperators(ops => ops.map(o => o.id === id ? { ...o, ratesByDestination: { ...o.ratesByDestination, [dest]: rate } } : o));
  }
  function removeDestRate(id, dest) {
    setOperators(ops => ops.map(o => {
      if (o.id !== id) return o;
      const next = { ...o.ratesByDestination };
      delete next[dest];
      return { ...o, ratesByDestination: next };
    }));
  }
  function toggle(id, panel) { setExpanded(e => (e && e.id === id && e.panel === panel) ? null : { id, panel }); }

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
          <tr style={{ textAlign: "left", color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
            <th style={th}>Tour operator</th><th style={th}>Default rate</th><th style={th}>Allotment type</th><th style={th}>Status</th><th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {operators.map(o => {
            const opAllotments = allotments.filter(a => a.operatorId === o.id && a.status !== "cancelled" && a.status !== "released");
            const destRates = Object.entries(o.ratesByDestination || {});
            const isSeats = expanded?.id === o.id && expanded.panel === "seats";
            const isRates = expanded?.id === o.id && expanded.panel === "rates";
            return (
              <React.Fragment key={o.id}>
                <tr style={{ borderTop: `1px solid ${C.borderSoft}` }}>
                  <td style={td}>{o.name}<span style={{ color: C.faint, marginLeft: 6, fontSize: 11 }}>{o.country}</span></td>
                  <td style={td}>
                    {perms.editContracts
                      ? <input type="number" value={o.defaultRate} onChange={e => updateDefaultRate(o.id, +e.target.value)} style={{ ...inputStyle, width: 80 }} />
                      : <span style={{ fontFamily: MONO }}>${o.defaultRate}</span>}
                  </td>
                  <td style={td}><Badge color={o.allotmentType === "option" ? C.amber : C.cyan}>{o.allotmentType.toUpperCase()}{o.optionReleaseDays ? ` · ${o.optionReleaseDays}d` : ""}</Badge></td>
                  <td style={td}><Badge color={o.status === "active" ? C.green : C.red}>{o.status.replace("_", " ").toUpperCase()}</Badge></td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button onClick={() => toggle(o.id, "rates")} style={miniBtn}>{isRates ? "Hide" : `Rates (${destRates.length})`}</button>
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
                  <tr><td colSpan={5} style={{ padding: "6px 10px 14px", background: C.panel2 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>Per-destination rates for {o.name} — anything not listed here falls back to the ${o.defaultRate} default.</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                      {destRates.length === 0 && <div style={{ fontSize: 12, color: C.faint }}>No destination-specific rates yet — every flight uses the default.</div>}
                      {destRates.map(([dest, rate]) => (
                        <div key={dest} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                          <span style={{ fontFamily: MONO, width: 50 }}>{dest}</span>
                          {perms.editContracts
                            ? <input type="number" value={rate} onChange={e => setDestRate(o.id, dest, +e.target.value)} style={{ ...inputStyle, width: 70 }} />
                            : <span style={{ fontFamily: MONO }}>${rate}</span>}
                          {perms.editContracts && <button onClick={() => removeDestRate(o.id, dest)} style={{ ...miniBtn, fontSize: 10, color: C.red, borderColor: C.red }}>Remove</button>}
                        </div>
                      ))}
                    </div>
                    {perms.editContracts && (
                      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input placeholder="Dest (e.g. SSH)" value={newDest[o.id]?.code || ""} onChange={e => setNewDest({ ...newDest, [o.id]: { ...newDest[o.id], code: e.target.value.toUpperCase() } })} style={{ ...inputStyle, width: 90 }} maxLength={4} />
                        <span style={{ fontSize: 11, color: C.faint }}>$</span>
                        <input type="number" placeholder="Rate" value={newDest[o.id]?.rate ?? ""} onChange={e => setNewDest({ ...newDest, [o.id]: { ...newDest[o.id], rate: +e.target.value } })} style={{ ...inputStyle, width: 70 }} />
                        <button onClick={() => {
                          const d = newDest[o.id];
                          if (!d?.code || !d?.rate) return;
                          setDestRate(o.id, d.code, d.rate);
                          setNewDest({ ...newDest, [o.id]: { code: "", rate: "" } });
                        }} style={{ ...miniBtn, background: GRADIENT_PRIMARY, boxShadow: GLOW_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>Add rate</button>
                      </div>
                    )}
                  </td></tr>
                )}
                {isSeats && (
                  <tr><td colSpan={5} style={{ padding: "6px 10px 14px", background: C.panel2 }}>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
      <div className="modal-pop" onClick={e => e.stopPropagation()} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 20, boxShadow: "0 20px 50px rgba(58,54,47,0.14)", padding: 20, width: 380, maxWidth: "92vw" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>New tour operator</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <FieldSm label="Name"><input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} /></FieldSm>
          <FieldSm label="Country"><input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })} style={inputStyle} /></FieldSm>
          <div style={{ display: "flex", gap: 10 }}>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
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
          <tr style={{ textAlign: "left", color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.4 }}>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
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
                <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 10.5, textTransform: "uppercase" }}>
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
                <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 10.5, textTransform: "uppercase" }}><th style={th}>Aircraft</th><th style={th}>Variant</th><th style={th}>Status</th></tr></thead>
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
const cardTitle = { fontSize: 11.5, color: C.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 };

// ---------- Aircraft (fleet management) ----------
function AircraftPanel({ resources, flights, perms, onAddResource, onUpdateResource, onDeleteResource }) {
  const [showAdd, setShowAdd] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  return (
    <div style={{ padding: 20 }}>
      {perms.editFlight && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
          <button onClick={() => setShowAdd(true)} style={{ ...miniBtn, background: GRADIENT_PRIMARY, color: ON_ACCENT, borderColor: C.amber, fontWeight: 600 }}>+ Add aircraft</button>
        </div>
      )}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead><tr style={{ textAlign: "left", color: C.muted, fontSize: 11, textTransform: "uppercase", background: C.panel2 }}>
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
      {showAdd && <AddAircraftModal onClose={() => setShowAdd(false)} onCreate={r => { onAddResource(r); setShowAdd(false); }} />}
    </div>
  );
}
function AddAircraftModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ code: "", variant: "", capacity: 189 });
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(58,54,47,0.18)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 90 }} onClick={onClose}>
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

// ---------- Quotas (aggregate view over existing allotments — this is what "quotas" means here) ----------
function QuotasPanel({ operators, allotments, flights }) {
  return (
    <div style={{ padding: 20 }}>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 14 }}>Each tour operator's committed seat quota across the board — this is the same allotment data as the Schedule and Tour Operators tabs, aggregated per operator rather than per flight.</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {operators.map(o => {
          const active = allotments.filter(a => a.operatorId === o.id && a.status !== "cancelled" && a.status !== "released");
          const seats = active.reduce((s, a) => s + a.seatsAllocated, 0);
          const value = active.reduce((s, a) => s + a.seatsAllocated * a.pricePerSeat, 0);
          const byDest = {};
          active.forEach(a => { const f = flights.find(fl => fl.id === a.flightId); if (f) byDest[f.destination] = (byDest[f.destination] || 0) + a.seatsAllocated; });
          return (
            <div key={o.id} style={card}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{o.name}</div>
                <div style={{ display: "flex", gap: 16, fontSize: 12.5 }}>
                  <span><span style={{ fontFamily: MONO, fontWeight: 700 }}>{seats}</span> <span style={{ color: C.muted }}>seats</span></span>
                  <span style={{ color: C.green, fontFamily: MONO, fontWeight: 700 }}>${value.toLocaleString()}</span>
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.entries(byDest).map(([dest, n]) => <Badge key={dest} color={C.cyan} bg={C.cyanSoft}>{dest}: {n}</Badge>)}
                {Object.keys(byDest).length === 0 && <span style={{ fontSize: 11.5, color: C.faint }}>No active allotments.</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

