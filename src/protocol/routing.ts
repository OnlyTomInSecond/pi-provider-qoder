// shape: as-const object + derived union for the protocol constants (trigger #5,
//   fixed set of named constants); interface + validated loader for the routing
//   record (trigger #7, fixed-shape record); module-scope memo (trigger #3, one
//   instance per process).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPiAgentDir } from "../home.js";

export const PROTOCOL = { V2: "v2", LEGACY: "legacy" } as const;
export type Protocol = (typeof PROTOCOL)[keyof typeof PROTOCOL];

export interface RoutingData {
  version: number;
  v2Eligible: string[];
  legacyOnly: string[];
  rejectedSamplingKeys: string[];
}

// Seeded from the verified 2026-09-24 split (background §3). Only the v2
// allowlist is load-bearing under monthly catalog churn: new Qoder models
// launch legacy-only (Qwen3.8-Max, Kimi-K3, GLM-5.3-Flash are the newest, all
// legacy-only), so anything not proven v2-eligible routes legacy — the
// universal gateway that serves every key today. legacyOnly stays as
// observability data (known-legacy vs unknown-default in the decision log).
// Refreshed by package releases; corrected at runtime by the self-heal cache;
// overridable per-user at ~/.pi/agent/qoder-routing.json.
const DEFAULT_ROUTING: RoutingData = {
  version: 1,
  v2Eligible: ["auto", "ultimate", "performance", "efficient", "qmodel", "kmodel", "gmodel", "dmodel", "mmodel"],
  legacyOnly: ["dfmodel", "qmodel_38max", "qfmodel", "qmodel_latest", "kmodel_latest", "gfmodel"],
  rejectedSamplingKeys: ["presence_penalty", "frequency_penalty", "seed"],
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string");
}

export function isRoutingData(v: unknown): v is RoutingData {
  if (typeof v !== "object" || v === null) return false;
  if (!("version" in v) || typeof v.version !== "number") return false;
  if (!("v2Eligible" in v) || !isStringArray(v.v2Eligible)) return false;
  if (!("legacyOnly" in v) || !isStringArray(v.legacyOnly)) return false;
  if (!("rejectedSamplingKeys" in v) || !isStringArray(v.rejectedSamplingKeys)) return false;
  return true;
}

let memo: RoutingData | undefined;

// Session-local self-heal corrections: keys the v2 path proved legacy-only.
// Discarded at exit; the next session re-derives routing from the table plus
// fresh signals. Lives with the routing data because it corrects it.
const legacyOnlyCorrections = new Map<string, true>();

export function markLegacyOnly(upstreamKey: string): void {
  legacyOnlyCorrections.set(upstreamKey, true);
}

export function isMarkedLegacyOnly(upstreamKey: string): boolean {
  return legacyOnlyCorrections.has(upstreamKey);
}

/**
 * Routing table for protocol selection. A user override replaces the bundled
 * default wholesale; a malformed override is rejected loudly and the default
 * stands — a config typo must never brick the session (same rule as the F2
 * filter).
 */
export function getRoutingData(log?: (message: string) => void): RoutingData {
  if (memo) return memo;
  const overridePath = join(getPiAgentDir(), "qoder-routing.json");
  if (existsSync(overridePath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(overridePath, "utf8"));
      if (isRoutingData(raw)) {
        memo = raw;
        return memo;
      }
      log?.(`qoder-routing.json has an invalid shape; using the bundled routing table (${overridePath})`);
    } catch (error) {
      log?.(
        `qoder-routing.json could not be read (${error instanceof Error ? error.message : String(error)}); using the bundled routing table`,
      );
    }
  }
  memo = DEFAULT_ROUTING;
  return memo;
}

/** Test-only resetter, alongside the fork's existing resetter pattern. */
export function clearQoderRoutingMemCache(): void {
  memo = undefined;
}

/** Test-only resetter for the self-heal correction cache. */
export function clearQoderFallbackCache(): void {
  legacyOnlyCorrections.clear();
}
