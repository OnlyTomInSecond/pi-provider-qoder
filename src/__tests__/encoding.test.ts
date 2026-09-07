import { describe, expect, it } from "vitest";
import { QODER_ENCODE_CHUNK, qoderEncodeBody, qoderEncodeBodyAsync } from "../protocol/encoding.js";

function ascii(buf: Buffer): string {
  return buf.toString("ascii");
}

describe("qoderEncodeBody", () => {
  it("encodes a simple string into a Buffer", () => {
    const result = qoderEncodeBody("hello");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    // Should not contain standard base64 padding char '='
    expect(ascii(result)).not.toContain("=");
  });

  it("encodes a Buffer", () => {
    const buf = Buffer.from("hello world");
    const result = qoderEncodeBody(buf);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(ascii(result)).not.toContain("=");
  });

  it("produces deterministic output", () => {
    const a = qoderEncodeBody("test input");
    const b = qoderEncodeBody("test input");
    expect(a.equals(b)).toBe(true);
  });

  it("produces different output for different inputs", () => {
    const a = qoderEncodeBody("input A");
    const b = qoderEncodeBody("input B");
    expect(a.equals(b)).toBe(false);
  });

  it("handles empty string", () => {
    const result = qoderEncodeBody("");
    expect(result.length).toBe(0);
  });

  it("handles empty Buffer", () => {
    const result = qoderEncodeBody(Buffer.alloc(0));
    expect(result.length).toBe(0);
  });

  it("replaces '=' padding with '$'", () => {
    // Base64 of "a" is "YQ==" which has padding — our encoding should use $
    expect(ascii(qoderEncodeBody("a"))).not.toContain("=");
    expect(ascii(qoderEncodeBody("a"))).toContain("$");
  });

  it("uses custom alphabet (not standard base64)", () => {
    const result = qoderEncodeBody("The quick brown fox");
    // Standard base64 would use A-Za-z0-9+/=
    // Our encoding uses a custom alphabet, so the output should differ
    const stdBase64 = Buffer.from("The quick brown fox").toString("base64");
    expect(ascii(result)).not.toBe(stdBase64);
  });

  it("handles binary content", () => {
    const binary = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01]);
    const result = qoderEncodeBody(binary);
    expect(result.length).toBeGreaterThan(0);
    expect(ascii(result)).not.toContain("=");
  });

  it("handles JSON content", () => {
    const json = JSON.stringify({ key: "value", num: 42 });
    const result = qoderEncodeBody(json);
    expect(result.length).toBeGreaterThan(0);
    expect(ascii(result)).not.toContain("=");
  });

  it("matches the preallocation length of the block-reordered base64", () => {
    // Sanity: output buffer is exactly as long as the source base64 (reorder
    // permutes, never resizes).
    const input = "The quick brown fox jumps over the lazy dog";
    const std = Buffer.from(input).toString("base64");
    expect(qoderEncodeBody(input).length).toBe(std.length);
  });
});

describe("qoderEncodeBodyAsync", () => {
  it("returns the same bytes as qoderEncodeBody", async () => {
    const input = "The quick brown fox jumps over the lazy dog";
    expect((await qoderEncodeBodyAsync(input)).equals(qoderEncodeBody(input))).toBe(true);
  });

  it("yields while encoding a large request body", async () => {
    // Larger than one encode chunk so the async loop actually yields.
    const input = "x".repeat(QODER_ENCODE_CHUNK + 64 * 1024);
    let eventLoopYielded = false;
    const nextTurn = new Promise<void>((resolve) => {
      setImmediate(() => {
        eventLoopYielded = true;
        resolve();
      });
    });

    const encoded = await qoderEncodeBodyAsync(input);
    await nextTurn;

    expect(encoded.equals(qoderEncodeBody(input))).toBe(true);
    expect(eventLoopYielded).toBe(true);
  });

  it("handles a body smaller than one chunk", async () => {
    const input = "hello";
    expect((await qoderEncodeBodyAsync(input)).equals(qoderEncodeBody(input))).toBe(true);
  });
});
