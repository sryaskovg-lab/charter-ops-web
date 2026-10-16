import { looksLikeMvt, parseMvt, resolveMvtTimes, sameAircraft, pickFlight, isArrivalOnly } from "./mvt";

// Server-only. Reads the movement messages in `text`, finds each flight and stores the actual times on it.
// Only the movement columns of a flight are touched; the schedule itself is never changed.
// meta: { gmailMessageId, part, fromAddr, subject, receivedAt, userId }
export async function applyMovementText(admin, text, meta = {}) {
  const rows = [], summary = { messages: 0, applied: 0, unmatched: 0, errors: [] };
  if (!looksLikeMvt(text)) return { ...summary, notMvt: true, rows };
  const around = meta.receivedAt ? new Date(meta.receivedAt) : new Date();
  const base = { gmail_message_id: meta.gmailMessageId || null, part: meta.part || "body", from_addr: meta.fromAddr || null, subject: meta.subject || null, received_at: around.toISOString(), raw_text: String(text).slice(0, 4000), created_by: meta.userId || null };
  for (const mv of parseMvt(text)) {
    summary.messages++;
    const lo = new Date(around.getTime() - 5 * 86400000).toISOString(), hi = new Date(around.getTime() + 5 * 86400000).toISOString();
    const { data: cands, error } = await admin.from("flights").select("id,ref,origin,destination,scheduled_departure,scheduled_arrival,resource_id").eq(isArrivalOnly(mv) ? "destination" : "origin", mv.origin).gte("scheduled_departure", lo).lte("scheduled_departure", hi).limit(400);
    if (error) { summary.errors.push(error.message); rows.push({ ...base, flight_ref: mv.ref, status: "error", note: error.message.slice(0, 300) }); continue; }
    const { flight, how } = pickFlight(mv, (cands || []).filter(f => String(f.ref || "").replace(/\s/g, "").toUpperCase() === mv.ref), around);
    if (!flight) { summary.unmatched++; rows.push({ ...base, flight_ref: mv.ref, status: "unmatched", note: `${mv.ref} ${mv.origin} day ${mv.day}: ${how}` }); continue; }
    const t = resolveMvtTimes(mv, new Date(flight.scheduled_departure), flight.scheduled_arrival ? new Date(flight.scheduled_arrival) : null);
    const patch = { movement_updated_at: new Date().toISOString(), actual_registration: mv.registration };
    if (t.off) patch.actual_off_block = t.off;
    if (t.airborne) patch.actual_airborne = t.airborne;
    if (t.landing) patch.actual_landing = t.landing;
    if (t.onBlock) patch.actual_on_block = t.onBlock;
    if (t.eta) patch.estimated_arrival = t.eta;
    const { error: ue } = await admin.from("flights").update(patch).eq("id", flight.id);
    if (ue) { summary.errors.push(ue.message); rows.push({ ...base, flight_ref: mv.ref, flight_id: flight.id, status: "error", note: ue.message.slice(0, 300) }); continue; }
    let planned = null;
    if (flight.resource_id) { const { data: r } = await admin.from("resources").select("code").eq("id", flight.resource_id).maybeSingle(); planned = r?.code || null; }
    const bits = [t.off && `off-block ${t.off.slice(11, 16)}`, t.airborne && `airborne ${t.airborne.slice(11, 16)}`, t.landing && `landed ${t.landing.slice(11, 16)}`, t.onBlock && `on-block ${t.onBlock.slice(11, 16)}`, t.eta && `ETA ${t.eta.slice(11, 16)}`].filter(Boolean);
    let note = `${mv.ref} ${flight.origin}-${flight.destination}: ${bits.join(", ")} UTC`;
    if (planned && sameAircraft(mv.registration, planned) === false) note += `. Aircraft ${mv.registration} operated; the schedule has ${planned}`;
    summary.applied++;
    rows.push({ ...base, flight_ref: mv.ref, flight_id: flight.id, status: "applied", note });
  }
  if (rows.length) {
    const { error } = await admin.from("movement_messages").insert(rows);
    if (error && error.code !== "23505") summary.errors.push(`log: ${error.message}`);
  }
  return { ...summary, rows };
}
