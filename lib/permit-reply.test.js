import { describe, it, expect } from "vitest";
import { readReplyBody, findDates, findNumber, findDecision } from "./permit-reply";

describe("permit-reply", () => {
  it("finds dates in common formats", () => {
    expect(findDates("valid 24.10.2026 to 26/03/2027, also 5 Nov 2026 and 2026-12-01").map(d => d.date))
      .toEqual(["2026-10-24", "2027-03-26", "2026-11-05", "2026-12-01"]);
  });
  it("finds a permit number but not a date", () => {
    expect(findNumber("Permit No: 123/OVF/2026 valid")).toBe("123/OVF/2026");
    expect(findNumber("Permission number 24.10.2026")).toBe(null);
  });
  it("reads decisions", () => {
    expect(findDecision("Permit approved")).toBe("granted");
    expect(findDecision("request not approved")).toBe("rejected");
  });
  it("reads a multi-country reply", () => {
    const body = [
      "Dear Stanislav,",
      "Please find the permits for W26 below:",
      "Afghanistan - APPROVED, permit no. AFG-778/26, valid 30.10.2026 - 26.03.2027",
      "Cambodia: permission number KH/OF/5521",
      "  valid from 30 Oct 2026 until 26 Mar 2027, approved",
      "Pakistan - not approved, please re-submit",
      "> Afghanistan old quoted line approved 111-222",
      "Best regards",
    ].join("\n");
    const r = readReplyBody(body, { subject: "RE: overflight permits W26" });
    expect(r.map(x => [x.state, x.decision, x.permitNumber, x.validFrom, x.validTo])).toEqual([
      ["AF", "granted", "AFG-778/26", "2026-10-30", "2027-03-26"],
      ["KH", "granted", "KH/OF/5521", "2026-10-30", "2027-03-26"],
      ["PK", "rejected", null, null, null],
    ]);
  });
  it("uses the subject country when the body names none", () => {
    const r = readReplyBody("Permit approved. Permit No: 55/2026 valid until 31.03.2027.", { subject: "RE: Kazakhstan overflight" });
    expect(r.map(x => [x.state, x.permitNumber, x.validTo])).toEqual([["KZ", "55/2026", "2027-03-31"]]);
  });
  it("ignores pending and empty mail", () => {
    expect(readReplyBody("Afghanistan - pending, awaiting authority", {})).toEqual([]);
    expect(readReplyBody("Thanks, received.", {})).toEqual([]);
  });
});
