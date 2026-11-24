import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DELTA_FLUSH_INTERVAL_MS } from "./protocol/delta-coalescer.js";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  getQoderSettingsPath,
  MAX_OUTPUT_TOKENS_LIMIT,
  type QoderSettings,
  type ReasoningReplay,
  readQoderSettings,
  writeQoderSettings,
} from "./qoder-settings.js";

/**
 * TUI front-end for the Credit-relevant options.
 *
 * pi has no generic "extension options page" (`/settings` only edits pi's own
 * settings), so an extension exposes its options through a command plus
 * `ctx.ui.select()` / `ctx.ui.input()`. Values persist to
 * `~/.pi/agent/qoder/qoder-settings.json` and take effect immediately:
 * re-registering the provider refreshes the model metadata pi uses for
 * compaction, and the request builder reads the same settings per request.
 */

const DEFAULT_OUTPUT_TOKENS = 32768;
const CONTEXT_PRESETS = [200_000, 400_000, 1_000_000] as const;
const OUTPUT_PRESETS = [DEFAULT_OUTPUT_TOKENS, 65_536, MAX_OUTPUT_TOKENS_LIMIT] as const;
const STREAM_IDLE_PRESETS = [DEFAULT_STREAM_IDLE_TIMEOUT_MS, 60_000, 300_000] as const;
const STREAM_DELTA_PRESETS = [DELTA_FLUSH_INTERVAL_MS, 0, 100, 250] as const;

const REASONING_LABELS: Record<ReasoningReplay, string> = {
  none: "none — cheapest, drops prior thinking",
  last: "last — only the current tool round",
  all: "all — qodercli behavior, most Credits",
};

function contextLabel(settings: QoderSettings): string {
  if (settings.useMaxContext) return "largest catalog tier";
  if (settings.contextWindow === null || settings.contextWindow === undefined) return "catalog default";
  return `${settings.contextWindow} tokens`;
}

/** One-line summary used by the command, menus and `show`. */
export function describeQoderSettings(settings: QoderSettings): string {
  return [
    `Context window: ${contextLabel(settings)}`,
    `Max output tokens: ${settings.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS}`,
    `Replay prior reasoning: ${settings.replayReasoning ?? "none"}`,
    `Stream idle timeout: ${settings.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS} ms`,
    `Delta interval: ${settings.streamDeltaIntervalMs ?? DELTA_FLUSH_INTERVAL_MS} ms`,
    `Debug logging: ${settings.debug === true ? "on" : "off"}`,
    `Settings file: ${getQoderSettingsPath()}`,
  ].join("\n");
}

function positiveInteger(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text.trim());
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export interface SettingsArgumentResult {
  /** Full settings object to persist, or undefined when nothing should change. */
  settings?: QoderSettings;
  message: string;
  error?: boolean;
}

/**
 * Non-interactive form: `context 400000|default|max`, `output 65536|default`,
 * `reasoning none|last|all`, `show`, `reset`.
 */
export function applySettingsArguments(args: string, current: QoderSettings): SettingsArgumentResult {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { message: describeQoderSettings(current) };

  const [key, rawValue] = tokens;
  const value = rawValue?.toLowerCase();
  const next: QoderSettings = { ...current };

  if (key === "show") return { message: describeQoderSettings(current) };
  if (key === "reset") return { settings: {}, message: "Qoder settings reset to defaults." };

  if (key === "context") {
    if (value === "default") {
      return { settings: { ...next, contextWindow: null, useMaxContext: false }, message: "" };
    }
    if (value === "max") {
      return { settings: { ...next, contextWindow: null, useMaxContext: true }, message: "" };
    }
    const window = positiveInteger(rawValue);
    if (window === undefined) {
      return { error: true, message: "Usage: /qoder-settings context <tokens|default|max>" };
    }
    return { settings: { ...next, contextWindow: window, useMaxContext: false }, message: "" };
  }

  if (key === "output") {
    if (value === "default") {
      delete next.maxOutputTokens;
      return { settings: next, message: "" };
    }
    const output = positiveInteger(rawValue);
    if (output === undefined || output > MAX_OUTPUT_TOKENS_LIMIT) {
      return { error: true, message: `Usage: /qoder-settings output <1..${MAX_OUTPUT_TOKENS_LIMIT}|default>` };
    }
    return { settings: { ...next, maxOutputTokens: output }, message: "" };
  }

  if (key === "reasoning") {
    if (value !== "none" && value !== "last" && value !== "all") {
      return { error: true, message: "Usage: /qoder-settings reasoning <none|last|all>" };
    }
    return { settings: { ...next, replayReasoning: value }, message: "" };
  }

  if (key === "stream-idle") {
    if (value === "default") {
      delete next.streamIdleTimeoutMs;
      return { settings: next, message: "" };
    }
    const timeout = positiveInteger(rawValue);
    if (timeout === undefined || timeout > 3_600_000) {
      return { error: true, message: "Usage: /qoder-settings stream-idle <1000..3600000|default>" };
    }
    return { settings: { ...next, streamIdleTimeoutMs: timeout }, message: "" };
  }

  if (key === "stream-delta") {
    if (value === "default") {
      delete next.streamDeltaIntervalMs;
      return { settings: next, message: "" };
    }
    const interval = Number(rawValue?.trim());
    if (!Number.isInteger(interval) || interval < 0 || interval > 60_000) {
      return { error: true, message: "Usage: /qoder-settings stream-delta <0..60000|default>" };
    }
    return { settings: { ...next, streamDeltaIntervalMs: interval }, message: "" };
  }

  if (key === "debug") {
    if (value !== "on" && value !== "off") {
      return { error: true, message: "Usage: /qoder-settings debug <on|off>" };
    }
    return { settings: { ...next, debug: value === "on" }, message: "" };
  }

  return {
    error: true,
    message: [
      "Usage: /qoder-settings [show|reset]",
      "  context <tokens|default|max>   context window pi budgets for",
      "  output <tokens|default>        per-request max_tokens",
      "  reasoning <none|last|all>      replay of prior thinking",
      "  stream-idle <ms|default>       stream idle timeout",
      "  stream-delta <ms|default>      delta coalescing interval",
      "  debug <on|off>                 verbose diagnostics",
      "Without arguments the interactive menu opens.",
    ].join("\n"),
  };
}

