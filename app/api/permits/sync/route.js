import { requireActiveUser } from "../../../../lib/serverAuth";
import { syncPermitMail } from "../../../../lib/permitMailSync";

export const maxDuration = 60;

// POST: "Check mail now" button — signed-in ops_coordinator / management only.
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can sync permit e-mail." }, { status: 403 });
  try {
    return Response.json(await syncPermitMail());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// GET: daily run from Vercel Cron (vercel.json). Unlike the older option-release job this one
// refuses to run at all unless CRON_SECRET is set and matches.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return Response.json(await syncPermitMail());
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
