import { getSupabaseAdmin } from "../../../../lib/supabaseAdmin";

// POST /api/auth/signup  { name, email, password }
// Public — no auth required, this IS how someone gets their first login. Deliberately does
// NOT accept a role from the request: every self-signup lands as 'commercial' (the least
// privileged role, via the handle_new_user trigger's default), no matter what the client
// sends. Management promotes people afterward from the Team tab (or, for the very first
// account ever, via one SQL statement — see README).
//
// email_confirm: true skips Supabase's email-confirmation step entirely, so the account is
// immediately usable — that's the tradeoff being made here: simplicity over verifying the
// email address actually belongs to the person signing up.
export async function POST(request) {
  const supabaseAdmin = getSupabaseAdmin();
  const { name, email, password } = await request.json();

  if (!email || !password) {
    return Response.json({ error: "Email and password are required" }, { status: 400 });
  }
  if (password.length < 8) {
    return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { name: name || email },
    // role intentionally omitted — handle_new_user defaults new profiles to 'commercial'
  });

  if (error) {
    // Supabase returns a generic-looking message for "already registered" — pass it through
    // as-is rather than guessing, since the exact wording varies by version.
    return Response.json({ error: error.message }, { status: 400 });
  }

  return Response.json({ userId: data.user.id });
}
