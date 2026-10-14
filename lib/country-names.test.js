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

import { allCountries } from "./country-names.js";
describe("allCountries", () => {
  it("lists every country sorted by name", () => {
    const l = allCountries();
    expect(l.length).toBeGreaterThan(200);
    expect(l.find(([c]) => c === "KG")[1]).toBe("Kyrgyzstan");
    const names = l.map(x => x[1]);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
