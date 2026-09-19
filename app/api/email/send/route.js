import { Resend } from "resend";

// Generic send endpoint reused by both "send SCR to coordinator" and "email PDF report" — the
// caller decides content; this route only handles actually dispatching it. Attachment content
// arrives as a base64 string (the client already has the PDF bytes from a prior fetch, or the
// SCR is plain text with no attachment).
export async function POST(request) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return Response.json({ error: "RESEND_API_KEY is not set for this deployment. Add it in Vercel → Settings → Environment Variables, then redeploy." }, { status: 500 });

    const { to, subject, text, fromName, attachmentBase64, attachmentFilename } = await request.json();
    if (!to || !subject || !text) return Response.json({ error: "to, subject, and text are required." }, { status: 400 });

    const resend = new Resend(apiKey);
    const fromAddress = process.env.RESEND_FROM_ADDRESS || "onboarding@resend.dev"; // test-only default — set RESEND_FROM_ADDRESS to a verified domain address for real production sends
    const { data, error } = await resend.emails.send({
      from: fromName ? `${fromName} <${fromAddress}>` : fromAddress,
      to: Array.isArray(to) ? to : [to],
      subject,
      text,
      ...(attachmentBase64 ? { attachments: [{ filename: attachmentFilename || "attachment.pdf", content: attachmentBase64 }] } : {}),
    });
    if (error) return Response.json({ error: error.message || "Resend rejected the send." }, { status: 502 });

    return Response.json({ id: data.id });
  } catch (err) {
    console.error("Email send failed:", err);
    return Response.json({ error: err.message || "Email send failed" }, { status: 500 });
  }
}
