import { describe, it, expect } from "vitest";
import { computeQuote, computeLegs, stationsForLegs, applicableLines, fuelUsdPerTonne } from "./charter-calc";

// The CIT - VIE - CIT sample sheet (MAX 8, 82 t, 189 passengers).
const AC = { code: "max8", mtow: 82, seats: 189, burnTPerH: 2.4, cruiseKmh: 850, hourCost: 4000 };
const CIT = [
  ["Буксировка", "turnaround", 88.89, 1], ["Водило", "turnaround", 12.22, 1], ["Внутренняя уборка ВС", "turnaround", 133.33, 1],
  ["Автотрап", "time", 22.22, 3], ["Телетрап", "time", 22.22, 10], ["Санузлы", "time", 26.92, 2], ["Вода", "time", 32.68, 1], ["Сопровождение", "time", 19.84, 1],
  ["Мед.осмотр", "crew", 2.13], ["Питание экипажа", "crew", 10.92], ["Авиабезопасность пас.", "pax", 2.62], ["Обслуживание пас.", "pax", 12.22], ["Питание пас.", "pax", 8.69],
  ["Встреча-выпуск", "mtow_t", 1.33], ["Сбор за авиабезопасность", "mtow_t", 4.13], ["Сбор за взлет-посадку", "mtow_t", 6.98], ["Обеспечение ГСМ", "fuel_t", 36.53],
].map(([name, basis, price, qty]) => ({ name, basis, price, qty }));
const VIE = [
  ["Наземное обслуживание", "turnaround", 5550], ["Шум", "turnaround", 11.1], ["Инфраструктура", "turnaround", 272.42], ["Пролет", "turnaround", 5.99], ["Парковка", "turnaround", 145.37], ["Посадка", "turnaround", 969.13],
  ["PRM", "pax", 0.95], ["Инфраструктурный сбор", "pax", 1.2], ["Обслуживание пас.", "pax", 22.77], ["Авиабезопасность", "pax", 11.68], ["Питание пас.", "pax", 27], ["Питание экипажа", "crew", 29],
].map(([name, basis, price]) => ({ name, basis, price, qty: 1 }));

describe("charter-calc", () => {
  it("derives time and fuel from distance", () => {
    const legs = computeLegs([{ from: "CIT", to: "VIE", km: 6095 }, { from: "VIE", to: "CIT", km: 5525 }], AC);
    expect(legs.map(l => [l.hours, l.fuelT])).toEqual([[7.17, 17.21], [6.5, 15.6]]);
  });
  it("lists one station per departure and skips the home station on return", () => {
    const legs = computeLegs([{ from: "CIT", to: "VIE", km: 6095 }, { from: "VIE", to: "CIT", km: 5525 }], AC);
    expect(stationsForLegs(legs).map(s => [s.airport, s.uplift])).toEqual([["CIT", 17.21], ["VIE", 15.6]]);
    expect(stationsForLegs(computeLegs([{ from: "A", to: "B", km: 850 }, { from: "B", to: "C", km: 850 }], AC)).map(s => s.airport)).toEqual(["A", "B", "C"]);
  });
  it("reproduces the sample total within rounding", () => {
    const q = computeQuote({
      aircraft: AC, pax: 189, crew: 7, hourCost: 4000,
      legs: [{ from: "CIT", to: "VIE", km: 6095 }, { from: "VIE", to: "CIT", km: 5525 }],
      blocks: [{ airport: "CIT", uplift: 17.21, fuelUsdPerT: 1288.89, lines: CIT }, { airport: "VIE", uplift: 15.6, fuelUsdPerT: 2235, lines: VIE }],
      nav: { enroutePerKm: 0.5, terminalPerLeg: 458 },
    });
    expect(q.km).toBe(11620); expect(q.hours).toBe(13.67); expect(q.fuelT).toBe(32.81);
    expect(q.blocks[0].total).toBeGreaterThan(28990); expect(q.blocks[0].total).toBeLessThan(29010);
    expect(q.blocks[1].total).toBeGreaterThan(54030); expect(q.blocks[1].total).toBeLessThan(54060);
    expect(q.nav.enroute).toBe(5810); expect(q.nav.terminal).toBe(916);
    expect(q.flightHours.total).toBeCloseTo(54680, 0);
    expect(Math.abs(q.total - 144445)).toBeLessThan(40);
    expect(Math.abs(q.perSeat - 764)).toBeLessThan(1);
    expect(Math.abs(q.perBlockHour - 10567)).toBeLessThan(5);
  });
  it("flags a station without a fuel price", () => {
    const q = computeQuote({ aircraft: AC, legs: [{ from: "A", to: "B", km: 850 }], blocks: [{ airport: "A", uplift: 2.4, fuelUsdPerT: null, lines: [] }], nav: {} });
    expect(q.missingFuel).toEqual(["A"]);
  });
  it("leaves out lines tagged for another aircraft type", () => {
    const lines = [{ name: "x", aircraftType: "max9" }, { name: "y", aircraftType: "max8" }, { name: "z" }];
    expect(applicableLines(lines, "max8").map(l => l.name)).toEqual(["y", "z"]);
  });
  it("converts fuel price units to USD per tonne", () => {
    expect(fuelUsdPerTonne(1200, "USD/tonne")).toBe(1200);
    expect(fuelUsdPerTonne(1.2, "USD/kg")).toBeCloseTo(1200, 5);
    expect(fuelUsdPerTonne(1, "bad")).toBeNull();
  });
});
