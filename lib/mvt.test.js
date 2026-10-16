import { describe, it, expect } from "vitest";
import { looksLikeMvt, parseMvt, resolveMvtTimes, sameAircraft, pickFlight } from "./mvt";

const SAMPLE = "MVT\nDV5273/16.B3738.NQZ\nAD0225/0300 EA0810 AYT\n\nSI AUTOFEED 34916553";

describe("mvt", () => {
  it("recognises and parses the sample", () => {
    expect(looksLikeMvt(SAMPLE)).toBe(true);
    const [m] = parseMvt(SAMPLE);
    expect(m).toMatchObject({ ref: "DV5273", day: 16, registration: "B3738", origin: "NQZ", off: "0225", airborne: "0300", eta: "0810", destination: "AYT" });
    expect(m.notes).toEqual(["SI AUTOFEED 34916553"]);
  });
  it("parses arrival messages and several messages in one text", () => {
    const r = parseMvt("MVT\nDV5273/16.B3738.NQZ\nAA0805/0812\nNNNN\nMVT\nDV5270/15.B3726.SSH\nAD0900/0912 EA1200 NQZ");
    expect(r.map(x => [x.ref, x.landing, x.onBlock, x.off])).toEqual([["DV5273", "0805", "0812", null], ["DV5270", null, null, "0900"]]);
  });
  it("ignores text that is not a movement message", () => {
    expect(parseMvt("Hello, please call me")).toEqual([]);
    expect(looksLikeMvt("Hello")).toBe(false);
  });
  it("places times on the right day, also across midnight", () => {
    const std = new Date("2026-10-16T02:20:00Z");
    expect(resolveMvtTimes(parseMvt(SAMPLE)[0], std)).toEqual({ off: "2026-10-16T02:25:00.000Z", airborne: "2026-10-16T03:00:00.000Z", landing: null, onBlock: null, eta: "2026-10-16T08:10:00.000Z" });
    const late = new Date("2026-10-16T23:50:00Z");
    const r = resolveMvtTimes({ off: "0005", airborne: "0020", landing: "0530", onBlock: "0538", eta: null, estDep: null }, late);
    expect([r.off, r.airborne, r.landing, r.onBlock]).toEqual(["2026-10-17T00:05:00.000Z", "2026-10-17T00:20:00.000Z", "2026-10-17T05:30:00.000Z", "2026-10-17T05:38:00.000Z"]);
  });
  it("compares registrations with resource codes", () => {
    expect(sameAircraft("B3738", "UP-B3738")).toBe(true);
    expect(sameAircraft("B3738", "UP-B3726")).toBe(false);
  });
  it("picks the flight by number, day and origin", () => {
    const mv = parseMvt(SAMPLE)[0];
    const fl = [{ id: "a", ref: "DV5273", origin: "NQZ", scheduled_departure: "2026-10-16T02:20:00Z" }, { id: "b", ref: "DV5273", origin: "NQZ", scheduled_departure: "2026-10-17T02:20:00Z" }, { id: "c", ref: "DV5273", origin: "AYT", scheduled_departure: "2026-10-16T12:00:00Z" }];
    expect(pickFlight(mv, fl, new Date("2026-10-16T03:00:00Z")).flight.id).toBe("a");
    expect(pickFlight(mv, [fl[1]], new Date()).flight).toBe(null);
  });
});
