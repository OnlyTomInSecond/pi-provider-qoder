import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearQoderSettingsCache, readQoderSettings, writeQoderSettings } from "../qoder-settings.js";
import { registerQoderSettingsUi } from "../settings-ui.js";

interface FakeUi {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  notes: Array<{ message: string; level: string | undefined }>;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

/**
 * Build the command exactly as pi would, with the UI dialogs scripted by a
 * queue of answers (select/input return the next entry).
 */
function harness(answers: Array<string | undefined>, options: { hasUI?: boolean } = {}): FakeUi {
  const notes: Array<{ message: string; level: string | undefined }> = [];
  let handler: FakeUi["handler"] = async () => {};
  const pi = {
    registerCommand: (name: string, command: { handler: FakeUi["handler"] }) => {
      expect(name).toBe("qoder-settings");
      handler = command.handler;
    },
  } as unknown as ExtensionAPI;
  const queue = [...answers];
  const ctx = {
    hasUI: options.hasUI ?? true,
    ui: {
      select: async () => queue.shift(),
      input: async () => queue.shift(),
      notify: (message: string, level?: string) => notes.push({ message, level }),
    },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    notes,
    get handler() {
      return handler;
    },
  } as FakeUi;
}

afterEach(() => {
  clearQoderSettingsCache();
  writeQoderSettings({});
});

describe("registerQoderSettingsUi", () => {
  it("registers the command", () => {
    const fake = harness([]);
    registerQoderSettingsUi(fake.pi, () => {});
    expect(typeof fake.handler).toBe("function");
  });

  it("applies non-interactive arguments and re-registers the provider", async () => {
    const apply = vi.fn();
    const fake = harness([]);
    registerQoderSettingsUi(fake.pi, apply);

    await fake.handler("reasoning all", fake.ctx);
    expect(readQoderSettings()).toEqual({ replayReasoning: "all" });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(fake.notes.at(-1)?.message).toContain("Replay prior reasoning: all");

    await fake.handler("context 400000", fake.ctx);
    expect(readQoderSettings().contextWindow).toBe(400000);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("reports invalid arguments without persisting", async () => {
    const apply = vi.fn();
    const fake = harness([]);
    registerQoderSettingsUi(fake.pi, apply);
    await fake.handler("reasoning sometimes", fake.ctx);
    expect(readQoderSettings()).toEqual({});
    expect(apply).not.toHaveBeenCalled();
    expect(fake.notes.at(-1)?.level).toBe("warning");
  });

  it("walks the menu: pick reasoning, then Done", async () => {
    const apply = vi.fn();
    const fake = harness(["Replay prior reasoning: none", "all — qodercli behavior, most Credits", "Done"]);
    registerQoderSettingsUi(fake.pi, apply);
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({ replayReasoning: "all" });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("sets a custom context window through the menu", async () => {
    const fake = harness(["Context window: catalog default", "Custom…", "300000", "Done"]);
    registerQoderSettingsUi(fake.pi, () => {});
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({ contextWindow: 300000, useMaxContext: false });
  });

  it("rejects a bad custom context window", async () => {
    const apply = vi.fn();
    const fake = harness(["Context window: catalog default", "Custom…", "lots", "Done"]);
    registerQoderSettingsUi(fake.pi, apply);
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({});
    expect(apply).not.toHaveBeenCalled();
    expect(fake.notes.at(-1)?.level).toBe("warning");
  });

  it("toggles debug logging from the advanced menu", async () => {
    const fake = harness(["Advanced…", "Debug logging: off", "Back", "Done"]);
    registerQoderSettingsUi(fake.pi, () => {});
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({ debug: true });
  });

  it("sets the stream idle timeout from the advanced menu", async () => {
    const fake = harness(["Advanced…", "Stream idle timeout: 120000 ms", "300000", "Back", "Done"]);
    registerQoderSettingsUi(fake.pi, () => {});
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({ streamIdleTimeoutMs: 300000 });
  });

  it("applies the advanced non-interactive arguments", async () => {
    const apply = vi.fn();
    const fake = harness([]);
    registerQoderSettingsUi(fake.pi, apply);
    await fake.handler("stream-idle 60000", fake.ctx);
    await fake.handler("stream-delta 0", fake.ctx);
    await fake.handler("debug on", fake.ctx);
    expect(readQoderSettings()).toEqual({
      streamIdleTimeoutMs: 60000,
      streamDeltaIntervalMs: 0,
      debug: true,
    });
    expect(apply).toHaveBeenCalledTimes(3);
  });

  it("resets everything and prints a summary without a UI", async () => {
    writeQoderSettings({ maxOutputTokens: 65536, replayReasoning: "all" });
    const fake = harness(["Reset to defaults", "Done"]);
    registerQoderSettingsUi(fake.pi, () => {});
    await fake.handler("", fake.ctx);
    expect(readQoderSettings()).toEqual({});

    const headless = harness([], { hasUI: false });
    registerQoderSettingsUi(headless.pi, () => {});
    await headless.handler("", headless.ctx);
    expect(headless.notes.at(-1)?.message).toContain("Context window: catalog default");
  });
});
