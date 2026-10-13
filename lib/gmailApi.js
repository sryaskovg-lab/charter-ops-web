// Server-only Gmail REST helpers (no packages). One refresh token serves reading (gmail.readonly)
// and, once it was issued with gmail.compose too, drafting and sending.
export function mailConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

export async function accessToken() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google sign-in failed: ${j.error_description || j.error || res.status}. The refresh token may have expired or been revoked.`);
  return j.access_token;
}

export async function gmailPost(token, path, body) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const scope = res.status === 403 && /scope|insufficient/i.test(JSON.stringify(j));
    throw new Error(scope
      ? "Google has not allowed drafting/sending yet: re-create the refresh token with the extra scope https://www.googleapis.com/auth/gmail.compose (see setup guide), then update GOOGLE_REFRESH_TOKEN in Vercel and redeploy."
      : `Gmail error (${res.status}): ${j.error?.message || "unknown"}`);
  }
  return j;
}

export const createDraft = (token, raw) => gmailPost(token, "drafts", { message: { raw } });
export const sendRaw = (token, raw) => gmailPost(token, "messages/send", { raw });
