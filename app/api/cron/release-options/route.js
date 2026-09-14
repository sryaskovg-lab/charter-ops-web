import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

// Wired up in vercel.json to run on a schedule. This is the real equivalent of the
// setInterval simulation in the browser prototype and the releaseExpiredOptions job in the
// earlier Express scaffold — the thing that actually has to run even if nobody has a tab open.
export async function GET(request) {
  const supabaseAdmin = getSupabaseAdmin();
  const auth = request.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("allotments")
    .update({ status: "released", updated_at: new Date().toISOString() })
    .eq("status", "active")
    .eq("allotment_type", "option")
    .lte("option_release_at", new Date().toISOString())
    .select();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ released: data.length });
}
