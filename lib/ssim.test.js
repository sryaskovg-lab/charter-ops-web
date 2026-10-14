import { describe, it, expect } from "vitest";
import { looksLikeSsim, parseSsimDate, parseOffset, parseSsim, expandLegs, canonicalAircraftType, fleetTypeKey } from "./ssim.js";

function rec(fields) {
  const a = Array(200).fill(" ");
  fields.forEach(([pos, len, val]) => { const v = String(val).padEnd(len).slice(0, len); for (let i = 0; i < len; i++) a[pos - 1 + i] = v[i]; });
  return a.join("");
}
const t3 = o => rec([[1, 1, "3"], [3, 3, o.airline || "DV"], [6, 4, String(o.no).padStart(4, "0")], [10, 2, "01"], [12, 2, "01"], [14, 1, o.svc || "J"],
  [15, 7, o.from], [22, 7, o.to], [29, 7, o.days], [36, 1, o.freq || ""], [37, 3, o.dep], [40, 4, o.std], [44, 4, o.std], [48, 5, o.depVar], [55, 3, o.arr],
  [58, 4, o.sta], [62, 4, o.sta], [66, 5, o.arrVar], [73, 3, o.ac || "7M8"], [195, 6, "000002"]]);
const header = rec([[1, 35, "1AIRLINE STANDARD SCHEDULE DATA SET1"], [195, 6, "000001"]]);
const carrier = (mode = "L") => rec([[1, 1, "2"], [2, 1, mode], [3, 3, "DV"], [11, 3, "W26"], [195, 6, "000002"]]);
const trailer = rec([[1, 1, "5"], [3, 3, "DV"], [195, 6, "000009"]]);
const file = (...recs) => recs.join("\n");

