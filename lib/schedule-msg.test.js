import { describe, it, expect } from "vitest";
import { detectKind, resolveDate, parseScheduleMessage, itemDates, planScheduleChanges } from "./schedule-msg.js";

const TODAY = new Date(Date.UTC(2026, 9, 14));
const d = s => new Date(s + "T00:00:00Z");

describe("detect and dates", () => {
  it("finds SSM and ASM behind a Type B envelope", () => {
    expect(detectKind("QD ALAXXDV\n.ALAXXDV 141200\nSSM\nUTC\nNEW")).toBe("ssm");
    expect(detectKind("ZCZC\nASM\nNEW")).toBe("asm");
    expect(detectKind("Dear colleague, please find...")).toBeNull();
  });
  it("completes a date without a year to the next sensible one", () => {
    expect(resolveDate("20OCT", TODAY).toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(resolveDate("05JAN", TODAY).toISOString().slice(0, 10)).toBe("2027-01-05");
    expect(resolveDate("12OCT", TODAY).toISOString().slice(0, 10)).toBe("2026-10-12"); // two days ago: still this year
    expect(resolveDate("20OCT27", TODAY).toISOString().slice(0, 10)).toBe("2027-10-20");
    expect(resolveDate("31FEB", TODAY)).toBeNull();
  });
});

describe("SSM", () => {
  const ssm = `QD ALAXXDV
.NQZXXDV 141000
SSM
UTC
14OCT26
NEW
DV778
20OCT26 30OCT26 246
J B752 Y235
SYX0300 SIN0700

CNL
DV481
24OCT26 31OCT26 6
ALA0200 SKD0400
NNNN`;
  it("reads the action blocks", () => {
    const r = parseScheduleMessage(ssm, { today: TODAY });
    expect(r.kind).toBe("ssm");
    expect(r.timeMode).toBe("UTC");
    expect(r.items).toHaveLength(2);
    const [n, c] = r.items;
    expect(n).toMatchObject({ action: "NEW", airline: "DV", flightNo: "778", aircraftType: "B752", serviceType: "J" });
    expect(n.legs).toEqual([{ origin: "SYX", depTime: "03:00", destination: "SIN", arrTime: "07:00" }]);
    expect([...n.days]).toEqual([2, 4, 6]);
    expect(itemDates(n).map(x => x.toISOString().slice(0, 10))).toEqual(["2026-10-20", "2026-10-22", "2026-10-24", "2026-10-27", "2026-10-29"]);
    expect(c).toMatchObject({ action: "CNL", flightNo: "481" });
    expect(itemDates(c).map(x => x.toISOString().slice(0, 10))).toEqual(["2026-10-24", "2026-10-31"]);
  });
  it("accepts the period on the same line as the flight", () => {
    const r = parseScheduleMessage("SSM\nUTC\nNEW\nDV 778 20OCT26 24OCT26 1234567\nJ 752\nSYX0300 SIN0700", { today: TODAY });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].dateFrom.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(r.items[0].legs).toHaveLength(1);
  });
});

describe("ASM", () => {
  it("reads a single-date cancel and a retime", () => {
    const r = parseScheduleMessage("ASM\nUTC\nCNL\nDV778/20OCT26\n//\nTIM\nDV481/22OCT\nALA0230 SKD0430\nNNNN", { today: TODAY });
    expect(r.items.map(i => i.action)).toEqual(["CNL", "TIM"]);
    expect(itemDates(r.items[0])).toHaveLength(1);
    expect(r.items[1].legs[0]).toMatchObject({ origin: "ALA", depTime: "02:30", arrTime: "04:30" });
  });
  it("local-time messages are flagged as not applicable", () => {
    const r = parseScheduleMessage("ASM\nLT\nCNL\nDV778/20OCT26", { today: TODAY });
    expect(r.warnings.join(" ")).toMatch(/local times/);
  });
  it("lists what it cannot understand rather than guessing", () => {
    const r = parseScheduleMessage("ASM\nUTC\nRRT\nDV778/20OCT26\nSYX0300 SIN0700", { today: TODAY });
    const plan = planScheduleChanges(r.items, []);
    expect(plan.manual).toHaveLength(1);
    expect(plan.manual[0].action).toBe("RRT");
  });
});

describe("planScheduleChanges", () => {
  const flights = [
    { id: "f1", ref: "DV778", origin: "SYX", destination: "SIN", start: d("2026-10-20"), depTime: "03:00", arrTime: "07:00", status: "tentative" },
    { id: "f2", ref: "DV778", origin: "SYX", destination: "SIN", start: d("2026-10-22"), depTime: "03:00", arrTime: "07:00", status: "cancelled" },
    { id: "f3", ref: "DV481", origin: "ALA", destination: "SKD", start: d("2026-10-22"), depTime: "02:00", arrTime: "04:00", status: "confirmed" },
  ];
  const parse = t => parseScheduleMessage(t, { today: TODAY }).items;
  it("NEW makes rows and flags the ones already in the schedule", () => {
    const p = planScheduleChanges(parse("SSM\nUTC\nNEW\nDV778\n20OCT26 22OCT26 24\nJ B752\nSYX0300 SIN0700"), flights);
    expect(p.create).toHaveLength(2);
    expect(p.create[0]).toMatchObject({ flightNo: "778", origin: "SYX", destination: "SIN", depTime: "03:00", arrTime: "07:00", durationMin: 240, aircraftType: "B752" });
    expect(p.create[0].duplicateOf).toBe("DV778");
    expect(p.create[1].duplicateOf).toBeNull(); // the 22nd flight is cancelled, so it is not a duplicate
  });
  it("CNL matches live flights only and reports the rest", () => {
    const p = planScheduleChanges(parse("ASM\nUTC\nCNL\nDV778/20OCT26\nCNL\nDV778/22OCT26\nCNL\nDV999/20OCT26"), flights);
    expect(p.cancel.map(c => c.flightId)).toEqual(["f1"]);
    expect(p.notes).toHaveLength(2);
  });
  it("TIM proposes new times and skips unchanged ones", () => {
    const p = planScheduleChanges(parse("ASM\nUTC\nTIM\nDV481/22OCT26\nALA0230 SKD0430\nTIM\nDV778/20OCT26\nSYX0300 SIN0700"), flights);
    expect(p.retime).toHaveLength(1);
    expect(p.retime[0]).toMatchObject({ flightId: "f3", from: { dep: "02:00", arr: "04:00" }, to: { dep: "02:30", arr: "04:30" } });
  });
  it("ignores other airlines when asked", () => {
    const p = planScheduleChanges(parse("ASM\nUTC\nCNL\nXX778/20OCT26"), flights, { airlines: ["DV"] });
    expect(p.cancel).toHaveLength(0);
    expect(p.notes[0]).toMatch(/another airline/);
  });
});

