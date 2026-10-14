import { requireActiveUser } from "../../../../lib/serverAuth";
import { syncScheduleMail } from "../../../../lib/scheduleMailSync";

export const maxDuration = 60;

// POST: "Check mail" in the app, and the quiet check while a coordinator has the Schedule page
// open — signed-in ops_coordinator / management only.
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can check schedule e-mail." }, { status: 403 });
  try {
    return Response.json(await syncScheduleMail());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// GET: daily run from Vercel Cron; refuses to run unless CRON_SECRET is set and matches.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await syncScheduleMail());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
