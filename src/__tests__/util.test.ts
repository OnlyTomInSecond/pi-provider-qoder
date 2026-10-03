import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeRegExp, readNumericOption } from "../util.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("escapeRegExp", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
    expect(new RegExp(escapeRegExp("<x>")).test("<x>")).toBe(true);
  });
});

describe("readNumericOption", () => {
  const always = () => true;

  it("returns the fallback when unset", () => {
    expect(readNumericOption("QODER_TEST_UNSET", undefined, 42, always)).toBe(42);
  });

  it("prefers the host env over process.env", () => {
    vi.stubEnv("QODER_TEST_VALUE", "1");
    expect(readNumericOption("QODER_TEST_VALUE", { QODER_TEST_VALUE: "5" }, 42, always)).toBe(5);
    expect(readNumericOption("QODER_TEST_VALUE", undefined, 42, always)).toBe(1);
  });

  it("falls back when the value fails the validity check", () => {
    vi.stubEnv("QODER_TEST_VALUE", "not-a-number");
    expect(readNumericOption("QODER_TEST_VALUE", undefined, 7, (v) => Number.isFinite(v))).toBe(7);
    vi.stubEnv("QODER_TEST_VALUE", "-1");
    expect(readNumericOption("QODER_TEST_VALUE", undefined, 7, (v) => v >= 0)).toBe(7);
  });
});