function presetLabel(tokens: number, current: number | undefined): string {
  return `${tokens}${tokens === current ? " (current)" : ""}`;
}

/** Wire the `/qoder-settings` command into the host. */
export function registerQoderSettingsUi(pi: ExtensionAPI, apply: () => void): void {
  if (typeof pi.registerCommand !== "function") return;

  const persist = (settings: QoderSettings, ctx: ExtensionContext): void => {
    const saved = writeQoderSettings(settings);
    apply();
    ctx.ui.notify(`Qoder settings saved.\n${describeQoderSettings(saved)}`, "info");
  };

  async function editContext(ctx: ExtensionContext): Promise<void> {
    const current = readQoderSettings();
    const labels = [
      "Catalog default (recommended)",
      ...CONTEXT_PRESETS.map((tokens) => presetLabel(tokens, current.contextWindow ?? undefined)),
      "Custom…",
    ];
    const choice = await ctx.ui.select("Context window", labels);
    if (!choice) return;
    if (choice.startsWith("Catalog default")) {
      persist({ ...current, contextWindow: null, useMaxContext: false }, ctx);
      return;
    }
    if (choice === "Custom…") {
      const raw = await ctx.ui.input("Context window (tokens):", String(current.contextWindow ?? 200000));
      if (raw === undefined) return;
      const window = positiveInteger(raw);
      if (window === undefined) {
        ctx.ui.notify("Context window must be a positive integer.", "warning");
        return;
      }
      persist({ ...current, contextWindow: window, useMaxContext: false }, ctx);
      return;
    }
    const tokens = Number(choice.split(" ")[0]);
    if (!Number.isInteger(tokens) || tokens <= 0) return;
    persist({ ...current, contextWindow: tokens, useMaxContext: false }, ctx);
  }

  async function editOutput(ctx: ExtensionContext): Promise<void> {
    const current = readQoderSettings();
    const labels = [
      `${DEFAULT_OUTPUT_TOKENS} (official qodercli default)`,
      ...OUTPUT_PRESETS.filter((tokens) => tokens !== DEFAULT_OUTPUT_TOKENS).map((tokens) =>
        presetLabel(tokens, current.maxOutputTokens),
      ),
      "Custom…",
    ];
    const choice = await ctx.ui.select("Max output tokens", labels);
    if (!choice) return;
    if (choice === "Custom…") {
      const raw = await ctx.ui.input(`Max output tokens (1..${MAX_OUTPUT_TOKENS_LIMIT}):`, "32768");
      if (raw === undefined) return;
      const tokens = positiveInteger(raw);
      if (tokens === undefined || tokens > MAX_OUTPUT_TOKENS_LIMIT) {
        ctx.ui.notify(`Max output tokens must be an integer between 1 and ${MAX_OUTPUT_TOKENS_LIMIT}.`, "warning");
        return;
      }
      persist({ ...current, maxOutputTokens: tokens }, ctx);
      return;
    }
    const tokens = Number(choice.split(" ")[0]);
    if (!Number.isInteger(tokens) || tokens <= 0) return;
    persist({ ...current, maxOutputTokens: tokens }, ctx);
  }

  async function editReasoning(ctx: ExtensionContext): Promise<void> {
    const current = readQoderSettings();
    const choices = (Object.keys(REASONING_LABELS) as ReasoningReplay[]).map((mode) => REASONING_LABELS[mode]);
    const choice = await ctx.ui.select("Replay prior reasoning", choices);
    if (!choice) return;
    const mode = (Object.keys(REASONING_LABELS) as ReasoningReplay[]).find((key) => REASONING_LABELS[key] === choice);
    if (!mode) return;
    persist({ ...current, replayReasoning: mode }, ctx);
  }

  async function editStreamIdle(ctx: ExtensionContext): Promise<void> {
    const current = readQoderSettings();
    const labels = [
      ...STREAM_IDLE_PRESETS.map(
        (ms) => `${ms}${ms === (current.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS) ? " (current)" : ""}`,
      ),
      "Custom…",
    ];
    const choice = await ctx.ui.select("Stream idle timeout (ms)", labels);
    if (!choice) return;
    let timeout: number | undefined;
    if (choice === "Custom…") {
      timeout = positiveInteger(
        await ctx.ui.input("Stream idle timeout (ms, 1000..3600000):", String(DEFAULT_STREAM_IDLE_TIMEOUT_MS)),
      );
      if (timeout === undefined || timeout > 3_600_000) {
        ctx.ui.notify("Idle timeout must be an integer between 1000 and 3600000 ms.", "warning");
        return;
      }
    } else {
      timeout = Number(choice.split(" ")[0]);
    }
    if (timeout === undefined || !Number.isInteger(timeout) || timeout <= 0) return;
    persist({ ...current, streamIdleTimeoutMs: timeout }, ctx);
  }

  async function editStreamDelta(ctx: ExtensionContext): Promise<void> {
    const current = readQoderSettings();
    const labels = [
      ...STREAM_DELTA_PRESETS.map(
        (ms) => `${ms}${ms === (current.streamDeltaIntervalMs ?? DELTA_FLUSH_INTERVAL_MS) ? " (current)" : ""}`,
      ),
      "Custom…",
    ];
    const choice = await ctx.ui.select("Delta coalescing interval (ms)", labels);
    if (!choice) return;
    let interval: number | undefined;
    if (choice === "Custom…") {
      const raw = await ctx.ui.input(`Delta interval (ms, 0..60000):`, String(DELTA_FLUSH_INTERVAL_MS));
      if (raw === undefined) return;
      interval = Number(raw.trim());
      if (!Number.isInteger(interval) || interval < 0 || interval > 60_000) {
        ctx.ui.notify("Delta interval must be an integer between 0 and 60000 ms.", "warning");
        return;
      }
    } else {
      interval = Number(choice.split(" ")[0]);
    }
    if (interval === undefined || !Number.isInteger(interval) || interval < 0) return;
    persist({ ...current, streamDeltaIntervalMs: interval }, ctx);
  }

  async function editAdvanced(ctx: ExtensionContext): Promise<void> {
    for (;;) {
      const current = readQoderSettings();
      const choice = await ctx.ui.select("Qoder advanced options", [
        `Stream idle timeout: ${current.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS} ms`,
        `Delta interval: ${current.streamDeltaIntervalMs ?? DELTA_FLUSH_INTERVAL_MS} ms`,
        `Debug logging: ${current.debug === true ? "on" : "off"}`,
        "Back",
      ]);
      if (!choice || choice === "Back") return;
      if (choice.startsWith("Stream idle timeout")) await editStreamIdle(ctx);
      else if (choice.startsWith("Delta interval")) await editStreamDelta(ctx);
      else if (choice.startsWith("Debug logging"))
        persist({ ...readQoderSettings(), debug: current.debug !== true }, ctx);
    }
  }

  pi.registerCommand("qoder-settings", {
    description: "Qoder context window / max output / reasoning replay (controls Credits)",
    handler: async (args, ctx) => {
      const text = args.trim();
      if (text) {
        const result = applySettingsArguments(text, readQoderSettings());
        if (result.error || !result.settings) {
          ctx.ui.notify(result.message || "Qoder settings unchanged.", result.error ? "warning" : "info");
          return;
        }
        persist(result.settings, ctx);
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify(describeQoderSettings(readQoderSettings()), "info");
        return;
      }

      for (;;) {
        const current = readQoderSettings();
        const choice = await ctx.ui.select(`Qoder settings\n${describeQoderSettings(current)}`, [
          `Context window: ${contextLabel(current)}`,
          `Max output tokens: ${current.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS}`,
          `Replay prior reasoning: ${current.replayReasoning ?? "none"}`,
          "Advanced…",
          "Reset to defaults",
          "Done",
        ]);
        if (!choice || choice === "Done") return;
        if (choice.startsWith("Context window")) await editContext(ctx);
        else if (choice.startsWith("Max output tokens")) await editOutput(ctx);
        else if (choice.startsWith("Replay prior reasoning")) await editReasoning(ctx);
        else if (choice === "Advanced…") await editAdvanced(ctx);
        else if (choice === "Reset to defaults") persist({}, ctx);
      }
    },
  });
}
