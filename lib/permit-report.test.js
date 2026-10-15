import { describe, it, expect } from "vitest";
import { countryRows, registerRows, toCsv, toHtmlTable } from "./permit-report";
import { buildRouteMap } from "./permit-utils";

const TODAY = "2026-11-01";
const permits = [
  { id: "1", state: "PK", status: "approved", kind: "overfly", validFrom: "2026-10-01", validTo: "2026-11-20", permitNumber: "PK-123", authorityRef: "A1", resourceIds: [], agentId: "ag" },
  { id: "2", state: "IN", status: "submitted", kind: "overfly", validFrom: "2026-11-01", validTo: "2027-03-26", resourceIds: ["r1"] },
  { id: "3", state: "TM", status: "approved", kind: "overfly", validFrom: "2026-01-01", validTo: "2026-09-30", permitNumber: "TM-9", resourceIds: [] },
];
const routeMap = buildRouteMap([{ origin: "ALA", destination: "PQC", states: ["PK", "IN"] }]);
const flights = [{ ref: "DV1", origin: "ALA", destination: "PQC", start: new Date("2026-12-02T10:00:00Z"), resourceId: "r1", status: "tentative" }];

describe("permit report", () => {
  const rows = countryRows({ permits, states: [{ state: "PK", channel: "agent", agentId: "ag" }], routes: [], flights, routeMap, airportMap: null, agents: [{ id: "ag", name: "Access Support" }], todayStr: TODAY });
  it("summarises each country", () => {
    const pk = rows.find(r => r.code === "PK");
    expect(pk).toMatchObject({ valid: 1, validUntil: "2026-11-20", endsInDays: 19, goesTo: "Agent: Access Support", numbers: "PK-123", uncovered: 1, firstUncovered: "2026-12-02" });
    expect(rows.find(r => r.code === "IN")).toMatchObject({ valid: 0, open: 1, uncovered: 1 });
    expect(rows.find(r => r.code === "TM")).toMatchObject({ valid: 0, validUntil: "" });
  });
  it("lists the register without closed permits unless asked", () => {
    expect(registerRows({ permits, todayStr: TODAY }).map(r => r.code)).toEqual(["IN", "PK"]);
    const all = registerRows({ permits, todayStr: TODAY, includeClosed: true });
    expect(all.find(r => r.code === "TM").status).toBe("Expired");
  });
  it("writes safe CSV and HTML", () => {
    const csv = toCsv([{ a: 'x,"y"', b: "=cmd" }], [["a", "A"], ["b", "B"]]);
    expect(csv).toBe('A,B\r\n"x,""y""","=cmd"\r\n');
    expect(toHtmlTable([{ a: "<b>" }], [["a", "A"]])).toContain("&lt;b&gt;");
  });
});
