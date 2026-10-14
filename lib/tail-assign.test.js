import { describe, it, expect } from "vitest";
import { assignTails } from "./tail-assign.js";

const H = 3600000;
const t0 = Date.UTC(2026, 9, 20, 0, 0);
const fl = (id, o, d, startH, durH, extra = {}) => ({ id, resourceId: null, origin: o, destination: d, start: new Date(t0 + startH * H), arrivalAt: new Date(t0 + (startH + durH) * H), capacity: 213, status: "tentative", ...extra });
const A = { id: "A", code: "UP-A", variant: "B39M 213Y", capacity: 213 };
const B = { id: "B", code: "UP-B", variant: "B39M 213Y", capacity: 213 };
const C = { id: "C", code: "UP-C", variant: "B752 235Y", capacity: 235 };

describe("assignTails", () => {
  it("keeps a rotation on one tail and does not double-book", () => {
    const f = [fl("1", "DMB", "SVX", 0, 3), fl("2", "SVX", "DMB", 4, 3), fl("3", "DMB", "SVX", 1, 3)];
    const r = assignTails(f, [A, B]);
    const by = Object.fromEntries(r.assigned.map(a => [a.flightId, a.resourceId]));
    expect(by["1"]).toBe(by["2"]);          // out and back on the same tail
    expect(by["3"]).not.toBe(by["1"]);      // overlaps flight 1
    expect(r.left).toHaveLength(0);
  });
  it("uses only tails of the type the seats point to", () => {
    const r = assignTails([fl("1", "ALA", "PQC", 0, 6, { capacity: 235 })], [A, B, C]);
    expect(r.assigned[0].resourceId).toBe("C");
    const r2 = assignTails([fl("1", "ALA", "PQC", 0, 6, { capacity: 235 })], [A, B]);
    expect(r2.assigned).toHaveLength(1); // unknown capacity: no type restriction... but 235 is not in this fleet
  });
  it("leaves flights alone when the only free tail is at another station, unless positioning is allowed", () => {
    const existing = { ...fl("x", "SIN", "HAN", -10, 3), resourceId: "A" }; // A ends at HAN
    const busyB = { ...fl("y", "SIN", "HAN", -1, 40), resourceId: "B" };
    const f = [fl("1", "DMB", "SVX", 5, 3)];
    const strict = assignTails([existing, busyB, ...f], [A, B]);
    expect(strict.assigned).toHaveLength(0);
    expect(strict.left[0].reason).toMatch(/another station/);
    const loose = assignTails([existing, busyB, ...f], [A, B], { allowJump: true });
    expect(loose.assigned[0]).toMatchObject({ resourceId: "A", jump: { from: "HAN" } });
  });
  it("skips grounded tails and respects the turnaround", () => {
    const g = (id) => id === "A" ? true : false;
    const r = assignTails([fl("1", "DMB", "SVX", 0, 3)], [A, B], { isGrounded: g });
    expect(r.assigned[0].resourceId).toBe("B");
    const f = [{ ...fl("x", "DMB", "SVX", 0, 3), resourceId: "A" }, fl("2", "SVX", "DMB", 3.5, 3)]; // only 30 min after landing
    const r2 = assignTails(f, [A]);
    expect(r2.assigned).toHaveLength(0);
    const r3 = assignTails([f[0], fl("2", "SVX", "DMB", 4, 3)], [A]);
    expect(r3.assigned).toHaveLength(1);
  });
  it("does not touch flights that already have a tail or are cancelled", () => {
    const r = assignTails([{ ...fl("1", "A", "B", 0, 2), resourceId: "A" }, fl("2", "A", "B", 10, 2, { status: "cancelled" })], [A]);
    expect(r.assigned).toHaveLength(0);
    expect(r.left).toHaveLength(0);
  });
});

describe("assignTails with a stored aircraft type", () => {
  it("uses the planned type and leaves types the fleet does not have", () => {
    const f = [fl("1", "DMB", "SVX", 0, 3, { aircraftType: "B752", capacity: 235 }), fl("2", "DMB", "SVX", 10, 3, { aircraftType: "B738", capacity: 235 })];
    const r = assignTails(f, [A, C], { canonType: x => x });
    expect(r.assigned.map(a => a.resourceId)).toEqual(["C"]);
    expect(r.left[0].reason).toMatch(/B738/);
  });
});
