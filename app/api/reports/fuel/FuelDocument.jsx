import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

const S = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica" },
  h1: { fontSize: 16, fontWeight: 700, marginBottom: 2 },
  sub: { fontSize: 9, color: "#6B7686", marginBottom: 10 },
  stats: { flexDirection: "row", gap: 24, marginBottom: 10 },
  num: { fontSize: 14, fontWeight: 700 },
  head: { flexDirection: "row", backgroundColor: "#F4F6FA", paddingVertical: 4, fontWeight: 700 },
  row: { flexDirection: "row", borderBottom: "0.5 solid #EBEEF5", paddingVertical: 3 },
  missing: { backgroundColor: "#FFF6E5" },
  c: { paddingHorizontal: 3 },
  small: { fontSize: 7.5, color: "#6B7686" },
  foot: { position: "absolute", bottom: 18, left: 32, right: 32, fontSize: 7.5, color: "#A7B0BE", flexDirection: "row", justifyContent: "space-between" },
});
const W = { code: 34, name: 150, flights: 40, price: 54, unit: 56, supplier: 78, from: 56, upd: 56 };

export default function FuelDocument({ rows, generated, priced }) {
  const missing = rows.length - priced;
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={S.page}>
        <Text style={S.h1}>Fuel prices by airport</Text>
        <Text style={S.sub}>Every airport in the schedule · generated {generated} UTC</Text>
        <View style={S.stats}>
          <View><Text style={S.num}>{rows.length}</Text><Text>Airports in schedule</Text></View>
          <View><Text style={S.num}>{priced}</Text><Text>With a price</Text></View>
          <View><Text style={{ ...S.num, color: missing ? "#B26A00" : "#1FAA59" }}>{missing}</Text><Text>Without a price</Text></View>
        </View>
        <View style={S.head} fixed>
          <Text style={{ ...S.c, width: W.code }}>Airport</Text><Text style={{ ...S.c, width: W.name }}>Name</Text>
          <Text style={{ ...S.c, width: W.flights }}>Flights</Text><Text style={{ ...S.c, width: W.price }}>Price</Text>
          <Text style={{ ...S.c, width: W.unit }}>Unit</Text><Text style={{ ...S.c, width: W.supplier }}>Supplier</Text>
          <Text style={{ ...S.c, width: W.from }}>Valid from</Text><Text style={{ ...S.c, width: W.upd }}>Updated</Text>
        </View>
        {rows.map(r => (
          <View key={r.code} style={r.price == null ? { ...S.row, ...S.missing } : S.row} wrap={false}>
            <Text style={{ ...S.c, width: W.code, fontWeight: 700 }}>{r.code}</Text>
            <Text style={{ ...S.c, width: W.name }}>{r.name || ""}</Text>
            <Text style={{ ...S.c, width: W.flights }}>{r.flights}</Text>
            <Text style={{ ...S.c, width: W.price }}>{r.price == null ? "no price" : String(r.price)}</Text>
            <Text style={{ ...S.c, width: W.unit }}>{r.price == null ? "" : r.unit}</Text>
            <Text style={{ ...S.c, width: W.supplier }}>{r.supplier || ""}</Text>
            <Text style={{ ...S.c, width: W.from }}>{r.valid_from || ""}</Text>
            <Text style={{ ...S.c, width: W.upd }}>{r.updated || ""}</Text>
          </View>
        ))}
        <View style={S.foot} fixed>
          <Text>Charter Ops · fuel prices</Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
