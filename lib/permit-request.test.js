import { describe, it, expect } from "vitest";
import { extractEmails, buildRequestEmail, buildAlertEmail, buildRawMime } from "./permit-request";

const decode = raw => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

describe("permit-request", () => {
  it("extracts and de-duplicates e-mail addresses", () => {
    expect(extractEmails("Call 123; ops@caa.gov.tm, OPS@caa.gov.tm / x@y.kz")).toEqual(["ops@caa.gov.tm", "x@y.kz"]);
    expect(extractEmails(null)).toEqual([]);
  });
  it("builds a request with period, aircraft and flights", () => {
    const m = buildRequestEmail({ state: "tm", validFrom: "2026-11-01", validTo: "2026-11-30", aircraft: ["UP-B3748"], flights: [{ ref: "DV123", origin: "ALA", destination: "DMB", start: new Date("2026-11-02T04:05:00Z") }] });
    expect(m.subject).toBe("Overfly permit request – TM – 2026-11-01 to 2026-11-30 – UP-B3748");
    expect(m.body).toContain("2026-11-02  04:05  DV123  ALA-DMB");
  });
  it("alert e-mail lists both kinds", () => {
    const u = { day: "2026-10-14", start: new Date("2026-10-14T08:00:00Z"), ref: "A1", origin: "ALA", destination: "DMB", resourceId: "r", state: "TM", text: "no permit on file" };
    const m = buildAlertEmail({ uncovered: [u], unmapped: [{ ...u, state: undefined }], todayStr: "2026-10-13", days: 4, codeOf: () => "UP-1" });
    expect(m.subject).toContain("1 flight/State pair");
    expect(m.body).toContain("TM: no permit on file");
    expect(m.body).toContain("CANNOT BE CHECKED");
  });
  it("MIME: encodes non-ASCII subject, blocks header injection, round-trips body", () => {
    const raw = buildRawMime({ to: ["a@b.kz"], subject: "Запрос\r\nBcc: evil@x.com", text: "Привет" });
    const txt = decode(raw);
    expect(txt).toContain("Subject: =?UTF-8?B?");
    expect(txt).not.toMatch(/\r\nBcc:/);
    const body = txt.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Привет");
  });
});

import { renderTemplate, unknownPlaceholders, pickTemplate, requestVars, buildFromTemplate } from "./permit-request";
describe("request forms", () => {
  it("fills placeholders and leaves unknown ones visible", () => {
    expect(renderTemplate("Hi {{ agent }}, {{nope}}", { agent: "ACME" })).toBe("Hi ACME, {{nope}}");
    expect(unknownPlaceholders("{{state}} {{typo}} {{Typo}}")).toEqual(["typo"]);
  });
  const tpls = [
    { scope: "default", kind: "overfly", subject: "D", body: "d" },
    { scope: "agent", agent_id: "a1", kind: "overfly", subject: "A", body: "a" },
    { scope: "state", state: "TM", kind: "overfly", subject: "S", body: "s" },
  ];
  it("picks the country form first, then the agent's or the general form, then built-in", () => {
    expect(pickTemplate({ templates: tpls, state: "tm", agentId: "a1", channel: "agent" }).subject).toBe("S");
    expect(pickTemplate({ templates: tpls, state: "UZ", agentId: "a1", channel: "agent" }).subject).toBe("A");
    expect(pickTemplate({ templates: tpls, state: "UZ", channel: "authority" }).subject).toBe("D");
    expect(pickTemplate({ templates: tpls, state: "UZ", agentId: "a2", channel: "agent" }).source).toBe("built-in form");
    expect(pickTemplate({ templates: tpls, state: "UZ", kind: "landing", channel: "authority" }).source).toBe("built-in form");
  });
  it("builds a message from the built-in form", () => {
    const v = requestVars({ state: "tm", country: "Turkmenistan", validFrom: "2026-11-01", validTo: "2026-11-30", aircraft: ["UP-B3748"], agent: "ACME", signature: "Ops", flights: [{ ref: "DV123", origin: "ALA", destination: "DMB", start: new Date("2026-11-02T04:05:00Z") }] });
    const m = buildFromTemplate(pickTemplate({ state: "TM", channel: "agent", agentId: "x" }), v);
    expect(m.subject).toBe("Overfly permit request – Turkmenistan (TM) – 2026-11-01 to 2026-11-30 – UP-B3748");
    expect(m.body).toContain("Dear ACME,");
    expect(m.body).toContain("2026-11-02  04:05  DV123  ALA-DMB");
    expect(m.body).not.toContain("{{");
  });
});
