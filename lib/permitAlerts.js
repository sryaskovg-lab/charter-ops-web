import { getSupabaseAdmin } from "./supabaseAdmin";
import { accessToken, mailConfigured, sendRaw } from "./gmailApi";
import { mapFlight } from "./scheduling-utils";
import { buildRouteMap, computeUrgentUncovered, ALERT_DAYS, addDaysStr } from "./permit-utils";
import { buildAlertEmail, buildRawMime, extractEmails } from "./permit-request";

// Server-only. Finds flights departing within ALERT_DAYS days (UTC) that lack an approved permit
// and e-mails the list (from the connected Gmail account) to PERMIT_ALERT_TO. Sends nothing when
// everything is covered. `dryRun` returns what would be sent.
export async function runPermitAlerts({ dryRun = false } = {}) {
  const recipients = extractEmails(process.env.PERMIT_ALERT_TO);
  const admin = getSupabaseAdmin();
  const todayStr = new Date().toISOString().slice(0, 10);
  const to = addDaysStr(todayStr, ALERT_DAYS + 1);
  const [fl, rt, pm, rs] = await Promise.all([
    admin.from("flights").select("*").gte("scheduled_departure", `${todayStr}T00:00:00Z`).lt("scheduled_departure", `${to}T00:00:00Z`).neq("status", "cancelled").limit(1000),
    admin.from("route_overfly_states").select("origin,destination,states"),
    admin.from("overfly_permits").select("id,state,status,valid_from,valid_to,resource_ids,permit_number,authority_ref"),
    admin.from("resources").select("id,code"),
  ]);
  const err = fl.error || rt.error || pm.error || rs.error;
  if (err) throw new Error(`Database error: ${err.message}`);
  const flights = (fl.data || []).map(mapFlight);
  const permits = (pm.data || []).map(p => ({ id: p.id, state: p.state, status: p.status, validFrom: p.valid_from, validTo: p.valid_to, resourceIds: p.resource_ids || [], permitNumber: p.permit_number, authorityRef: p.authority_ref }));
  const routeMap = buildRouteMap((rt.data || []).map(r => ({ origin: r.origin, destination: r.destination, states: r.states })));
  const codes = new Map((rs.data || []).map(r => [r.id, r.code]));
  const { uncovered, unmapped } = computeUrgentUncovered(flights, routeMap, permits, todayStr, ALERT_DAYS);
  const result = { checked: flights.length, uncovered: uncovered.length, unmapped: unmapped.length, sent: false, recipients: recipients.length };
  if (!uncovered.length && !unmapped.length) return { ...result, note: "All flights in the next 4 days are covered; nothing sent." };
  const mail = buildAlertEmail({ uncovered, unmapped, todayStr, days: ALERT_DAYS, codeOf: id => codes.get(id) || "?" });
  if (dryRun) return { ...result, preview: mail };
  if (!recipients.length) return { ...result, error: "PERMIT_ALERT_TO is not set in Vercel (comma-separated e-mail addresses), so the alert was not sent." };
  if (!mailConfigured()) return { ...result, error: "Gmail is not connected, so the alert was not sent." };
  await sendRaw(await accessToken(), buildRawMime({ to: recipients, subject: mail.subject, text: mail.body }));
  return { ...result, sent: true };
}
