import { describe, it, expect } from "vitest";
import { countryName, stateLabel } from "./country-names.js";

describe("country names", () => {
  it("gives the full name, with the code where it is typed", () => {
    expect(countryName("kg")).toBe("Kyrgyzstan");
    expect(stateLabel("kz")).toBe("Kazakhstan (KZ)");
  });
  it("returns what was typed when the code is unknown", () => {
    expect(countryName("Turkmenistan")).toBe("Turkmenistan");
    expect(stateLabel("")).toBe("");
    expect(countryName(null)).toBe("");
  });
});
