import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { haversineKm, greatCirclePoints, buildCountryIndex, statesAtPoint, statesAlong, TERRITORIAL_SEA_KM } from "./geo.js";
import { makeGeo, suggestAirports, suggestRoute, suggestRoutes, compareMapped, upcomingDestinations } from "./permit-geo.js";

// Two squares on the equator side by side with a gap of water, plus one with a lake (hole).
const sq = (x0, y0, x1, y1) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
const countries = [
  { cc: "AA", name: "Aland", polys: [[sq(0, 0, 10, 10)]] },
  { cc: "BB", name: "Bland", polys: [[sq(10, 0, 20, 10)]] },
  { cc: "CC", name: "Cland", polys: [[sq(30, 0, 40, 10), sq(34, 4, 36, 6)]] }, // lake in the middle
];
const index = buildCountryIndex(countries);
const nameOf = cc => ({ AA: "Aland", BB: "Bland", CC: "Cland" }[cc] || cc);

describe("geometry", () => {
  it("haversine: one degree of latitude is about 111 km", () => {
    expect(Math.round(haversineKm(0, 0, 1, 0))).toBe(111);
  });
  it("great circle keeps both ends and spaces points", () => {
    const pts = greatCirclePoints(0, 0, 0, 10, 50);
    expect(pts[0].lon).toBeCloseTo(0, 5);
    expect(pts[pts.length - 1].lon).toBeCloseTo(10, 5);
    expect(pts.length).toBeGreaterThan(20);
  });
  it("land point belongs to its State only", () => {
    expect(statesAtPoint(index, 5, 5).land).toBe("AA");
    expect(statesAtPoint(index, 15, 5).land).toBe("BB");
  });
  it("a hole (lake) is not part of the State", () => {
    expect(statesAtPoint(index, 31, 5).land).toBe("CC");
    expect(statesAtPoint(index, 35, 5).land).toBe(null);
  });
  it("water within 12 nm of a coast counts, further out does not", () => {
    const gap = statesAtPoint(index, 20.1, 5); // about 11 km east of BB's coast
    expect(gap.land).toBe(null);
    expect(gap.sea).toContain("BB");
    expect(statesAtPoint(index, 25, 5).sea).toEqual([]); // open water between BB and CC
  });
});

describe("statesAlong", () => {
  it("lists States in order of first contact", () => {
    const r = statesAlong(index, nameOf, { lat: 5, lon: 2 }, { lat: 5, lon: 38 });
    expect(r.map(x => x.state)).toEqual(["AA", "BB", "CC"]);
    expect(r[0].km).toBeLessThan(r[1].km);
    expect(r[1].viaSeaOnly).toBe(false);
  });
  it("a line that only brushes a coast is marked sea-only", () => {
    // 5.15 degrees north of nothing: run just off the north coast of AA (10N) by about 11 km
    const r = statesAlong(index, nameOf, { lat: 10.1, lon: 2 }, { lat: 10.1, lon: 8 });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ state: "AA", viaSeaOnly: true });
  });
  it("a line over open water crosses nothing", () => {
    expect(statesAlong(index, nameOf, { lat: 20, lon: 2 }, { lat: 20, lon: 38 })).toEqual([]);
  });
});

describe("permit suggestions", () => {
  const airports = [
    ["AAA", "XAAA", 5, 2, "AA", "Aland Intl"],
    ["BBB", "XBBB", 5, 15, "BB", "Bland Intl"],
    ["CCC", "XCCC", 5, 38, "CC", "Cland Intl"],
  ];
  const geo = makeGeo(airports, countries);

  it("takes off the departure and landing States; the rest are overflown", () => {
    const r = suggestRoute("aaa", "ccc", geo);
    expect(r.found).toBe(true);
    expect(r.states.map(s => s.state)).toEqual(["BB"]);
    expect(r.originState).toBe("AA");
    expect(r.destState).toBe("CC");
  });
  it("accepts ICAO codes too", () => {
    expect(suggestRoute("XAAA", "XCCC", geo).states.map(s => s.state)).toEqual(["BB"]);
  });
  it("says which airport it does not know", () => {
    expect(suggestRoute("AAA", "ZZZ", geo)).toEqual({ found: false, missing: ["ZZZ"] });
  });
  it("airport suggestions leave the home State blank", () => {
    const r = suggestAirports([{ airport: "AAA" }, { airport: "BBB" }, { airport: "QQQ" }], geo, ["aa"]);
    expect(r[0]).toMatchObject({ found: true, state: "", home: true });
    expect(r[1]).toMatchObject({ found: true, state: "BB", home: false });
    expect(r[2]).toMatchObject({ found: false, state: null });
  });
  it("lists upcoming destinations that are not listed yet", () => {
    const flights = [
      { destination: "BBB", start: "2026-10-15T01:00:00Z", status: "scheduled" },
      { destination: "BBB", start: "2026-10-16T01:00:00Z", status: "scheduled" },
      { destination: "CCC", start: "2026-10-16T01:00:00Z", status: "cancelled" },
      { destination: "AAA", start: "2026-10-01T01:00:00Z", status: "scheduled" },
    ];
    const r = upcomingDestinations(flights, new Map(), "2026-10-14");
    expect(r).toEqual([{ airport: "BBB", count: 2, firstDay: "2026-10-15" }]);
    expect(upcomingDestinations(flights, new Map([["BBB", ""]]), "2026-10-14")).toEqual([]);
  });
  it("compares typed-in routes with the line", () => {
    const d = compareMapped([
      { origin: "AAA", destination: "CCC", states: ["BB"] },
      { origin: "AAA", destination: "CCC", states: ["XX"] },
    ], geo);
    expect(d).toHaveLength(1);
    expect(d[0].missing.map(m => m.state)).toEqual(["BB"]);
    expect(d[0].extra).toEqual(["XX"]);
  });
  it("suggestRoutes keeps the route fields", () => {
    const r = suggestRoutes([{ origin: "AAA", destination: "BBB", count: 3 }], geo);
    expect(r[0]).toMatchObject({ origin: "AAA", destination: "BBB", count: 3, found: true });
    expect(r[0].states).toEqual([]);
  });
});

describe("real data files", () => {
  const dir = path.join(process.cwd(), "public", "data");
  const ap = JSON.parse(fs.readFileSync(path.join(dir, "airports.json"), "utf8"));
  const co = JSON.parse(fs.readFileSync(path.join(dir, "countries.json"), "utf8"));
  const geo = makeGeo(ap, co);
  it("knows the airports of this network", () => {
    ["SIN", "SYX", "ALA", "DMB", "SKD", "WSSS", "UAAA"].forEach(c => expect(geo.airports.has(c)).toBe(true));
    expect(geo.airports.get("ALA").state).toBe("KZ");
  });
  it("Almaty to Samarkand crosses Kyrgyzstan and ends in Uzbekistan", () => {
    const r = suggestRoute("ALA", "SKD", geo);
    expect(r.destState).toBe("UZ");
    expect(r.states.map(s => s.state)).toContain("KG");
    expect(r.states.map(s => s.state)).not.toContain("UZ");
  });
  it("Sanya to Singapore crosses Vietnam and Cambodia", () => {
    const s = suggestRoute("SYX", "SIN", geo).states.map(x => x.state);
    expect(s).toContain("VN");
    expect(s).toContain("KH");
  });
});
