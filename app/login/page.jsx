"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../../lib/supabaseClient";

const C = { bg: "#F4F6FA", panel: "#FFFFFF", border: "#E2E7F0", text: "#1E2A3D", muted: "#6B7686", amber: "#3B6FE0", red: "#E0473B" };
const inputStyle = { background: "#F4F6FA", border: `1px solid ${C.border}`, color: C.text, borderRadius: 6, padding: "9px 11px", fontSize: 13.5 };
const btnStyle = { background: C.amber, color: "#FFFFFF", fontWeight: 600, border: "none", borderRadius: 6, padding: "10px 0", cursor: "pointer", fontSize: 13.5 };

export default function LoginPage() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup"
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function handleSignIn(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    router.push("/");
  }

  async function handleSignUp(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await res.json();
    if (!res.ok) { setBusy(false); setError(data.error); return; }
    // Account created with no email-confirmation step — sign straight in with the same
    // credentials rather than sending the person back to a separate login screen.
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) { setError(signInError.message); return; }
    router.push("/");
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: C.text, background: C.bg, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" }}>
      <img src="/logo-full.png" alt="SCAT Airlines — Non-Scheduled Operations Complex" style={{ width: 260, maxWidth: "80vw", height: "auto", marginBottom: 28 }} />
      <form onSubmit={mode === "signin" ? handleSignIn : handleSignUp} style={{ background: C.panel, border: `1px solid ${C.border}`, borderRadius: 12, padding: 28, width: 340, boxShadow: "0 8px 30px rgba(30,42,61,0.08)" }}>
        <div style={{ fontWeight: 700, letterSpacing: 0.3, marginBottom: 4, fontSize: 15 }}>CHARTER OPS</div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 18 }}>{mode === "signin" ? "Sign in to your account" : "Create your account — takes a minute"}</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {mode === "signup" && (
            <input placeholder="Your name" value={name} onChange={e => setName(e.target.value)} required style={inputStyle} />
          )}
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required style={inputStyle} />
          <input type="password" placeholder={mode === "signup" ? "Choose a password (min. 8 characters)" : "Password"} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === "signup" ? 8 : undefined} style={inputStyle} />
          {error && <div style={{ color: C.red, fontSize: 12.5 }}>{error}</div>}
          <button type="submit" disabled={busy} style={btnStyle}>
            {busy ? (mode === "signin" ? "Signing in…" : "Creating account…") : (mode === "signin" ? "Sign in" : "Create account")}
          </button>
        </div>

        <div style={{ fontSize: 12, color: C.muted, marginTop: 16, textAlign: "center" }}>
          {mode === "signin" ? (
            <>No account yet? <button type="button" onClick={() => { setMode("signup"); setError(null); }} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontSize: 12, padding: 0 }}>Create one</button></>
          ) : (
            <>Already have an account? <button type="button" onClick={() => { setMode("signin"); setError(null); }} style={{ background: "none", border: "none", color: C.amber, cursor: "pointer", fontSize: 12, padding: 0 }}>Sign in</button></>
          )}
        </div>
        {mode === "signup" && <div style={{ fontSize: 10.5, color: C.muted, marginTop: 10, lineHeight: 1.4 }}>New accounts start with commercial-staff access. A manager can change your role afterward from the Team tab.</div>}
      </form>
    </div>
  );
}
