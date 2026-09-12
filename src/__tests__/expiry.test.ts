import { describe, expect, it } from "vitest";
import { DEFAULT_TOKEN_TTL_MS, parseExpiresAt, resolveTokenExpiry } from "../auth/expiry.js";

describe("parseExpiresAt", () => {
  it("parses ISO date strings", () => {
    const iso = "2030-01-02T03:04:05.000Z";
    expect(parseExpiresAt(iso)).toBe(Date.parse(iso));
  });

  it("parses numeric-string epoch milliseconds", () => {
    expect(parseExpiresAt("1893456000000")).toBe(1893456000000);
  });

  it("passes through positive numbers", () => {
    expect(parseExpiresAt(1893456000000)).toBe(1893456000000);
  });

  it("returns undefined for missing/invalid values", () => {
    expect(parseExpiresAt(undefined)).toBeUndefined();
    expect(parseExpiresAt(null)).toBeUndefined();
    expect(parseExpiresAt("")).toBeUndefined();
    expect(parseExpiresAt("not-a-date")).toBeUndefined();
    expect(parseExpiresAt(0)).toBeUndefined();
    expect(parseExpiresAt(-1)).toBeUndefined();
    expect(parseExpiresAt(Number.NaN)).toBeUndefined();
  });
});

describe("resolveTokenExpiry", () => {
  it("treats expires_in as milliseconds", () => {
    const before = Date.now();
    // 86400000 ms == 24h, the value observed from the live API.
    expect(resolveTokenExpiry({ expires_in: 86_400_000 })).toBeGreaterThanOrEqual(before + 86_400_000);
  });

  it("prefers expires_at over expires_in", () => {
    const at = Date.parse("2031-05-06T07:08:09.000Z");
    expect(resolveTokenExpiry({ expires_at: "2031-05-06T07:08:09.000Z", expires_in: 1000 })).toBe(at);
  });

  it("uses a numeric-string expires_at", () => {
    expect(resolveTokenExpiry({ expires_at: "1893456000000" })).toBe(1893456000000);
  });

  it("falls back to the default TTL when both are absent", () => {
    const before = Date.now();
    const expiry = resolveTokenExpiry({});
    expect(expiry).toBeGreaterThanOrEqual(before + DEFAULT_TOKEN_TTL_MS);
  });

  it("honours a custom fallback TTL", () => {
    const before = Date.now();
    const expiry = resolveTokenExpiry({}, 60_000);
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiry).toBeLessThan(before + 120_000);
  });

  it("ignores a non-positive expires_in and uses the fallback", () => {
    const before = Date.now();
    const expiry = resolveTokenExpiry({ expires_in: 0 }, 60_000);
    expect(expiry).toBeGreaterThanOrEqual(before + 60_000);
  });
});
