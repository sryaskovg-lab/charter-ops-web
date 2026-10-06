import { describe, it, expect } from "vitest";
import { fetchAllPages } from "./fetchAllPages";

// Fake PostgREST: returns rows [a..], never more than `cap` per request (the server-side max-rows).
const fake = (n, cap) => () => ({
  range: async (a, b) => ({
    data: Array.from({ length: Math.max(0, Math.min(n, a + Math.min(b - a + 1, cap)) - a) }, (_, i) => a + i),
    error: null,
  }),
});

describe("fetchAllPages", () => {
  it.each([[3164, 1000], [3164, 500], [0, 1000], [1000, 1000], [1, 1000]])("returns all %i rows when the server caps pages at %i", async (n, cap) => {
    const { data, error } = await fetchAllPages(fake(n, cap));
    expect(error).toBeNull();
    expect(data.length).toBe(n);
    expect(new Set(data).size).toBe(n);
  });
  it("returns the error and no partial data when a page fails", async () => {
    const res = await fetchAllPages(() => ({ range: async () => ({ data: null, error: { message: "boom" } }) }));
    expect(res.data).toBeNull();
    expect(res.error.message).toBe("boom");
  });
});
