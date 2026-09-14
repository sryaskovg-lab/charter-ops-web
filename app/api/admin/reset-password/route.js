import crypto from "crypto";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

// POST /api/admin/reset-password  { userId }
// Only callable by management, same verification pattern as create-user/delete-user. Generates
// a brand new temp password and sets it directly — this is the fix for "I missed the temp
// password toast": rather than that being unrecoverable, management can just issue a new one
// on demand, as many times as needed.
export async function POST(request) {
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const auth = request.headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

    const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
    if (userErr || !user) return Response.json({ error: "Invalid session" }, { status: 401 });

    const { data: callerProfile } = await supabaseAdmin.from("profiles").select("role").eq("id", user.id).single();
    if (callerProfile?.role !== "management") {
      return Response.json({ error: "Only management can reset passwords" }, { status: 403 });
    }

    const { userId } = await request.json();
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });

    const tempPassword = crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "x");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: tempPassword });
    if (error) return Response.json({ error: error.message }, { status: 400 });

    return Response.json({ tempPassword });
  } catch (err) {
    return Response.json({ error: err.message || "Unexpected server error" }, { status: 500 });
  }
}
