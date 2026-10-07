import { describe, it, expect } from "vitest";
import { matchEmailToPermit, extractText, listAttachments, decodeB64Url, safeFileName } from "./permit-mail";

const b64 = s => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const permits = [
  { id: "p1", state: "TM", status: "submitted", permitNumber: null, authorityRef: "TKM-2026/118" },
  { id: "p2", state: "UZ", status: "approved", permitNumber: "UZ 55120", authorityRef: null },
  { id: "p3", state: "KG", status: "cancelled", permitNumber: "KG-9981", authorityRef: null },
];

describe("matchEmailToPermit", () => {
  it("matches an authority reference regardless of spacing and punctuation", () => {
    expect(matchEmailToPermit("Re: your request tkm 2026-118", "", permits)).toMatchObject({ permitId: "p1" });
  });
  it("matches a permit number found in the body", () => {
    expect(matchEmailToPermit("Permit", "We confirm permit UZ-55120 for 1 Nov.", permits).permitId).toBe("p2");
  });
  it("ignores cancelled permits and finds nothing when no reference is present", () => {
    expect(matchEmailToPermit("KG-9981", "", permits).permitId).toBe(null);
    expect(matchEmailToPermit("Hello", "Thanks, regards", permits).permitId).toBe(null);
  });
  it("does not match on short or digitless references", () => {
    expect(matchEmailToPermit("TM", "", [{ id: "x", status: "draft", authorityRef: "TM" }, { id: "y", status: "draft", authorityRef: "ABCDEFG" }]).permitId).toBe(null);
  });
  it("reports ambiguity instead of guessing", () => {
    const r = matchEmailToPermit("TKM-2026/118 and UZ55120", "", permits);
    expect(r.permitId).toBe(null);
    expect(r.reason).toContain("ambiguous");
  });
});

describe("Gmail payload helpers", () => {
  const payload = { mimeType: "multipart/mixed", headers: [{ name: "Subject", value: "Hi" }], parts: [
    { mimeType: "multipart/alternative", parts: [
      { mimeType: "text/plain", body: { data: b64("Permit approved\nRef 123456") } },
      { mimeType: "text/html", body: { data: b64("<p>ignored html</p>") } } ] },
    { mimeType: "application/pdf", filename: "permit.pdf", body: { attachmentId: "a1", size: 1000 } },
    { mimeType: "application/x-msdownload", filename: "evil.exe", body: { attachmentId: "a2", size: 10 } },
    { mimeType: "application/pdf", filename: "huge.pdf", body: { attachmentId: "a3", size: 50 * 1024 * 1024 } },
  ] };
  it("prefers plain text and decodes base64url", () => { expect(extractText(payload)).toBe("Permit approved\nRef 123456"); expect(decodeB64Url(b64("héllo"))).toBe("héllo"); });
  it("falls back to stripped HTML", () => { expect(extractText({ mimeType: "text/html", body: { data: b64("<div>Hello<br>World &amp; co</div>") } })).toBe("Hello\nWorld & co"); });
  it("keeps only allowed, reasonably sized attachments", () => { expect(listAttachments(payload).map(a => a.name)).toEqual(["permit.pdf"]); });
  it("sanitises file names", () => { expect(safeFileName("../a b/c?.pdf")).toBe(".._a_b_c_.pdf"); });
});
