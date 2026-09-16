export const metadata = { title: "Charter Ops — SCAT Airlines NSOC", description: "Charter scheduling & seat allotments" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#F4F6FA", fontFamily: "'Inter',system-ui,sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
