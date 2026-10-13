import { requireActiveUser } from "../../../../lib/serverAuth";
import { analyzePermitBriefs } from "../../../../lib/permitBriefReader";

export const maxDuration = 60;

// POST: "Read attachments now" button (ops_coordinator / management). Reads a few documents per
// call; press again while it reports some waiting.
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can read permit attachments." }, { status: 403 });
  try { return Response.json(await analyzePermitBriefs({ limit: 3, budgetMs: 30000 })); }
  catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
