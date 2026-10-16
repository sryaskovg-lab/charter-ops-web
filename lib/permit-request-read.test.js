import { describe, it, expect } from "vitest";
import { parseScheduleLine, readRequestMail, requestItems, countryOfHeading, threadBlocks } from "./permit-request-read";

const REF = new Date("2026-10-02T10:00:00Z");
describe("permit-request-read", () => {
  it("reads our own layout", () => {
    const r = parseScheduleLine("5316  ALA-PQC   19:05  21:05  5 DAY FROM 30.10 TO 13.11", REF);
    expect(r).toMatchObject({ number: "5316", origin: "ALA", destination: "PQC" });
    expect(r.dates).toEqual(["2026-10-30", "2026-11-06", "2026-11-13"]);
    expect(parseScheduleLine("5316  ALA-PQC   19:05  21:05  12.11. ", REF).dates).toEqual(["2026-11-12"]);
    expect(parseScheduleLine("5316  ALA-PQC   19:05  21:05  DAILY FROM 30.12 TO 02.01", REF).dates).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]);
  });
  it("reads hand-typed lines", () => {
    expect(parseScheduleLine("VSV777 SYX0830 - 1200 SIN 20 and 24 OCT", REF)).toMatchObject({ number: "777", origin: "SYX", destination: "SIN", dates: ["2026-10-20", "2026-10-24"] });
    const e = parseScheduleLine("VSV778 SIN1430 - 1800 SYX every 4th day from 29OCT till 12NOV", REF);
    expect(e.dates).toEqual(["2026-10-29", "2026-11-02", "2026-11-06", "2026-11-10"]);
    expect(parseScheduleLine("Best regards", REF)).toBe(null);
  });
  it("recognises country headings, also misspelled", () => {
    expect(countryOfHeading("VIETNAM", ["VN"])).toBe("VN");
    expect(countryOfHeading("AFGANISTAN", [])).toBe("AF");
    expect(countryOfHeading("ROUTE CAMBODIA", [])).toBe("KH");
    expect(countryOfHeading("BOKAK R468 SAPEN", [])).toBe(null);
    expect(countryOfHeading("VSV777 BUNTA G221 PCA", [])).toBe(null);
  });
  it("reads the newest request in a forwarded thread and builds items", () => {
    const text = [
      "Best Regards,\nStanislav\n",
      "From: Access Operations <OPS@access.aero>\nSent: Friday\nSubject: X\n\nDear Stanislav,\nOur finance will do necessary.\n",
      "From: Stanislav Ryaskov <s.ryaskov@scat.kz>\nSent: Thursday, September 17, 2026 1:15 PM\nSubject: RE: REMINDER\n\nDear Aleksandr,\n\nKindly obtain OF permits for our CIT-SYX - SIN and v.v. according schedule and route below:\n\nSCHEDULE\n\nVSV777 SYX0830 - 1200 SIN 20 and 24 OCT\nVSV778 SIN1300 - 1600 SYX 20 and 24 OCT\n\nRoute:\n\nVIETNAM\n\nVSV777 BUNTA G221 PCA W12 BMT\n\nMALAYSIA\n\nESPOB.ELALO ELAL1A\n",
    ].join("\n");
    expect(threadBlocks(text).length).toBe(3);
    const r = readRequestMail(text, { receivedAt: "2026-10-02T09:27:00Z" });
    expect(r.found).toBe(true);
    expect(r.states).toEqual(["VN", "MY"]);
    const items = requestItems(r, n => ["DV" + n]);
    expect(items.map(i => [i.state, i.decision, i.flights, i.validFrom, i.validTo])).toEqual([
      ["VN", "pending", ["DV777", "DV778"], "2026-10-20", "2026-10-24"], ["MY", "pending", ["DV777", "DV778"], "2026-10-20", "2026-10-24"]]);
  });
  it("finds nothing in an ordinary reply", () => {
    expect(readRequestMail("Dear Stanislav,\n\nOur finance will do necessary.", {}).found).toBe(false);
    expect(requestItems({ found: false, states: [], flights: [] })).toEqual([]);
  });
});
