import { describe, it, expect } from "vitest";
import {
  iso, addDays, hhmm, timeToMinutes, minutesToHHMM,
  combineDateAndTime, combineArrivalDateTime,
  flightGeometry, assignLanes, colorForDestination,
  computeScheduleIssues,
} from "./scheduling-utils.js";

describe("iso / addDays", () => {
  it("iso formats a Date as YYYY-MM-DD in UTC", () => {
    expect(iso(new Date("2026-03-05T14:22:00Z"))).toBe("2026-03-05");
  });
  it("addDays moves forward across a month boundary", () => {
    expect(iso(addDays(new Date("2026-01-31T00:00:00Z"), 1))).toBe("2026-02-01");
  });
  it("addDays moves backward across a year boundary", () => {
    expect(iso(addDays(new Date("2026-01-01T00:00:00Z"), -1))).toBe("2025-12-31");
  });
});

describe("hhmm / timeToMinutes / minutesToHHMM", () => {
  it("hhmm extracts UTC hours:minutes from a timestamp", () => {
    expect(hhmm("2026-06-01T07:05:00Z")).toBe("07:05");
  });
  it("hhmm returns null for a falsy input", () => {
    expect(hhmm(null)).toBeNull();
  });
  it("timeToMinutes/minutesToHHMM round-trip", () => {
    expect(timeToMinutes("14:35")).toBe(875);
    expect(minutesToHHMM(875)).toBe("14:35");
  });
  it("minutesToHHMM wraps negative and >1440 values into a valid clock time", () => {
    expect(minutesToHHMM(-30)).toBe("23:30");
    expect(minutesToHHMM(1470)).toBe("00:30");
  });
});

describe("combineArrivalDateTime — the overnight-flight fix", () => {
  // This is the single most important test in this file: 906 real flights in production had
  // the wrong scheduled_arrival because of exactly this bug before it was fixed. If this test
  // ever fails after a refactor, that's a real data-corruption risk, not a style nit.
  it("keeps arrival on the same day when it's genuinely later than departure", () => {
    const dep = new Date("2026-01-15T07:00:00Z");
    const arr = combineArrivalDateTime(dep, "09:00");
    expect(iso(arr)).toBe("2026-01-15");
    expect(hhmm(arr)).toBe("09:00");
  });

  it("rolls arrival to the next day for a genuine overnight flight", () => {
    const dep = new Date("2026-01-15T23:00:00Z");
    const arr = combineArrivalDateTime(dep, "02:00");
    expect(iso(arr)).toBe("2026-01-16");
    expect(hhmm(arr)).toBe("02:00");
    expect(arr.getTime()).toBeGreaterThan(dep.getTime());
  });

  it("does not roll over when the arrival is later the same day, even close to midnight", () => {
    const dep = new Date("2026-01-15T00:00:00Z");
    const arr = combineArrivalDateTime(dep, "09:30");
    expect(iso(arr)).toBe("2026-01-15");
  });

  it("rolls over on an exact time match, rather than producing a zero-duration flight", () => {
    const dep = new Date("2026-01-15T07:00:00Z");
    const arr = combineArrivalDateTime(dep, "07:00");
    expect(iso(arr)).toBe("2026-01-16");
    expect(arr.getTime()).toBeGreaterThan(dep.getTime());
  });

  it("returns null when either input is missing", () => {
    expect(combineArrivalDateTime(null, "09:00")).toBeNull();
    expect(combineArrivalDateTime(new Date(), null)).toBeNull();
  });
});

describe("combineDateAndTime", () => {
  it("sets the given clock time onto the given date, in UTC", () => {
    const d = combineDateAndTime(new Date("2026-05-10T00:00:00Z"), "13:45");
    expect(iso(d)).toBe("2026-05-10");
    expect(hhmm(d)).toBe("13:45");
  });
  it("returns null when no time string is given", () => {
    expect(combineDateAndTime(new Date(), null)).toBeNull();
  });
});

describe("flightGeometry", () => {
  it("computes offset/width fractions for a normal same-day flight", () => {
    const g = flightGeometry({ depTime: "08:00", arrTime: "10:00" });
    expect(g.offsetFrac).toBeCloseTo(480 / 1440);
    expect(g.widthFrac).toBeCloseTo(120 / 1440);
  });

  it("handles an overnight flight's duration correctly (arrival numerically less than departure)", () => {
    // 23:00 -> 02:00 is a 3-hour flight, not a negative one.
    const g = flightGeometry({ depTime: "23:00", arrTime: "02:00" });
    expect(g.widthFrac).toBeCloseTo(180 / 1440);
  });

  it("falls back to a full-day block when there's no departure time at all", () => {
    const g = flightGeometry({ depTime: null, arrTime: null });
    expect(g).toEqual({ offsetFrac: 0, widthFrac: 1 });
  });

  it("defaults to a 90-minute duration when only departure time is known", () => {
    const g = flightGeometry({ depTime: "10:00", arrTime: null });
    expect(g.widthFrac).toBeCloseTo(90 / 1440);
  });
});

