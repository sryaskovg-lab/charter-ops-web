export const metadata = { title: "Charter Ops", description: "Charter scheduling & seat allotments" };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0B1120", fontFamily: "'Inter',system-ui,sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
