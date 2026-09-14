import { createClient } from "@supabase/supabase-js";

// Server-only. SUPABASE_SERVICE_ROLE_KEY must NOT have the NEXT_PUBLIC_ prefix — that prefix is
// what tells Next.js to ship a variable to the browser bundle. This key bypasses every RLS
// policy, so it only ever belongs in a Route Handler (server-side), never in client code.
//
// Built lazily (on first actual use) rather than at module load time. Next.js executes Route
// Handler modules during its build-time "Collecting page data" step — if this client were
// constructed at import time and an env var were unavailable in that specific process, it
// would crash the *entire build*, not just the one request that needed it. Deferring
// construction means a missing var instead surfaces as a clear runtime error on the one
// endpoint that's actually misconfigured.
let _client = null;
export function getSupabaseAdmin() {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Supabase admin client is missing configuration: " +
      (!url ? "NEXT_PUBLIC_SUPABASE_URL " : "") + (!key ? "SUPABASE_SERVICE_ROLE_KEY " : "") +
      "not set. Check Vercel → Settings → Environment Variables, and redeploy after fixing."
    );
  }
  _client = createClient(url, key);
  return _client;
}
