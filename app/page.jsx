"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabaseClient";
import CharterOpsApp from "../components/CharterOpsApp";

export default function HomePage() {
  const [profile, setProfile] = useState(null);
  const [checking, setChecking] = useState(true);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { router.push("/login"); return; }
      const { data, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).single();
      if (cancelled) return;
      if (error || !data) { router.push("/login"); return; }
      setProfile(data);
      setChecking(false);
    }
    load();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) router.push("/login");
    });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [router]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  if (checking || !profile) {
    return <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#7E8CAD", fontFamily: "monospace" }}>Loading…</div>;
  }

  return (
    <main style={{ padding: 20, maxWidth: 1400, margin: "0 auto" }}>
      <CharterOpsApp profile={profile} onSignOut={handleSignOut} />
    </main>
  );
}
