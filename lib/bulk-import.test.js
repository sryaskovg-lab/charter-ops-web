import { describe, it, expect } from "vitest";
import { parseFuelGrid, parseFeesGrid, parseTimesGrid, toMonth, toMinutes, toNumber, cleanCode, pickFuelPrice, toCsv } from "./bulk-import";

describe("cells", () => {
  it("reads numbers, months, times and codes", () => {
    expect(toNumber("1 234,50")).toBe(1234.5);
    expect(toNumber("$1,234.50")).toBe(1234.5);
    expect(toMonth("11.2026")).toBe("2026-11-01");
    expect(toMonth("Nov 2026")).toBe("2026-11-01");
    expect(toMonth("2026-10-15")).toBe("2026-10-01");
    expect(toMinutes("7:35")).toBe(455);
    expect(toMinutes(7.5, "h")).toBe(450);
    expect(toMinutes(0.0625)).toBe(90);
    expect(cleanCode("СIТ")).toBe("CIT");
  });
});

describe("fuel", () => {
  it("reads the long layout with a default month", () => {
    const r = parseFuelGrid([["Airport", "Price", "Unit"], ["ALA", "850", ""], ["NQZ", "x", ""]], { defaultMonth: "2026-11-01" });
    expect(r.rows).toEqual([{ airport: "ALA", month: "2026-11-01", price: 850, unit: "USD/tonne", supplier: null, note: null }]);
    expect(r.errors).toHaveLength(1);
  });
  it("reads one column per month", () => {
    const r = parseFuelGrid([["Airport", "2026-10", "2026-11"], ["ALA", 800, 810], ["NQZ", null, 900]]);
    expect(r.wide).toBe(true);
    expect(r.rows.map(x => `${x.airport}${x.month}${x.price}`)).toEqual(["ALA2026-10-01800", "ALA2026-11-01810", "NQZ2026-11-01900"]);
  });
  it("refuses an unknown airport when a list is given", () => {
    const r = parseFuelGrid([["Airport", "Price"], ["ZZZ", 1]], { defaultMonth: "2026-11-01", knownAirports: new Set(["ALA"]) });
    expect(r.rows).toHaveLength(0);
  });
});

describe("fees", () => {
  const head = ["Airport", "Fee set", "Name", "Charged per", "Price USD", "Quantity", "Period min", "Aircraft type"];
  it("reads rows and keeps the aircraft code spelling", () => {
    const r = parseFeesGrid([head, ["ALA", "МВЛ", "Landing", "per tonne MTOW", 1.2], ["ALA", "INT", "Parking", "per period", 30, 1, 60, "max9"]], { aircraftCodes: ["max9"] });
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({ fee_set: "INT", basis: "mtow_t", price_usd: 1.2 });
    expect(r.rows[1]).toMatchObject({ basis: "time", period_minutes: 60, aircraft_type: "max9" });
  });
  it("reports bad lines with their line number", () => {
    const r = parseFeesGrid([head, ["ALA", "INT", "Bad", "weekly", 1], ["ALA", "INT", "Parking", "per period", 5]]);
    expect(r.rows).toHaveLength(0);
    expect(r.errors.map(e => e.line)).toEqual([2, 3]);
  });
});

describe("route times", () => {
  it("reads time as h:mm, minutes or hours", () => {
    expect(parseTimesGrid([["From", "To", "Avg flight time", "km"], ["ALA", "PQC", "7:35", 5800]]).rows[0]).toEqual({ origin: "ALA", destination: "PQC", avg_minutes: 455, km: 5800 });
    expect(parseTimesGrid([["From", "To", "Minutes"], ["ALA", "NQZ", 85]]).rows[0].avg_minutes).toBe(85);
    expect(parseTimesGrid([["From", "To", "Hours"], ["ALA", "PQC", 7.5]]).rows[0].avg_minutes).toBe(450);
  });
  it("rejects the same airport twice in a row", () => {
    expect(parseTimesGrid([["From", "To", "Minutes"], ["ALA", "ALA", 85]]).rows).toHaveLength(0);
  });
});

describe("fuel price for a month", () => {
  const hist = [{ airport: "ALA", month: "2026-09-01", price: 780, unit: "USD/tonne" }, { airport: "ALA", month: "2026-11-01", price: 820, unit: "USD/tonne" }];
  const current = new Map([["ALA", { price: 820, unit: "USD/tonne" }], ["NQZ", { price: 900, unit: "USD/tonne" }]]);
  it("uses the month, else the latest earlier month, else the current price", () => {
    expect(pickFuelPrice(hist, current, "ALA", "2026-11-01")).toMatchObject({ price: 820, exact: true });
    expect(pickFuelPrice(hist, current, "ALA", "2026-10-01")).toMatchObject({ price: 780, exact: false, month: "2026-09" });
    expect(pickFuelPrice(hist, current, "ALA", "2026-01-01")).toMatchObject({ price: 820, month: null });
    expect(pickFuelPrice(hist, current, "NQZ", "2026-10-01").price).toBe(900);
    expect(pickFuelPrice(hist, current, "XXX", "2026-10-01")).toBeNull();
  });
});

describe("csv", () => {
  it("quotes commas and quotes", () => { expect(toCsv([{ a: 'x,"y"' }], [{ label: "A", key: "a" }])).toContain('"x,""y"""'); });
});
