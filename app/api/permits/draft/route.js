import { requireActiveUser } from "../../../../lib/serverAuth";
import { accessToken, createDraft, mailConfigured } from "../../../../lib/gmailApi";
import { buildRawMime, extractEmails } from "../../../../lib/permit-request";

// POST { to, subject, body }: puts a permit request into the connected Gmail account's Drafts.
// Nothing is sent; a person reviews and presses Send in Gmail.
export async function POST(request) {
  const who = await requireActiveUser(request);
  if (who instanceof Response) return who;
  if (!["ops_coordinator", "management"].includes(who.role)) return Response.json({ error: "Only schedule coordinators and management can draft permit requests." }, { status: 403 });
  if (!mailConfigured()) return Response.json({ error: "Gmail is not connected yet (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)." }, { status: 400 });
  const { to, subject, body } = await request.json().catch(() => ({}));
  if (!subject || !body || String(body).length > 20000) return Response.json({ error: "Subject and body are required (body up to 20,000 characters)." }, { status: 400 });
  try {
    const raw = buildRawMime({ to: extractEmails(Array.isArray(to) ? to.join(",") : to), subject: String(subject).slice(0, 300), text: String(body) });
    const d = await createDraft(await accessToken(), raw);
    return Response.json({ draftId: d.id });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
