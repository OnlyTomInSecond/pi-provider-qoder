import { describe, expect, it } from "vitest";
import { repairJsonEscapes } from "../protocol/json-repair.js";

describe("repairJsonEscapes", () => {
  it("leaves valid JSON untouched", () => {
    const valid = '{"path":"/a/b.c","edits":[{"oldText":"static int f(\\n\\tint x)","newText":"y"}]}';
    expect(repairJsonEscapes(valid)).toBe(valid);
  });

  it("escapes raw control characters inside string literals", () => {
    expect(repairJsonEscapes('{"oldText":"int f(\n\tint x)"}')).toBe('{"oldText":"int f(\\n\\tint x)"}');
  });

  it("escapes control characters that have no short form", () => {
    expect(repairJsonEscapes('{"a":"x\u0001y"}')).toBe('{"a":"x\\u0001y"}');
  });

  it("doubles backslashes that start an illegal escape", () => {
    expect(repairJsonEscapes('{"cmd":"grep -P \\d" }')).toBe('{"cmd":"grep -P \\\\d" }');
  });

  it("doubles backslashes before a short \\u sequence", () => {
    expect(repairJsonEscapes('{"a":"\\u12"}')).toBe('{"a":"\\\\u12"}');
  });

  it("doubles a trailing backslash inside a string", () => {
    // Input ends mid-string with a lone backslash: `{"a":"abc\`
    expect(repairJsonEscapes('{"a":"abc\\')).toBe('{"a":"abc\\\\');
  });

  it("keeps structure characters outside strings untouched", () => {
    const raw = '{"a":"x\ny","b":1}';
    expect(repairJsonEscapes(raw)).toBe('{"a":"x\\ny","b":1}');
  });

  it("does not repair truncated structure", () => {
    const truncated = '{"path":"/a","edits":[{"oldText":"foo';
    expect(repairJsonEscapes(truncated)).toBe(truncated);
    expect(() => JSON.parse(repairJsonEscapes(truncated))).toThrow();
  });
});
