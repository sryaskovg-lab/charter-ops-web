// Pure builders for the Permits report: one row per country and a flat register of permits.
import { normState, effectiveStatus, flightNeeds, coverageFor, dayOf, daysBetween } from "./permit-utils";
import { countryName } from "./country-names";

const STATUS_LABEL = { draft: "Draft", submitted: "Submitted", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", expired: "Expired" };

export function countryRows({ permits, states = [], routes = [], flights = [], routeMap, airportMap, agents = [], todayStr }) {
  const codes = new Set([...states.map(s => normState(s.state)), ...routes.flatMap(r => r.states || []).map(normState), ...permits.map(p => normState(p.state))]);
  const cfg = new Map(states.map(s => [normState(s.state), s]));
  const unc = new Map(); // state -> { count, first }
  (flights || []).forEach(f => {
    if (f.status === "cancelled") return;
    const day = dayOf(f.start);
    if (day < todayStr) return;
    flightNeeds(f, routeMap, airportMap).needs.forEach(n => {
      if (coverageFor(permits, n.state, day, f.resourceId, { kind: n.kind, ref: f.ref, airport: n.airport }).covered) return;
      const k = normState(n.state);
      const cur = unc.get(k) || { count: 0, first: day };
      cur.count++; if (day < cur.first) cur.first = day;
      unc.set(k, cur);
    });
  });
  return [...codes].filter(Boolean).map(code => {
    const mine = permits.filter(p => normState(p.state) === code);
    const eff = p => effectiveStatus(p, todayStr);
    const valid = mine.filter(p => eff(p) === "approved" && (!p.validFrom || p.validFrom <= todayStr));
    const approvedAll = mine.filter(p => p.status === "approved" && p.validTo && p.validTo >= todayStr);
    const lastEnd = approvedAll.map(p => p.validTo).sort().slice(-1)[0] || "";
    const open = mine.filter(p => ["draft", "submitted"].includes(p.status));
    const c = cfg.get(code);
    const ag = c?.channel === "agent" ? agents.find(a => a.id === c.agentId) : null;
    return {
      code, country: countryName(code), goesTo: ag ? `Agent: ${ag.name}` : "Authority", valid: valid.length, validUntil: lastEnd,
      endsInDays: lastEnd ? daysBetween(todayStr, lastEnd) : null, open: open.length,
      numbers: valid.map(p => p.permitNumber).filter(Boolean).join(", "),
      uncovered: unc.get(code)?.count || 0, firstUncovered: unc.get(code)?.first || "",
    };
  }).sort((a, b) => a.country.localeCompare(b.country));
}

export function registerRows({ permits, agents = [], resources = [], todayStr, includeClosed = false }) {
  return permits
    .filter(p => includeClosed || ["draft", "submitted", "approved"].includes(effectiveStatus(p, todayStr)))
    .map(p => ({
      country: countryName(p.state), code: normState(p.state), type: p.kind === "landing" ? `Landing${p.airport ? " " + p.airport : ""}` : "Overfly",
      number: p.permitNumber || "", ref: p.authorityRef || "", status: STATUS_LABEL[effectiveStatus(p, todayStr)] || p.status,
      from: p.validFrom || "", to: p.validTo || "", aircraft: p.resourceIds.length ? p.resourceIds.map(id => resources.find(r => r.id === id)?.code || "?").join(" ") : "All",
      via: p.agentId ? (agents.find(a => a.id === p.agentId)?.name || "agent") : "Direct", submitted: p.submittedAt ? p.submittedAt.slice(0, 10) : "", decided: p.decidedAt ? p.decidedAt.slice(0, 10) : "",
    }))
    .sort((a, b) => a.country.localeCompare(b.country) || a.from.localeCompare(b.from));
}

const csvCell = v => { const s = String(v ?? ""); return /[",;\r\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// columns: [[key, header]]. A leading BOM is added by the caller so Excel reads UTF-8.
export function toCsv(rows, columns) {
  return [columns.map(c => csvCell(c[1])).join(","), ...rows.map(r => columns.map(c => csvCell(r[c[0]])).join(","))].join("\r\n") + "\r\n";
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function toHtmlTable(rows, columns) {
  return `<table><thead><tr>${columns.map(c => `<th>${esc(c[1])}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${columns.map(c => `<td>${esc(r[c[0]])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
