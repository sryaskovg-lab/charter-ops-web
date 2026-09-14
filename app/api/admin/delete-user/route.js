import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

// POST /api/admin/delete-user  { userId }
// Only callable by someone whose own profile.role is 'management' — verified server-side via
// the caller's Supabase access token, same pattern as create-user. Deletes the auth.users row
// directly; public.profiles.id has ON DELETE CASCADE back to auth.users, so the profile row
// (and anything else that references it) is cleaned up automatically, not as a separate step
// here that could get out of sync.
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
      return Response.json({ error: "Only management can delete users" }, { status: 403 });
    }

    const { userId } = await request.json();
    if (!userId) return Response.json({ error: "userId is required" }, { status: 400 });
    if (userId === user.id) return Response.json({ error: "You can't delete your own account this way — ask another manager." }, { status: 400 });

    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (error) return Response.json({ error: error.message }, { status: 400 });

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message || "Unexpected server error" }, { status: 500 });
  }
}
