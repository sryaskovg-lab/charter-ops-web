import { createClient } from "@supabase/supabase-js";

// Fallback values only prevent createClient() from throwing synchronously during Next.js's
// build-time module execution if the env vars are momentarily unavailable in that process —
// they are never used for a real request. At actual runtime (browser or server), Vercel
// injects the real NEXT_PUBLIC_SUPABASE_URL/ANON_KEY, so this only matters at build time.
export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key"
);
