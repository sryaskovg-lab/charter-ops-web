import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import path from "path";

// Liberation Sans carries Cyrillic; the standard PDF fonts do not (used for the Russian version).
const dir = path.join(process.cwd(), "app", "api", "reports", "quote", "fonts");
Font.register({ family: "Lib", fonts: [{ src: path.join(dir, "LiberationSans-Regular.ttf") }, { src: path.join(dir, "LiberationSans-Bold.ttf"), fontWeight: 700 }] });

const T = {
  en: { title: "Fuel prices by airport", sub: "Every airport in the schedule · generated {g} UTC", airports: "Airports in schedule", priced: "With a price", missing: "Without a price", airport: "Airport", name: "Name", flights: "Flights", price: "Price", unit: "Unit", supplier: "Supplier", from: "Valid from", upd: "Updated", none: "no price", foot: "Charter Ops · fuel prices", page: "Page {p} of {n}" },
  ru: { title: "Цены на топливо по аэропортам", sub: "Все аэропорты расписания · сформировано {g} UTC", airports: "Аэропортов в расписании", priced: "С ценой", missing: "Без цены", airport: "Аэропорт", name: "Название", flights: "Рейсы", price: "Цена", unit: "Единица", supplier: "Поставщик", from: "Действует с", upd: "Обновлено", none: "нет цены", foot: "Charter Ops · цены на топливо", page: "Страница {p} из {n}" },
};

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

export default function FuelDocument({ rows, generated, priced, lang }) {
  const t = T[lang] || T.en;
  const missing = rows.length - priced;
  return (
    <Document>
      <Page size="A4" orientation="landscape" style={{ ...S.page, fontFamily: lang === "ru" ? "Lib" : "Helvetica" }}>
        <Text style={S.h1}>{t.title}</Text>
        <Text style={S.sub}>{t.sub.replace("{g}", generated)}</Text>
        <View style={S.stats}>
          <View><Text style={S.num}>{rows.length}</Text><Text>{t.airports}</Text></View>
          <View><Text style={S.num}>{priced}</Text><Text>{t.priced}</Text></View>
          <View><Text style={{ ...S.num, color: missing ? "#B26A00" : "#1FAA59" }}>{missing}</Text><Text>{t.missing}</Text></View>
        </View>
        <View style={S.head} fixed>
          <Text style={{ ...S.c, width: W.code }}>{t.airport}</Text><Text style={{ ...S.c, width: W.name }}>{t.name}</Text>
          <Text style={{ ...S.c, width: W.flights }}>{t.flights}</Text><Text style={{ ...S.c, width: W.price }}>{t.price}</Text>
          <Text style={{ ...S.c, width: W.unit }}>{t.unit}</Text><Text style={{ ...S.c, width: W.supplier }}>{t.supplier}</Text>
          <Text style={{ ...S.c, width: W.from }}>{t.from}</Text><Text style={{ ...S.c, width: W.upd }}>{t.upd}</Text>
        </View>
        {rows.map(r => (
          <View key={r.code} style={r.price == null ? { ...S.row, ...S.missing } : S.row} wrap={false}>
            <Text style={{ ...S.c, width: W.code, fontWeight: 700 }}>{r.code}</Text>
            <Text style={{ ...S.c, width: W.name }}>{r.name || ""}</Text>
            <Text style={{ ...S.c, width: W.flights }}>{r.flights}</Text>
            <Text style={{ ...S.c, width: W.price }}>{r.price == null ? t.none : String(r.price)}</Text>
            <Text style={{ ...S.c, width: W.unit }}>{r.price == null ? "" : r.unit}</Text>
            <Text style={{ ...S.c, width: W.supplier }}>{r.supplier || ""}</Text>
            <Text style={{ ...S.c, width: W.from }}>{r.valid_from || ""}</Text>
            <Text style={{ ...S.c, width: W.upd }}>{r.updated || ""}</Text>
          </View>
        ))}
        <View style={S.foot} fixed>
          <Text>{t.foot}</Text>
          <Text render={({ pageNumber, totalPages }) => t.page.replace("{p}", pageNumber).replace("{n}", totalPages)} />
        </View>
      </Page>
    </Document>
  );
}
