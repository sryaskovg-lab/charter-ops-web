import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica" },
  h1: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  h2: { fontSize: 12, fontWeight: 700, marginTop: 16, marginBottom: 6, borderBottom: "1 solid #E2E7F0", paddingBottom: 3 },
  sub: { fontSize: 9, color: "#6B7686", marginBottom: 10 },
  row: { flexDirection: "row", borderBottom: "0.5 solid #EBEEF5", paddingVertical: 3 },
  headerRow: { flexDirection: "row", backgroundColor: "#F4F6FA", paddingVertical: 4, fontWeight: 700 },
  cell: { flex: 1, paddingHorizontal: 3 },
  cellWide: { flex: 2, paddingHorizontal: 3 },
  small: { fontSize: 8, color: "#6B7686" },
  empty: { fontSize: 9, color: "#A7B0BE", marginTop: 4, marginBottom: 8, fontStyle: "italic" },
  revenueBox: { flexDirection: "row", gap: 16, marginBottom: 10 },
  revenueStat: { fontSize: 9 },
  revenueNum: { fontSize: 14, fontWeight: 700, color: "#1FAA59" },
});

function iso(d) { return new Date(d).toISOString().slice(0, 10); }
function hhmm(d) { const x = new Date(d); return String(x.getUTCHours()).padStart(2, "0") + ":" + String(x.getUTCMinutes()).padStart(2, "0"); }

export default function ReportDocument({ startDate, endDate, sections, data }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.h1}>Charter Ops report</Text>
        <Text style={styles.sub}>{startDate} to {endDate} · generated {new Date().toISOString().slice(0, 16).replace("T", " ")} UTC</Text>

        {sections.includes("schedule") && (
          <View>
            <Text style={styles.h2}>Schedule</Text>
            {data.flights.length === 0 ? <Text style={styles.empty}>No flights in this range.</Text> : (
              <View>
                <View style={styles.headerRow}>
                  <Text style={styles.cell}>Date</Text><Text style={styles.cell}>Ref</Text><Text style={styles.cell}>Aircraft</Text>
                  <Text style={styles.cell}>Route</Text><Text style={styles.cell}>Dep/Arr</Text><Text style={styles.cell}>Status</Text>
                </View>
                {data.flights.map(f => (
                  <View key={f.id} style={styles.row}>
                    <Text style={styles.cell}>{iso(f.scheduled_departure)}</Text><Text style={styles.cell}>{f.ref}</Text>
                    <Text style={styles.cell}>{data.resourceCodeById[f.resource_id] || "?"}</Text>
                    <Text style={styles.cell}>{f.origin}-{f.destination}</Text>
                    <Text style={styles.cell}>{hhmm(f.scheduled_departure)}-{f.scheduled_arrival ? hhmm(f.scheduled_arrival) : "?"}</Text>
                    <Text style={styles.cell}>{f.status}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {sections.includes("revenue") && (
          <View>
            <Text style={styles.h2}>Revenue</Text>
            <View style={styles.revenueBox}>
              <View><Text style={styles.revenueNum}>${data.totalRevenue.toLocaleString()}</Text><Text style={styles.revenueStat}>Total revenue</Text></View>
              <View><Text style={styles.revenueNum}>{data.totalSeatsSold}</Text><Text style={styles.revenueStat}>Seats sold</Text></View>
            </View>
            {Object.keys(data.revenueByOperator).length === 0 ? <Text style={styles.empty}>No active allotments in this range.</Text> : (
              <View>
                <View style={styles.headerRow}><Text style={styles.cellWide}>Operator</Text><Text style={styles.cell}>Seats</Text><Text style={styles.cell}>Revenue</Text></View>
                {Object.entries(data.revenueByOperator).map(([name, v]) => (
                  <View key={name} style={styles.row}><Text style={styles.cellWide}>{name}</Text><Text style={styles.cell}>{v.seats}</Text><Text style={styles.cell}>${v.revenue.toLocaleString()}</Text></View>
                ))}
              </View>
            )}
          </View>
        )}

        {sections.includes("allotments") && (
          <View>
            <Text style={styles.h2}>Tour operator allotments</Text>
            {data.allotments.length === 0 ? <Text style={styles.empty}>No allotments in this range.</Text> : (
              <View>
                <View style={styles.headerRow}>
                  <Text style={styles.cell}>Flight</Text><Text style={styles.cell}>Date</Text><Text style={styles.cellWide}>Operator</Text>
                  <Text style={styles.cell}>Seats</Text><Text style={styles.cell}>$/seat</Text><Text style={styles.cell}>Status</Text>
                </View>
                {data.allotments.map(a => (
                  <View key={a.id} style={styles.row}>
                    <Text style={styles.cell}>{data.flightRefById[a.flight_id] || "?"}</Text>
                    <Text style={styles.cell}>{data.flightDateById[a.flight_id] || "?"}</Text>
                    <Text style={styles.cellWide}>{data.operatorNameById[a.tour_operator_id] || "?"}</Text>
                    <Text style={styles.cell}>{a.seats_allocated}</Text><Text style={styles.cell}>${a.price_per_seat}</Text><Text style={styles.cell}>{a.status}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {sections.includes("utilization") && (
          <View>
            <Text style={styles.h2}>Fleet utilization</Text>
            <View style={styles.headerRow}><Text style={styles.cellWide}>Aircraft</Text><Text style={styles.cell}>Type</Text><Text style={styles.cell}>Flights</Text><Text style={styles.cell}>Seats sold</Text></View>
            {data.utilization.map(u => (
              <View key={u.code} style={styles.row}><Text style={styles.cellWide}>{u.code}</Text><Text style={styles.cell}>{u.variant}</Text><Text style={styles.cell}>{u.flightCount}</Text><Text style={styles.cell}>{u.seatsSold}</Text></View>
            ))}
          </View>
        )}

        {sections.includes("issues") && (
          <View>
            <Text style={styles.h2}>Schedule issues</Text>
            {data.issues.length === 0 ? <Text style={styles.empty}>No issues found in this range.</Text> : (
              <View>
                {data.issues.map(iss => (
                  <View key={iss.id} style={{ marginBottom: 5 }}>
                    <Text style={{ fontWeight: 700, fontSize: 8, color: iss.severity === "error" ? "#E0473B" : "#3B6FE0" }}>{iss.kind.toUpperCase()}</Text>
                    <Text>{iss.message}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        )}

        {sections.includes("scr") && (
          <View>
            <Text style={styles.h2}>SCR message archive</Text>
            {data.scrLog.length === 0 ? <Text style={styles.empty}>No SCR messages sent in this range.</Text> : data.scrLog.map(s => (
              <View key={s.id} style={{ marginBottom: 8, borderBottom: "0.5 solid #EBEEF5", paddingBottom: 6 }}>
                <Text style={styles.small}>{iso(s.created_at)} · {s.clearance_airport} · season {s.season}</Text>
                <Text style={{ fontFamily: "Courier", fontSize: 8, marginTop: 2 }}>{s.message_text}</Text>
              </View>
            ))}
          </View>
        )}
      </Page>
    </Document>
  );
}
