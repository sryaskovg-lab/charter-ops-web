import { requireActiveUser } from "../../../../lib/serverAuth";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";
import { applyMovementText } from "../../../../lib/movementApply";

export const maxDuration = 30;

// POST { text }: a movement message pasted in the app (ops_coordinator / management).
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can enter movement messages." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const text = String(body?.text || "").slice(0, 20000);
  if (!text.trim()) return Response.json({ error: "Nothing to read." }, { status: 400 });
  try {
    const r = await applyMovementText(getSupabaseAdmin(), text, { userId: who.user.id });
    if (r.notMvt) return Response.json({ error: "This does not look like a movement message (it should contain a line MVT, then the flight line)." }, { status: 400 });
    return Response.json({ messages: r.messages, applied: r.applied, unmatched: r.unmatched, errors: r.errors, notes: r.rows.map(x => x.note) });
  } catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
}