import { describeScheduleText, markDuplicates } from "./schedule-msg.js";
describe("describeScheduleText", () => {
  it("summarises messages and ignores other text", () => {
    expect(describeScheduleText("SSM\nUTC\nNEW\nDV778\n20OCT26 30OCT26 246\nJ B752\nSYX0300 SIN0700\nCNL\nDV481\n24OCT26\nALA0200 SKD0400")).toEqual({ kind: "ssm", summary: "NEW 1, CNL 1" });
    expect(describeScheduleText("Hello, the weekly report is attached.")).toBeNull();
    expect(describeScheduleText("1AIRLINE STANDARD SCHEDULE DATA SET1\n")).toMatchObject({ kind: "ssim" });
  });
});

describe("markDuplicates", () => {
  it("flags rows already in the schedule", () => {
    const flights = [{ id: "a", ref: "DV778", origin: "SYX", destination: "SIN", start: d("2026-10-20"), status: "tentative" }, { id: "b", ref: "DV778", origin: "SYX", destination: "SIN", start: d("2026-10-22"), status: "cancelled" }];
    const rows = [{ flightNo: "778", origin: "SYX", destination: "SIN", date: d("2026-10-20") }, { flightNo: "778", origin: "SYX", destination: "SIN", date: d("2026-10-22") }];
    expect(markDuplicates(rows, flights).map(r => r.duplicateOf)).toEqual(["DV778", null]);
  });
});

import { planSsimSync } from "./schedule-msg.js";
describe("planSsimSync", () => {
  const row = (no, date, o, dst, dep, arr) => ({ airline: "DV", flightNo: no, date: d(date), origin: o, destination: dst, depTime: dep, arrTime: arr });
  const fl = (id, ref, date, o, dst, dep, arr, status = "tentative", extra = {}) => ({ id, ref, start: d(date), origin: o, destination: dst, depTime: dep, arrTime: arr, status, legType: "revenue", ...extra });
  const flights = [
    fl("a", "DV778", "2026-10-20", "SYX", "SIN", "03:00", "07:00"),
    fl("b", "DV778", "2026-10-22", "SYX", "SIN", "03:00", "07:00"),
    fl("c", "DV481", "2026-10-22", "ALA", "SKD", "02:00", "04:00", "confirmed"),
    fl("e", "DV999", "2026-10-21", "SYX", "SIN", "05:00", "09:00"),
    fl("g", "DV999", "2026-10-10", "SYX", "SIN", "05:00", "09:00"),
    fl("h", "DV998", "2026-10-21", "SYX", "SIN", "05:00", "09:00", "operating"),
    fl("i", "DV997", "2026-10-21", "SYX", "SIN", "05:00", "09:00", "tentative", { legType: "ferry" }),
    fl("j", "XX555", "2026-10-21", "SYX", "SIN", "05:00", "09:00"),
  ];
  const rows = [
    row("778", "2026-10-20", "SYX", "SIN", "03:00", "07:00"),   // same
    row("778", "2026-10-22", "SYX", "SIN", "04:00", "08:00"),   // retimed
    row("481", "2026-10-22", "ALA", "TAS", "02:00", "04:00"),   // other route
    row("100", "2026-10-23", "SYX", "SIN", "01:00", "05:00"),   // new
  ];
  const p = planSsimSync(rows, flights, { airlines: ["DV"], today: d("2026-10-15"), allotted: new Set(["e"]) });
  it("finds new, retimed and changed-route flights", () => {
    expect(p.create.map(r => r.flightNo)).toEqual(["100"]);
    expect(p.retime).toHaveLength(1);
    expect(p.retime[0]).toMatchObject({ flightId: "b", from: { dep: "03:00", arr: "07:00" }, to: { dep: "04:00", arr: "08:00" } });
    expect(p.changed).toHaveLength(1);
    expect(p.changed[0]).toMatchObject({ flightId: "c", inSystem: "ALA–SKD", inFile: "ALA–TAS" });
  });
  it("proposes cancelling only future, not yet operating, revenue flights of the airline inside the period", () => {
    expect(p.missing.map(m => m.flightId)).toEqual(["e"]);
    expect(p.missing[0].allotted).toBe(true);
  });
  it("covers the period from the file or the dates given", () => {
    expect(p.scope.from).toEqual(d("2026-10-20"));
    expect(p.scope.to).toEqual(d("2026-10-23"));
    const q = planSsimSync(rows, flights, { airlines: ["DV"], today: d("2026-10-15"), fromDate: d("2026-10-15"), toDate: d("2026-10-30") });
    expect(q.missing.map(m => m.flightId)).toEqual(["e"]);
  });
});
