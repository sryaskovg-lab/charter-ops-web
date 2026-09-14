import crypto from "crypto";
import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

// POST /api/admin/create-user  { email, name, role }
// Only callable by someone whose own profile.role is 'management' — verified server-side via
// the caller's Supabase access token, never trusted from the request body. Creates the user
// directly (rather than emailing an invite) and hands back a one-time temp password, so this
// works without any SMTP configuration — the admin relays the password to the new teammate
// however they'd relay any other credential, and the teammate changes it on first login.
export async function POST(request) {
  const supabaseAdmin = getSupabaseAdmin();
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { data: { user }, error: userErr } = await supabaseAdmin.auth.getUser(token);
  if (userErr || !user) return Response.json({ error: "Invalid session" }, { status: 401 });

  const { data: callerProfile } = await supabaseAdmin.from("profiles").select("role").eq("id", user.id).single();
  if (callerProfile?.role !== "management") {
    return Response.json({ error: "Only management can create users" }, { status: 403 });
  }

  const { email, name, role } = await request.json();
  const validRoles = ["commercial", "tour_operator_liaison", "ops_coordinator", "management"];
  if (!email || !validRoles.includes(role)) {
    return Response.json({ error: "email and a valid role are required" }, { status: 400 });
  }

  const tempPassword = crypto.randomBytes(9).toString("base64").replace(/[+/=]/g, "x");
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password: tempPassword, email_confirm: true,
    user_metadata: { name: name || email, role },
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });

  return Response.json({ userId: data.user.id, tempPassword });
}
