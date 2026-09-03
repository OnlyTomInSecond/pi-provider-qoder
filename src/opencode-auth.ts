import { getQoderRegionConfig, type QoderMode } from "./region.js";

/** The small subset of OpenCode's stable plugin API used by this package. */
type QoderAuthInfo =
  | { type: "api"; key: string; metadata?: Record<string, string> }
  | { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown }
  | undefined;

type QoderAuthHook = {
  provider: string;
  loader: (getAuth: () => Promise<QoderAuthInfo>) => Promise<Record<string, unknown>>;
  methods: Array<{
    type: "api";
    label: string;
  }>;
};

export type QoderOpenCodePlugin = (
  input: unknown,
  options?: Record<string, unknown>,
) => Promise<{ auth: QoderAuthHook }>;

function modeFromOptions(options: Record<string, unknown> | undefined): QoderMode {
  return options?.region === "cn" || options?.mode === "cn" ? "cn" : "global";
}

/**
 * Build the stable OpenCode auth hook for one Qoder region.
 *
 * OpenCode owns the secret prompt and persists the resulting API credential in
 * its global auth store. The native provider receives the same value through
 * settings.apiKey. Keeping the PAT here (instead of exchanging it during the
 * prompt) means the provider can refresh a short-lived job token on demand.
 */
export function createQoderAuthHooks(mode: QoderMode): { auth: QoderAuthHook } {
  const region = getQoderRegionConfig(mode);
  const label = mode === "cn" ? "Qoder CN Personal Access Token" : "Qoder Personal Access Token";

  return {
    auth: {
      provider: region.providerID,
      methods: [{ type: "api", label }],
      loader: async (getAuth) => {
        const auth = await getAuth();
        if (auth?.type !== "api" || !auth.key.trim()) return {};
        return { apiKey: auth.key.trim() };
      },
    },
  };
}

/**
 * Stable OpenCode plugin entrypoint.
 *
 * The optional plugin options allow one entrypoint to be used for both
 * `qoder` and `qoder-cn`:
 *   [".../opencode-auth.js", { "region": "cn" }]
 */
const qoderOpenCodePlugin: QoderOpenCodePlugin = async (_input, options) =>
  createQoderAuthHooks(modeFromOptions(options));

export default qoderOpenCodePlugin;