describe("ssim primitives", () => {
  it("reads dates and offsets", () => {
    expect(parseSsimDate("20OCT26").toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(parseSsimDate("31FEB26")).toBeNull();
    expect(parseSsimDate("00XXX00")).toBeNull();
    expect(parseOffset("+0530")).toBe(330);
    expect(parseOffset("-0400")).toBe(-240);
    expect(parseOffset("     ")).toBeNull();
  });
  it("recognises an SSIM file", () => {
    expect(looksLikeSsim(file(header, carrier()))).toBe(true);
    expect(looksLikeSsim("SSM\nUTC\nNEW")).toBe(false);
  });
  it("maps IATA and ICAO type codes to one key", () => {
    expect(canonicalAircraftType("7m9")).toBe("B39M");
    expect(fleetTypeKey("B39M · 213Y")).toBe("B39M");
    expect(canonicalAircraftType("757")).toBe(fleetTypeKey("B752 · 235Y"));
  });
});

describe("parseSsim", () => {
  const text = file(header, carrier(), t3({ no: 778, from: "20OCT26", to: "30OCT26", days: " 2 4   ", dep: "SYX", std: "1100", depVar: "+0800", arr: "SIN", sta: "1500", arrVar: "+0800", ac: "7M8" }), trailer);
  it("reads carrier and leg records", () => {
    const r = parseSsim(text);
    expect(r.carriers).toEqual([{ airline: "DV", timeMode: "L" }]);
    expect(r.legs).toHaveLength(1);
    expect(r.legs[0]).toMatchObject({ airline: "DV", flightNo: "778", origin: "SYX", destination: "SIN", aircraftType: "7M8", depOff: 480, arrOff: 480 });
    expect([...r.legs[0].days]).toEqual([2, 4]);
  });
  it("skips a bad record with a reason and keeps the rest", () => {
    const bad = t3({ no: 1, from: "BADDATE", to: "30OCT26", days: "1234567", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" });
    const r = parseSsim(file(header, carrier(), bad, t3({ no: 2, from: "20OCT26", to: "20OCT26", days: "1234567", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" })));
    expect(r.legs).toHaveLength(1);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/Line 3/);
  });
});

describe("expandLegs", () => {
  const legs = text => parseSsim(text).legs;
  it("one row per operating day, converted to UTC", () => {
    // 20 OCT 2026 is a Tuesday, 22 a Thursday
    const l = legs(file(header, carrier(), t3({ no: 778, from: "19OCT26", to: "25OCT26", days: " 2 4   ", dep: "SYX", std: "1100", depVar: "+0800", arr: "SIN", sta: "1500", arrVar: "+0800" })));
    const { rows } = expandLegs(l);
    expect(rows.map(r => r.date.toISOString().slice(0, 10))).toEqual(["2026-10-20", "2026-10-22"]);
    expect(rows[0]).toMatchObject({ flightNo: "778", origin: "SYX", destination: "SIN", depTime: "03:00", arrTime: "07:00", durationMin: 240 });
  });
  it("an early local departure falls on the previous UTC day", () => {
    const l = legs(file(header, carrier(), t3({ no: 5, from: "20OCT26", to: "20OCT26", days: "1234567", dep: "ALA", std: "0100", depVar: "+0500", arr: "TAS", sta: "0230", arrVar: "+0500" })));
    const { rows } = expandLegs(l);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe("2026-10-19");
    expect(rows[0].depTime).toBe("20:00");
    expect(rows[0].arrTime).toBe("21:30");
  });
  it("a flight landing the next day gets a positive duration", () => {
    const l = legs(file(header, carrier(), t3({ no: 9, from: "20OCT26", to: "20OCT26", days: "1234567", dep: "ALA", std: "2200", depVar: "+0500", arr: "IST", sta: "0300", arrVar: "+0300" })));
    const { rows } = expandLegs(l);
    expect(rows[0].depTime).toBe("17:00");
    expect(rows[0].arrTime).toBe("00:00");
    expect(rows[0].durationMin).toBe(420);
  });
  it("UTC time mode ignores the offset fields", () => {
    const l = legs(file(header, carrier("U"), t3({ no: 3, from: "20OCT26", to: "20OCT26", days: "1234567", dep: "ALA", std: "0100", depVar: "+0500", arr: "TAS", sta: "0230", arrVar: "+0500" })));
    const { rows } = expandLegs(l);
    expect(rows[0].date.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(rows[0].depTime).toBe("01:00");
  });
  it("forceUtc reads a file with local mode and blank offsets as UTC", () => {
    const text = file(header, carrier("L"), t3({ no: 8, from: "20OCT26", to: "20OCT26", days: "1234567", dep: "ALA", std: "0100", depVar: "", arr: "TAS", sta: "0230", arrVar: "" }));
    expect(parseSsim(text).legs).toHaveLength(0);
    expect(parseSsim(text).warnings[0]).toMatch(/offset/);
    const r = expandLegs(parseSsim(text, { forceUtc: true }).legs).rows;
    expect(r).toHaveLength(1);
    expect(r[0].date.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(r[0].depTime).toBe("01:00");
  });
  it("filters by airline and by dates", () => {
    const l = legs(file(header, carrier(), t3({ airline: "XX", no: 1, from: "19OCT26", to: "25OCT26", days: "1234567", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" }),
      t3({ no: 2, from: "19OCT26", to: "25OCT26", days: "1234567", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" })));
    expect(expandLegs(l, { airlines: ["dv"] }).rows).toHaveLength(7);
    expect(expandLegs(l, { airlines: ["DV"], fromDate: new Date(Date.UTC(2026, 9, 23)) }).rows).toHaveLength(3);
  });
  it("a biweekly frequency rate flies every other week", () => {
    const l = legs(file(header, carrier(), t3({ no: 4, from: "19OCT26", to: "08NOV26", days: " 2     ", freq: "2", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" })));
    expect(expandLegs(l).rows.map(r => r.date.toISOString().slice(0, 10))).toEqual(["2026-10-20", "2026-11-03"]);
  });
  it("service type P is a ferry leg", () => {
    const l = legs(file(header, carrier(), t3({ no: 6, svc: "P", from: "20OCT26", to: "20OCT26", days: "1234567", dep: "AAA", std: "1000", depVar: "+0000", arr: "BBB", sta: "1100", arrVar: "+0000" })));
    expect(expandLegs(l).rows[0].legType).toBe("ferry");
  });
});
