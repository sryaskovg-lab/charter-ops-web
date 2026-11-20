import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import path from "path";

// Liberation Sans carries Cyrillic; the standard PDF fonts do not.
const dir = path.join(process.cwd(), "app", "api", "reports", "quote", "fonts");
Font.register({ family: "Lib", fonts: [{ src: path.join(dir, "LiberationSans-Regular.ttf") }, { src: path.join(dir, "LiberationSans-Bold.ttf"), fontWeight: 700 }] });

const T = {
  ru: {
    title: "Расчет чартерного рейса по маршруту:", aircraft: "Тип ВС", pax: "Кол-во пассажиров", mtow: "Максимальная взлетная масса, т", date: "Дата расчета",
    direction: "Направление", distance: "Расстояние, км", time: "Налет, ч", fuel: "Расход ГСМ, т", total: "ВСЕГО по маршруту",
    airport: "Расходы в аэропорту", name: "Наименование", qty: "Кол-во", unit: "Ед.", price: "Цена USD", sum: "Сумма USD", subtotal: "Итого", kerosene: "Керосин",
    summary: "Итог", navEnroute: "Аэронавигация на маршруте", navTerminal: "Аэронавигация в районе аэродрома", hourCost: "Себестоимость летного часа", hour: "час",
    grand: "ВСЕГО стоимость заказного рейса по маршруту:", perSeat: "Стоимость за кресло", perBlock: "Стоимость блок часа", usd: "USD",
    units: { turnaround: "ед.", pax: "пас.", crew: "чел.", mtow_t: "тон.", fuel_t: "т.", litre: "л", time: "пер." },
  },
  en: {
    title: "Charter flight price calculation:", aircraft: "Aircraft type", pax: "Passengers", mtow: "Maximum take-off mass, t", date: "Calculation date",
    direction: "Sector", distance: "Distance, km", time: "Flight time, h", fuel: "Fuel, t", total: "Route total",
    airport: "Costs at airport", name: "Item", qty: "Qty", unit: "Unit", price: "Price USD", sum: "Sum USD", subtotal: "Subtotal", kerosene: "Fuel",
    summary: "Summary", navEnroute: "Air navigation, enroute", navTerminal: "Air navigation, aerodrome area", hourCost: "Flight hour cost", hour: "hour",
    grand: "TOTAL price of the charter flight:", perSeat: "Price per seat", perBlock: "Price per block hour", usd: "USD",
    units: { turnaround: "unit", pax: "pax", crew: "crew", mtow_t: "t MTOW", fuel_t: "t fuel", litre: "l", time: "period" },
  },
};
const S = StyleSheet.create({
  page: { padding: 28, fontSize: 8.5, fontFamily: "Lib" },
  h1: { fontSize: 14, fontWeight: 700, textAlign: "center" },
  route: { fontSize: 14, fontWeight: 700, textAlign: "center", marginTop: 4, marginBottom: 10 },
  meta: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  box: { border: "0.75 solid #333", marginBottom: 8 },
  head: { flexDirection: "row", backgroundColor: "#EEF1F6", fontWeight: 700, borderBottom: "0.75 solid #333" },
  row: { flexDirection: "row", borderBottom: "0.4 solid #CCC" },
  c: { padding: "2 4" },
  bar: { fontWeight: 700, textAlign: "center", padding: 3, borderBottom: "0.75 solid #333", backgroundColor: "#F6F7FA" },
});
const f0 = n => Math.round(n).toLocaleString("en-US").replace(/,/g, " ");
const f2 = n => (Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/,/g, " ");

