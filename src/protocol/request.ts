import type { ProviderHeaders } from "@earendil-works/pi-ai";

/** Case-insensitive merging; null suppresses a default header as in pi-ai. */
export function mergeQoderHeaders(...sources: Array<ProviderHeaders | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  const names = new Map<string, string>();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      const lower = name.toLowerCase();
      const existing = names.get(lower);
      if (existing) delete result[existing];
      if (value === null) {
        names.delete(lower);
      } else {
        // Keep conventional spelling for built-in headers, without duplicates.
        const key = existing ?? name;
        result[key] = value;
        names.set(lower, key);
      }
    }
  }
  return result;
}
