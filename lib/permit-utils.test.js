import { describe, it, expect } from "vitest";
import {
  parseStates, buildRouteMap, routeStatesFor, coverageFor, computePermitIssues, computePermitGaps,
  unmappedRoutes, permitReminders, effectiveStatus, daysBetween, addDaysStr,
} from "./permit-utils";

const today = "2026-11-01";
const routeMap = buildRouteMap([{ origin: "ALA", destination: "DMB", states: ["TM"] }, { origin: "ALA", destination: "TSE", states: [] }]);
const settings = new Map([["TM", { leadDays: 14 }]]);
const flight = (o = {}) => ({ id: "f" + Math.random(), ref: "DV1", resourceId: "r1", origin: "ALA", destination: "DMB", status: "confirmed", start: new Date("2026-11-20T08:00:00Z"), ...o });
const permit = (o = {}) => ({ id: "p" + Math.random(), state: "TM", status: "approved", validFrom: "2026-11-01", validTo: "2027-04-30", resourceIds: [], ...o });

describe("helpers", () => {
  it("parses state lists", () => { expect(parseStates("tm, uz  kz;TM")).toEqual(["TM", "UZ", "KZ"]); });
  it("date math", () => { expect(daysBetween("2026-11-01", "2026-11-20")).toBe(19); expect(addDaysStr("2026-11-01", -14)).toBe("2026-10-18"); });
  it("looks routes up in both directions and tells unmapped from empty", () => {
    expect(routeStatesFor(routeMap, "DMB", "ALA")).toEqual(["TM"]);
    expect(routeStatesFor(routeMap, "ALA", "TSE")).toEqual([]);
    expect(routeStatesFor(routeMap, "ALA", "XXX")).toBe(null);
  });
  it("shows an approved permit past its end date as expired", () => { expect(effectiveStatus(permit({ validTo: "2026-10-31" }), today)).toBe("expired"); });
});

describe("coverageFor", () => {
  it("is covered by an approved permit inside its dates for any aircraft", () => {
    expect(coverageFor([permit()], "tm", "2026-11-20", "r1").covered).toBe(true);
  });
  it("respects the aircraft list", () => {
    const p = permit({ resourceIds: ["r2"] });
    expect(coverageFor([p], "TM", "2026-11-20", "r1").covered).toBe(false);
    expect(coverageFor([p], "TM", "2026-11-20", "r2").covered).toBe(true);
  });
  it("is not covered the day after expiry or before start", () => {
    const p = permit({ validFrom: "2026-11-21", validTo: "2026-12-01" });
    expect(coverageFor([p], "TM", "2026-11-20", "r1").covered).toBe(false);
    expect(coverageFor([p], "TM", "2026-12-02", "r1").reason).toBe("expired");
  });
  it("reports the state of unfinished paperwork, and ignores cancelled permits", () => {
    expect(coverageFor([permit({ status: "submitted" })], "TM", "2026-11-20", "r1").reason).toBe("submitted");
    expect(coverageFor([permit({ status: "draft" })], "TM", "2026-11-20", "r1").reason).toBe("draft");
    expect(coverageFor([permit({ status: "rejected" })], "TM", "2026-11-20", "r1").reason).toBe("rejected");
    expect(coverageFor([permit({ status: "cancelled" })], "TM", "2026-11-20", "r1").reason).toBe("none");
  });
});

describe("computePermitIssues", () => {
  it("no issue when covered, and none for routes needing no permit", () => {
    expect(computePermitIssues([flight(), flight({ destination: "TSE" })], routeMap, [permit()], settings, today)).toHaveLength(0);
  });
  it("flags an uncovered flight; error inside the lead time, warning outside it", () => {
    const near = flight({ start: new Date("2026-11-10T08:00:00Z") });   // 9 days out, lead 14
    const far = flight({ start: new Date("2026-12-20T08:00:00Z") });    // 49 days out
    const issues = computePermitIssues([near, far], routeMap, [], settings, today);
    expect(issues.find(i => i.flightId === near.id).severity).toBe("error");
    expect(issues.find(i => i.flightId === far.id).severity).toBe("warn");
  });
  it("a submitted request is only a warning, a rejected one is always an error", () => {
    const near = flight({ start: new Date("2026-11-10T08:00:00Z") });
    expect(computePermitIssues([near], routeMap, [permit({ status: "submitted" })], settings, today)[0].severity).toBe("warn");
    expect(computePermitIssues([flight({ start: new Date("2026-12-20T08:00:00Z") })], routeMap, [permit({ status: "rejected" })], settings, today)[0].severity).toBe("error");
  });
  it("skips cancelled, past and beyond-horizon flights, and unmapped routes", () => {
    const fl = [flight({ status: "cancelled" }), flight({ start: new Date("2026-10-20T08:00:00Z") }), flight({ start: new Date("2027-03-01T08:00:00Z") }), flight({ destination: "XXX" })];
    expect(computePermitIssues(fl, routeMap, [], settings, today)).toHaveLength(0);
  });
});

describe("computePermitGaps / unmappedRoutes / reminders", () => {
  it("groups gaps per State and aircraft with a file-by date", () => {
    const fl = [flight({ start: new Date("2026-11-20T08:00:00Z") }), flight({ start: new Date("2026-11-25T08:00:00Z") }), flight({ resourceId: "r2", start: new Date("2026-12-01T08:00:00Z") })];
    const gaps = computePermitGaps(fl, routeMap, [], settings, today);
    expect(gaps).toHaveLength(2);
    const g = gaps.find(x => x.resourceId === "r1");
    expect(g).toMatchObject({ state: "TM", flightCount: 2, firstDay: "2026-11-20", lastDay: "2026-11-25", fileBy: "2026-11-06", overdue: false });
  });
  it("marks a gap overdue when the file-by date has passed with nothing submitted", () => {
    const g = computePermitGaps([flight({ start: new Date("2026-11-05T08:00:00Z") })], routeMap, [], settings, today)[0];
    expect(g.overdue).toBe(true);
    expect(computePermitGaps([flight({ start: new Date("2026-11-05T08:00:00Z") })], routeMap, [permit({ status: "submitted" })], settings, today)[0].overdue).toBe(false);
  });
  it("lists unmapped routes once for both directions", () => {
    const fl = [flight({ origin: "ALA", destination: "XXX" }), flight({ origin: "XXX", destination: "ALA" }), flight()];
    expect(unmappedRoutes(fl, routeMap, today)).toEqual([{ origin: "ALA", destination: "XXX", count: 2, firstDay: "2026-11-20" }]);
  });
  it("reminds about expiring permits and unanswered requests", () => {
    const r = permitReminders([
      permit({ id: "a", validTo: "2026-11-05" }),
      permit({ id: "b", validTo: "2026-11-25" }),
      permit({ id: "c", validTo: "2027-04-30" }),
      permit({ id: "d", status: "submitted", submittedAt: "2026-10-20T10:00:00Z" }),
    ], today);
    expect(r.find(x => x.permitId === "a").severity).toBe("error");
    expect(r.find(x => x.permitId === "b").severity).toBe("warn");
    expect(r.find(x => x.permitId === "c")).toBeUndefined();
    expect(r.find(x => x.permitId === "d")).toBeTruthy();
  });
});