describe("assignLanes — the day-boundary stacking fix", () => {
  const geomFn = f => ({ offsetFrac: f.offsetFrac, widthFrac: f.widthFrac });

  it("keeps two non-overlapping flights in the same lane", () => {
    const flights = [
      { id: "a", offsetFrac: 0.1, widthFrac: 0.1 },
      { id: "b", offsetFrac: 0.3, widthFrac: 0.1 },
    ];
    const { laneOf, laneCount } = assignLanes(flights, geomFn);
    expect(laneCount).toBe(1);
    expect(laneOf.get("a")).toBe(0);
    expect(laneOf.get("b")).toBe(0);
  });

  it("puts genuinely overlapping flights into separate lanes", () => {
    const flights = [
      { id: "a", offsetFrac: 0.1, widthFrac: 0.3 },
      { id: "b", offsetFrac: 0.2, widthFrac: 0.3 }, // overlaps with a
    ];
    const { laneOf, laneCount } = assignLanes(flights, geomFn);
    expect(laneCount).toBe(2);
    expect(laneOf.get("a")).not.toBe(laneOf.get("b"));
  });

  it("reuses a freed-up lane for a later, non-overlapping flight rather than growing forever", () => {
    const flights = [
      { id: "a", offsetFrac: 0.0, widthFrac: 0.1 },  // lane 0
      { id: "b", offsetFrac: 0.05, widthFrac: 0.1 }, // overlaps a -> lane 1
      { id: "c", offsetFrac: 0.3, widthFrac: 0.1 },  // overlaps neither by the time it starts -> should reuse lane 0
    ];
    const { laneOf, laneCount } = assignLanes(flights, geomFn);
    expect(laneCount).toBe(2);
    expect(laneOf.get("c")).toBe(0);
  });
});

describe("colorForDestination", () => {
  it("is deterministic — the same code always gets the same color", () => {
    expect(colorForDestination("ALA")).toBe(colorForDestination("ALA"));
  });
  it("gives different codes a good chance of different colors", () => {
    expect(colorForDestination("ALA")).not.toBe(colorForDestination("CXR"));
  });
  it("returns the fallback color for an empty/missing code", () => {
    expect(colorForDestination(null)).toBe("#A7B0BE");
    expect(colorForDestination("")).toBe("#A7B0BE");
  });
});

describe("computeScheduleIssues — the validation engine", () => {
  const resource = { id: "r1", code: "UP-B3748", capacity: 189 };

  function flight(overrides) {
    return {
      id: "f-" + Math.random(), ref: "DV0000", resourceId: "r1",
      origin: "ALA", destination: "CXR", capacity: 180, status: "confirmed", legType: "revenue",
      start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z"),
      ...overrides,
    };
  }

  it("reports no issues for a clean, well-formed rotation", () => {
    const a = flight({ ref: "DV1", origin: "ALA", destination: "CXR", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "CXR", destination: "ALA", start: new Date("2026-01-15T13:00:00Z"), arrivalAt: new Date("2026-01-15T16:00:00Z") });
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues).toHaveLength(0);
  });

  it("flags a double-booking when a flight departs before the previous one lands", () => {
    const a = flight({ ref: "DV1", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "CXR", start: new Date("2026-01-15T10:00:00Z"), arrivalAt: new Date("2026-01-15T13:00:00Z") });
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues.some(i => i.kind === "Double-booked" && i.flightId === b.id)).toBe(true);
  });

  it("flags insufficient turnaround under the 45-minute minimum", () => {
    const a = flight({ ref: "DV1", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "CXR", start: new Date("2026-01-15T11:20:00Z"), arrivalAt: new Date("2026-01-15T14:00:00Z") }); // 20 min gap
    const issues = computeScheduleIssues([a, b], [resource]);
    const issue = issues.find(i => i.kind === "Turnaround");
    expect(issue).toBeTruthy();
    expect(issue.message).toContain("20 min");
  });

  it("does not flag turnaround when the gap meets the minimum", () => {
    const a = flight({ ref: "DV1", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "CXR", start: new Date("2026-01-15T11:45:00Z"), arrivalAt: new Date("2026-01-15T14:00:00Z") }); // exactly 45 min
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues.some(i => i.kind === "Turnaround")).toBe(false);
  });

  it("flags a route gap when the next flight doesn't depart from where this aircraft landed", () => {
    const a = flight({ ref: "DV1", destination: "CXR", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "SSH", start: new Date("2026-01-15T13:00:00Z"), arrivalAt: new Date("2026-01-15T16:00:00Z") }); // wrong origin
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues.some(i => i.kind === "Route gap")).toBe(true);
  });

  it("does not flag a route gap for an explicit ferry leg", () => {
    const a = flight({ ref: "DV1", destination: "CXR", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "SSH", legType: "ferry", start: new Date("2026-01-15T13:00:00Z"), arrivalAt: new Date("2026-01-15T16:00:00Z") });
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues.some(i => i.kind === "Route gap")).toBe(false);
  });

  it("flags a capacity mismatch when the flight is booked above the aircraft's current configuration", () => {
    const a = flight({ ref: "DV1", capacity: 195 }); // resource is only 189
    const issues = computeScheduleIssues([a], [resource]);
    const issue = issues.find(i => i.kind === "Capacity");
    expect(issue).toBeTruthy();
    expect(issue.message).toContain("195");
    expect(issue.message).toContain("189");
  });

  it("ignores cancelled flights entirely for turnaround/overlap/routing checks", () => {
    const a = flight({ ref: "DV1", status: "cancelled", start: new Date("2026-01-15T08:00:00Z"), arrivalAt: new Date("2026-01-15T11:00:00Z") });
    const b = flight({ ref: "DV2", origin: "SSH", start: new Date("2026-01-15T11:05:00Z"), arrivalAt: new Date("2026-01-15T14:00:00Z") });
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues.some(i => i.kind === "Turnaround" || i.kind === "Route gap" || i.kind === "Double-booked")).toBe(false);
  });

  it("sorts errors before warnings", () => {
    const a = flight({ ref: "DV1", capacity: 999 }); // error: capacity
    const b = flight({ ref: "DV2", origin: "SSH", start: new Date("2026-01-15T11:20:00Z"), arrivalAt: new Date("2026-01-15T14:00:00Z") }); // warnings: turnaround + route gap
    const issues = computeScheduleIssues([a, b], [resource]);
    expect(issues[0].severity).toBe("error");
  });
});
