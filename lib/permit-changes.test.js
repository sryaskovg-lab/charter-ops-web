import { describe, it, expect } from "vitest";
import { flightKey, permitChanges, amendmentText, flightsForPermit } from "./permit-changes";
import { buildRouteMap } from "./permit-utils";

const routeMap = buildRouteMap([{ origin: "ALA", destination: "PQC", states: ["PK"] }, { origin: "ALA", destination: "DXB", states: ["TM"] }]);
const mk = (ref, day, dep, arr, o = "ALA", d = "PQC", extra = {}) => ({ id: ref + day, ref, origin: o, destination: d, start: new Date(`${day}T${dep}:00Z`), arrivalAt: new Date(`${day}T${arr}:00Z`), resourceId: "r1", status: "tentative", ...extra });
const permit = (flights) => ({ state: "PK", kind: "overfly", status: "submitted", validFrom: "2026-11-01", validTo: "2026-11-30", resourceIds: [], flightRefs: [], validDates: [], requestedFlights: flights.map(flightKey) });

describe("permit schedule changes", () => {
  const a = mk("DV5316", "2026-11-10", "19:05", "21:05"), b = mk("DV5316", "2026-11-17", "19:05", "21:05"), c = mk("DV5325", "2026-11-12", "03:30", "09:00", "PQC", "ALA");
  const p = permit([a, b, c]);
  it("sees nothing when the schedule is unchanged", () => {
    expect(permitChanges(p, [a, b, c], routeMap, null, "2026-11-01").count).toBe(0);
  });
  it("finds added, cancelled and retimed flights", () => {
    const d = mk("DV5316", "2026-11-24", "19:05", "21:05");
    const bRetimed = mk("DV5316", "2026-11-17", "20:05", "22:05");
    const cCancelled = { ...c, status: "cancelled" };
    const ch = permitChanges(p, [a, bRetimed, cCancelled, d], routeMap, null, "2026-11-01");
    expect(ch.added.map(f => f.ref + f.start.toISOString().slice(0, 10))).toEqual(["DV53162026-11-24"]);
    expect(ch.removed.map(e => e.ref + e.day)).toEqual(["DV53252026-11-12"]);
    expect(ch.changed).toHaveLength(1);
    expect(ch.changed[0].from.dep).toBe("19:05");
    const txt = amendmentText(ch);
    expect(txt).toContain("ADDITIONAL FLIGHTS");
    expect(txt).toContain("5316  ALA-PQC   19:05  21:05  24.11.");
    expect(txt).toContain("CANCELLED FLIGHTS");
    expect(txt).toContain("5325  PQC-ALA   03:30  09:00  12.11.");
    expect(txt).toContain("17.11.  ALA-PQC 19:05-21:05  ->  ALA-PQC 20:05-22:05");
  });
  it("ignores past flights, other countries and permits without a snapshot", () => {
    expect(permitChanges(p, [a, b, c], routeMap, null, "2026-11-11").count).toBe(0);
    expect(permitChanges({ ...p, requestedFlights: null }, [a], routeMap, null, "2026-11-01")).toBeNull();
    const other = mk("DV9", "2026-11-10", "10:00", "12:00", "ALA", "DXB");
    expect(flightsForPermit(p, [other], routeMap, null)).toEqual([]);
  });
});