export default function QuoteDocument({ q, input, lang, generated }) {
  const t = T[lang] || T.ru;
  const route = [input.legs[0]?.from, ...input.legs.map(l => l.to)].filter(Boolean).join(" - ");
  const unitOf = l => l.basis === "time" ? (l.periodMinutes ? `${l.periodMinutes} ${lang === "ru" ? "мин." : "min"}` : t.units.time) : t.units[l.basis];
  const W = [3.2, 0.8, 0.9, 1, 1.1];
  return (
    <Document>
      <Page size="A4" style={S.page}>
        <Text style={S.h1}>{t.title}</Text>
        <Text style={S.route}>{route}</Text>
        <View style={S.meta}>
          <Text>{t.aircraft}: <Text style={{ fontWeight: 700 }}>{input.aircraftName || input.aircraft.code}</Text></Text>
          <Text>{t.pax}: <Text style={{ fontWeight: 700 }}>{q.pax}</Text></Text>
          <Text>{t.mtow}: <Text style={{ fontWeight: 700 }}>{q.mtow}</Text></Text>
          <Text>{t.date}: {generated}</Text>
        </View>
        <View style={S.box}>
          <View style={S.head}>
            <Text style={{ ...S.c, flex: 3 }}>{t.direction}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{t.distance}</Text>
            <Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{t.time}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{t.fuel}</Text>
          </View>
          {q.legs.map((l, i) => <View key={i} style={S.row}>
            <Text style={{ ...S.c, flex: 3 }}>{l.from} - {l.to}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f0(l.km)}</Text>
            <Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f2(l.hours)}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f2(l.fuelT)}</Text>
          </View>)}
          <View style={{ ...S.row, fontWeight: 700 }}>
            <Text style={{ ...S.c, flex: 3 }}>{t.total}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f0(q.km)}</Text>
            <Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f2(q.hours)}</Text><Text style={{ ...S.c, flex: 1, textAlign: "right" }}>{f2(q.fuelT)}</Text>
          </View>
        </View>
        {q.blocks.map(b => (
          <View key={b.airport} style={S.box} wrap={false}>
            <Text style={S.bar}>{t.airport} {b.airport}</Text>
            <View style={S.head}>
              <Text style={{ ...S.c, flex: W[0] }}>{t.name}</Text><Text style={{ ...S.c, flex: W[1], textAlign: "right" }}>{t.qty}</Text>
              <Text style={{ ...S.c, flex: W[2] }}>{t.unit}</Text><Text style={{ ...S.c, flex: W[3], textAlign: "right" }}>{t.price}</Text><Text style={{ ...S.c, flex: W[4], textAlign: "right" }}>{t.sum}</Text>
            </View>
            {b.lines.map((l, i) => <View key={i} style={S.row}>
              <Text style={{ ...S.c, flex: W[0] }}>{l.name}</Text><Text style={{ ...S.c, flex: W[1], textAlign: "right" }}>{f2(l.qty)}</Text>
              <Text style={{ ...S.c, flex: W[2] }}>{unitOf(l)}</Text><Text style={{ ...S.c, flex: W[3], textAlign: "right" }}>{f2(l.price)}</Text><Text style={{ ...S.c, flex: W[4], textAlign: "right", fontWeight: 700 }}>{f0(l.total)}</Text>
            </View>)}
            {b.fuel.qty > 0 && <View style={S.row}>
              <Text style={{ ...S.c, flex: W[0] }}>{t.kerosene}</Text><Text style={{ ...S.c, flex: W[1], textAlign: "right" }}>{f2(b.fuel.qty)}</Text>
              <Text style={{ ...S.c, flex: W[2] }}>{t.units.fuel_t}</Text><Text style={{ ...S.c, flex: W[3], textAlign: "right" }}>{b.fuel.price == null ? "-" : f2(b.fuel.price)}</Text><Text style={{ ...S.c, flex: W[4], textAlign: "right", fontWeight: 700 }}>{f0(b.fuel.total)}</Text>
            </View>}
            <View style={{ ...S.row, fontWeight: 700 }}>
              <Text style={{ ...S.c, flex: W[0] + W[1] + W[2] + W[3] }}>{t.subtotal}</Text><Text style={{ ...S.c, flex: W[4], textAlign: "right" }}>{f0(b.total)}</Text>
            </View>
          </View>
        ))}
        <View style={S.box} wrap={false}>
          <Text style={S.bar}>{t.summary}</Text>
          {q.blocks.map(b => <View key={b.airport} style={S.row}><Text style={{ ...S.c, flex: 4 }}>{t.airport} {b.airport}</Text><Text style={{ ...S.c, flex: 1.2, textAlign: "right" }}>{f0(b.total)}</Text></View>)}
          <View style={S.row}><Text style={{ ...S.c, flex: 4 }}>{t.navEnroute}</Text><Text style={{ ...S.c, flex: 1.2, textAlign: "right" }}>{f0(q.nav.enroute)}</Text></View>
          <View style={S.row}><Text style={{ ...S.c, flex: 4 }}>{t.navTerminal}</Text><Text style={{ ...S.c, flex: 1.2, textAlign: "right" }}>{f0(q.nav.terminal)}</Text></View>
          <View style={S.row}><Text style={{ ...S.c, flex: 4 }}>{t.hourCost}: {f2(q.flightHours.hours)} {t.hour} x {f0(q.flightHours.rate)}</Text><Text style={{ ...S.c, flex: 1.2, textAlign: "right" }}>{f0(q.flightHours.total)}</Text></View>
          <View style={{ ...S.row, fontWeight: 700, backgroundColor: "#EEF1F6" }}><Text style={{ ...S.c, flex: 4 }}>{t.total}</Text><Text style={{ ...S.c, flex: 1.2, textAlign: "right" }}>{f0(q.total)}</Text></View>
        </View>
        <View style={{ ...S.box, padding: 8 }} wrap={false}>
          <Text style={{ fontSize: 10 }}>{t.grand}  <Text style={{ fontSize: 16, fontWeight: 700 }}>{f0(q.total)} {t.usd}</Text></Text>
          <Text style={{ fontSize: 11, marginTop: 6 }}>{t.perSeat}: <Text style={{ fontWeight: 700 }}>{f0(q.perSeat)} {t.usd}</Text>     {t.perBlock}: <Text style={{ fontWeight: 700 }}>{f0(q.perBlockHour)} {t.usd}</Text></Text>
        </View>
      </Page>
    </Document>
  );
}
