import { describe, expect, it } from "vitest";
import { LruMap } from "../lru.js";

describe("LruMap", () => {
  it("evicts the least-recently-used entry past the cap", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("c", 3);
    expect(lru.has("a")).toBe(false);
    expect(lru.get("b")).toBe(2);
    expect(lru.get("c")).toBe(3);
  });

  it("refreshes recency on get", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a"); // a is now most-recent
    lru.set("c", 3); // b is evicted
    expect(lru.has("a")).toBe(true);
    expect(lru.has("b")).toBe(false);
    expect(lru.has("c")).toBe(true);
  });

  it("refreshes recency on set of an existing key", () => {
    const lru = new LruMap<string, number>(2);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.set("a", 10);
    lru.set("c", 3);
    expect(lru.get("a")).toBe(10);
    expect(lru.has("b")).toBe(false);
  });

  it("supports delete/clear/size", () => {
    const lru = new LruMap<string, number>(3);
    lru.set("a", 1);
    lru.set("b", 2);
    expect(lru.size).toBe(2);
    expect(lru.delete("a")).toBe(true);
    expect(lru.size).toBe(1);
    lru.clear();
    expect(lru.size).toBe(0);
  });
});
