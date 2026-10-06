import { getSupabaseAdmin } from "./supabaseAdmin";

// Shared guard for API routes: the caller must present a valid Supabase session token AND have
// an approved (non-'pending') role. Returns { user, role } on success, or a ready-to-return
// Response (401/403) -- callers do:  const who = await requireActiveUser(request); if (who instanceof Response) return who;
export async function requireActiveUser(request) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token || token === "undefined") return Response.json({ error: "Unauthorized" }, { status: 401 });
  const admin = getSupabaseAdmin();
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return Response.json({ error: "Invalid session" }, { status: 401 });
  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile?.role || profile.role === "pending") return Response.json({ error: "Account not approved yet" }, { status: 403 });
  return { user, role: profile.role };
}
