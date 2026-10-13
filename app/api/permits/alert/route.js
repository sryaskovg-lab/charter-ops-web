import { requireActiveUser } from "../../../../lib/serverAuth";
import { runPermitAlerts } from "../../../../lib/permitAlerts";

export const maxDuration = 60;

// POST: "Send 4-day alert now" button (ops_coordinator / management). { dryRun: true } previews.
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can send permit alerts." }, { status: 403 });
  const { dryRun } = await request.json().catch(() => ({}));
  try { return Response.json(await runPermitAlerts({ dryRun: !!dryRun })); }
  catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
