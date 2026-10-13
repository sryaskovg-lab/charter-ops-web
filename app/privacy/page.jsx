export const metadata = { title: "Privacy policy — Charter Ops", description: "How Charter Ops handles Gmail data" };

const h2 = { fontSize: 17, margin: "26px 0 8px" };
const p = { lineHeight: 1.6, margin: "8px 0", color: "#2B3340" };

// Public page (no sign-in): Google's OAuth consent screen requires a privacy policy URL.
export default function Privacy() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 20px 80px", userSelect: "text", WebkitUserSelect: "text" }}>
      <h1 style={{ fontSize: 26, margin: 0 }}>Privacy policy</h1>
      <p style={{ ...p, color: "#667085" }}>Charter Ops (“Charter Ops Mail” on Google’s consent screen). Last updated: 13 October 2026.</p>

      <h2 style={h2}>What this is</h2>
      <p style={p}>Charter Ops is an internal operations tool of an airline for scheduling charter flights, managing tour-operator seat allotments and tracking overfly permits. It is used only by the airline’s own staff. It is not offered to the public.</p>

      <h2 style={h2}>What we access in Google</h2>
      <p style={p}>One company mailbox is connected, once, by an administrator. The application then:</p>
      <ul style={{ ...p, paddingLeft: 22 }}>
        <li>reads e-mails that carry a single Gmail label (default “Permits”), from the last 60 days, so that permit approvals sent by aviation authorities can be filed on the matching permit request;</li>
        <li>creates draft permit-request e-mails in that mailbox for a person to review and send;</li>
        <li>sends a daily alert e-mail to a short list of staff addresses when a flight departs within four days without an approved permit.</li>
      </ul>
      <p style={p}>It does not read e-mails without the label, does not delete or change existing e-mails, and does not read contacts, calendars or any other Google data.</p>

      <h2 style={h2}>What is stored</h2>
      <p style={p}>For each labelled e-mail the application stores the sender, subject, date, the plain-text body and any attachments in the airline’s own private database and file storage, linked to the permit they concern. Access is limited to signed-in, approved staff. The Google access token is kept only as a server-side secret and is never shown in the application.</p>

      <h2 style={h2}>Use and sharing</h2>
      <p style={p}>Data obtained from Google is used only to provide the permit features described above. It is not sold, not shared with third parties, not used for advertising, and not used to train AI or machine-learning models. No person reads it other than authorised staff using the application. The application’s use of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements.</p>

      <h2 style={h2}>Retention and deletion</h2>
      <p style={p}>Stored e-mails and documents are kept as part of the permit record. Staff can delete a permit and its notes in the application. To remove the Google connection, revoke the app at myaccount.google.com/permissions; the application can then no longer read the mailbox. To request deletion of stored data, contact the address below.</p>

      <h2 style={h2}>Contact</h2>
      <p style={p}>Questions about this policy: s.ryaskov.g@gmail.com</p>
    </main>
  );
}
