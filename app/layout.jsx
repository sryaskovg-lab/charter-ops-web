export const metadata = { title: "Charter Ops — SCAT Airlines NSOC", description: "Charter scheduling & seat allotments" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F4F6FA", fontFamily: "'Inter',system-ui,sans-serif" }}>
        {children}
        <style>{`
          /* Everything is non-selectable by default — inputs/textareas/contenteditable are
             explicitly exempted so real editing still works normally. */
          body { -webkit-user-select: none; user-select: none; }
          input, textarea, [contenteditable="true"] { -webkit-user-select: text; user-select: text; }
        `}</style>
      </body>
    </html>
  );
}
