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

import { renderTemplate, unknownPlaceholders, pickTemplate, requestVars, buildFromTemplate, scheduleLines, routesText, seasonOf, aircraftTypesText } from "./permit-request";
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
  it("builds an agent request like the Access Support sample", () => {
    const mk = (ref, o, d, dep, arr, date) => ({ ref, origin: o, destination: d, start: new Date(`${date}T${dep}:00Z`), arrivalAt: new Date(`${date}T${arr}:00Z`) });
    const fl = [mk("DV5316", "ALA", "PQC", "21:00", "23:00", "2026-10-20"), mk("DV5335", "CXR", "ALA", "07:30", "10:00", "2026-10-21"), mk("DV5316", "ALA", "PQC", "21:00", "23:00", "2026-10-24")];
    // Friday every week 30.10 to 20.11 = 4 flights
    ["2026-10-30", "2026-11-06", "2026-11-13", "2026-11-20"].forEach(d => fl.push(mk("DV5325", "PQC", "ALA", "03:30", "09:00", d)));
    const lines = scheduleLines(fl);
    expect(lines).toContain("5316  ALA-PQC   21:00  23:00  20.10.");
    expect(lines).toContain("5316  ALA-PQC   21:00  23:00  24.10.");
    expect(lines).toContain("5325  PQC-ALA   03:30  09:00  5 DAY FROM 30.10 TO 20.11");
    expect(lines).toContain("5335  CXR-ALA   07:30  10:00  21.10.");
    expect(routesText(fl)).toBe("ALA-PQC-ALA, CXR-ALA");
    expect(seasonOf("2026-10-20", "2027-03-26")).toBe("W26");
    expect(seasonOf("2027-01-05", null)).toBe("W26");
    expect(seasonOf("2026-06-01")).toBe("S26");
    const fleet = [{ code: "UP-B3727", variant: "B39M · 213Y" }, { code: "UP-B3726", variant: "B39M · 213Y" }, { code: "UP-B5703", variant: "B752 · 235Y" }];
    expect(aircraftTypesText(fleet)).toBe("B737 MAX 9 REG. UP-B3726 / UP-B3727\nB757-200 REG. UP-B5703");
    const m = buildFromTemplate(pickTemplate({ state: "TM", channel: "agent", agentId: "x" }), requestVars({ state: "TM", country: "Turkmenistan", validFrom: "2026-10-20", validTo: "2026-11-20", agent: "Aleksandr", fleet, flights: fl, routeDetail: "PAKISTAN\nMOTMO P500 PS J143 NONIB L509 SULOM" }));
    expect(m.subject).toBe("Overfly permit request – ALA-PQC-ALA, CXR-ALA – W26");
    expect(m.body).toContain("Dear Aleksandr,");
    expect(m.body).toContain("JSC Aircompany SCAT kindly request to obtain overflight permission for W26 ALA-PQC-ALA, CXR-ALA flights");
    expect(m.body).toContain("B757-200 REG. UP-B5703");
    expect(m.body).toContain("PAKISTAN\nMOTMO P500");
    expect(m.body).toContain("Best Regards,\nStanislav Ryaskov\nDeputy Head of OCC\nJSC \"Aircompany \"SCAT\"\nTel: 8/7252/99 88 80 (ext 206), 45 50 90\nMob:+77713848769");
    expect(m.body).not.toContain("quotation");
    expect(m.body).not.toContain("{{");
  });
  it("writes one period line per weekday; short runs are listed by date", () => {
    const mk = (date, ref = "DV5316") => ({ ref, origin: "ALA", destination: "PQC", start: new Date(date + "T19:05:00Z"), arrivalAt: new Date(date + "T21:05:00Z") });
    const daily = [];
    for (let i = 0; i < 21; i++) daily.push(mk(new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10)));
    const l = scheduleLines(daily);
    expect(l).toHaveLength(7);
    expect(l[0]).toBe("5316  ALA-PQC   19:05  21:05  1 DAY FROM 02.11 TO 16.11");
    expect(l[1]).toBe("5316  ALA-PQC   19:05  21:05  2 DAY FROM 03.11 TO 17.11");
    const two = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-12-01"].map(d => mk(d));
    expect(scheduleLines(two)).toEqual(["5316  ALA-PQC   19:05  21:05  1 DAY FROM 02.11 TO 16.11", "5316  ALA-PQC   19:05  21:05  01.12."]);
  });
});
