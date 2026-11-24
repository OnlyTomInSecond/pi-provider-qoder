import { readFileSync, writeFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { contextWindowFromCatalog } from "../catalog.js";
import {
  clearQoderSettingsCache,
  getQoderSettingsPath,
  normalizeQoderSettings,
  readQoderSettings,
  resolveContextWindowOverride,
  resolveDebugEnabled,
  resolveMaxOutputTokens,
  resolvePreferMaxContext,
  resolveReasoningReplay,
  resolveStreamDeltaIntervalMs,
  resolveStreamIdleTimeoutMs,
  writeQoderSettings,
} from "../qoder-settings.js";
import { applySettingsArguments, describeQoderSettings } from "../settings-ui.js";

beforeEach(() => {
  clearQoderSettingsCache();
  writeQoderSettings({});
});

describe("normalizeQoderSettings", () => {
  it("keeps valid values", () => {
    expect(
      normalizeQoderSettings({
        contextWindow: 400000,
        useMaxContext: true,
        maxOutputTokens: 65536,
        replayReasoning: "last",
        streamIdleTimeoutMs: 60000,
        streamDeltaIntervalMs: 0,
        debug: true,
      }),
    ).toEqual({
      contextWindow: 400000,
      useMaxContext: true,
      maxOutputTokens: 65536,
      replayReasoning: "last",
      streamIdleTimeoutMs: 60000,
      streamDeltaIntervalMs: 0,
      debug: true,
    });
  });

  it("keeps null as the explicit 'catalog default' marker", () => {
    expect(normalizeQoderSettings({ contextWindow: null })).toEqual({ contextWindow: null });
  });

  it("drops invalid and unknown fields", () => {
    expect(
      normalizeQoderSettings({
        contextWindow: -1,
        useMaxContext: "yes",
        maxOutputTokens: 999999,
        replayReasoning: "sometimes",
        streamIdleTimeoutMs: 0,
        streamDeltaIntervalMs: -1,
        debug: "yes",
        extra: "ignored",
      }),
    ).toEqual({});
  });
});

describe("settings file", () => {
  it("round-trips through the qoder state directory", () => {
    const saved = writeQoderSettings({ maxOutputTokens: 65536, replayReasoning: "all" });
    expect(saved).toEqual({ maxOutputTokens: 65536, replayReasoning: "all" });
    expect(getQoderSettingsPath()).toContain("qoder");
    expect(JSON.parse(readFileSync(getQoderSettingsPath(), "utf8"))).toEqual(saved);
    expect(readQoderSettings()).toEqual(saved);
  });

  it("treats a corrupt file as no overrides", () => {
    writeQoderSettings({});
    writeQoderSettings({ maxOutputTokens: 65536 });
    // Overwrite with invalid JSON behind the API's back.
    const path = getQoderSettingsPath();
    writeFileSync(path, "{not json", "utf8");
    clearQoderSettingsCache();
    expect(readQoderSettings()).toEqual({});
  });
});

describe("resolvers", () => {
  it("defaults to qodercli values", () => {
    expect(resolveMaxOutputTokens()).toBe(32768);
    expect(resolveContextWindowOverride()).toBeUndefined();
    expect(resolvePreferMaxContext()).toBe(false);
    expect(resolveReasoningReplay()).toBe("none");
    expect(resolveStreamIdleTimeoutMs()).toBe(120000);
    expect(resolveStreamDeltaIntervalMs()).toBe(50);
    expect(resolveDebugEnabled()).toBe(false);
  });

  it("reads persisted settings", () => {
    writeQoderSettings({ maxOutputTokens: 65536, contextWindow: 400000, replayReasoning: "last" });
    expect(resolveMaxOutputTokens()).toBe(65536);
    expect(resolveContextWindowOverride()).toBe(400000);
    expect(resolveReasoningReplay()).toBe("last");
    writeQoderSettings({ useMaxContext: true });
    expect(resolvePreferMaxContext()).toBe(true);
  });

  it("reads the advanced settings", () => {
    writeQoderSettings({ streamIdleTimeoutMs: 60000, streamDeltaIntervalMs: 0, debug: true });
    expect(resolveStreamIdleTimeoutMs()).toBe(60000);
    expect(resolveStreamDeltaIntervalMs()).toBe(0);
    expect(resolveDebugEnabled()).toBe(true);
  });

  it("lets environment variables win over the settings file", () => {
    writeQoderSettings({ maxOutputTokens: 65536, contextWindow: 400000, replayReasoning: "last" });
    expect(resolveMaxOutputTokens({ QODER_MAX_OUTPUT_TOKENS: "131072" })).toBe(131072);
    expect(resolveContextWindowOverride({ QODER_CONTEXT_WINDOW: "1000000" })).toBe(1000000);
    expect(resolvePreferMaxContext({ QODER_CONTEXT_MAX: "1" })).toBe(true);
    expect(resolveReasoningReplay({ QODER_REPLAY_REASONING: "all" })).toBe("all");
    expect(resolveStreamIdleTimeoutMs({ QODER_STREAM_IDLE_TIMEOUT_MS: "30000" })).toBe(30000);
    expect(resolveStreamDeltaIntervalMs({ QODER_STREAM_DELTA_INTERVAL_MS: "0" })).toBe(0);
    expect(resolveDebugEnabled({ QODER_DEBUG: "1" })).toBe(true);
  });

  it("ignores out-of-range environment values", () => {
    writeQoderSettings({ maxOutputTokens: 65536 });
    expect(resolveMaxOutputTokens({ QODER_MAX_OUTPUT_TOKENS: "999999" })).toBe(65536);
    expect(resolveMaxOutputTokens({ QODER_MAX_OUTPUT_TOKENS: "nope" })).toBe(65536);
    expect(resolveContextWindowOverride({ QODER_CONTEXT_WINDOW: "-5" })).toBeUndefined();
    expect(resolveStreamIdleTimeoutMs({ QODER_STREAM_IDLE_TIMEOUT_MS: "0" })).toBe(120000);
    expect(resolveStreamDeltaIntervalMs({ QODER_STREAM_DELTA_INTERVAL_MS: "999999" })).toBe(50);
  });

  it("applies the persisted context window on top of a catalog entry", () => {
    const entry = {
      context_config: { "200K": { token_count: 200000, is_default: true }, "1M": { token_count: 1000000 } },
    };
    expect(contextWindowFromCatalog(entry)).toBe(200000);
    writeQoderSettings({ contextWindow: 400000 });
    expect(contextWindowFromCatalog(entry)).toBe(400000);
    writeQoderSettings({ contextWindow: 2000000 });
    // Capped to the largest tier the catalog actually advertises.
    expect(contextWindowFromCatalog(entry)).toBe(1000000);
    writeQoderSettings({ useMaxContext: true });
    expect(contextWindowFromCatalog(entry)).toBe(1000000);
  });
});

describe("applySettingsArguments", () => {
  it("parses the non-interactive forms", () => {
    expect(applySettingsArguments("context 400000", {}).settings).toEqual({
      contextWindow: 400000,
      useMaxContext: false,
    });
    expect(applySettingsArguments("context max", {}).settings).toEqual({
      contextWindow: null,
      useMaxContext: true,
    });
    expect(applySettingsArguments("context default", { contextWindow: 400000 }).settings).toEqual({
      contextWindow: null,
      useMaxContext: false,
    });
    expect(applySettingsArguments("output 65536", {}).settings).toEqual({ maxOutputTokens: 65536 });
    expect(applySettingsArguments("reasoning all", {}).settings).toEqual({ replayReasoning: "all" });
    expect(applySettingsArguments("stream-idle 60000", {}).settings).toEqual({ streamIdleTimeoutMs: 60000 });
    expect(applySettingsArguments("stream-delta 0", {}).settings).toEqual({ streamDeltaIntervalMs: 0 });
    expect(applySettingsArguments("debug on", {}).settings).toEqual({ debug: true });
    expect(applySettingsArguments("reset", { maxOutputTokens: 65536 })).toEqual({
      settings: {},
      message: "Qoder settings reset to defaults.",
    });
  });

  it("clears the output override with 'default'", () => {
    const result = applySettingsArguments("output default", { maxOutputTokens: 65536, replayReasoning: "last" });
    expect(result.settings).toEqual({ replayReasoning: "last" });
  });

  it("rejects invalid input with usage", () => {
    for (const args of [
      "context nope",
      "output 0",
      "output 999999",
      "reasoning sometimes",
      "stream-idle 0",
      "stream-delta -1",
      "debug maybe",
      "wat",
    ]) {
      const result = applySettingsArguments(args, {});
      expect(result.error, args).toBe(true);
      expect(result.message).toContain("Usage");
      expect(result.settings).toBeUndefined();
    }
  });

  it("shows the effective values", () => {
    const summary = describeQoderSettings({ contextWindow: 400000, maxOutputTokens: 65536, replayReasoning: "last" });
    expect(summary).toContain("Context window: 400000 tokens");
    expect(summary).toContain("Max output tokens: 65536");
    expect(summary).toContain("Replay prior reasoning: last");
    expect(applySettingsArguments("show", {}).message).toContain("Context window: catalog default");
    expect(applySettingsArguments("show", {}).message).toContain("Debug logging: off");
    expect(applySettingsArguments("stream-idle default", { streamIdleTimeoutMs: 60000 }).settings).toEqual({});
    expect(applySettingsArguments("stream-delta default", { streamDeltaIntervalMs: 100 }).settings).toEqual({});
  });
});
