# pi-provider-qoder

A [pi](https://shittycodingagent.ai/) extension that connects pi to [Qoder](https://qoder.com/). It emulates the official `qodercli` (and its China variant) protocol end-to-end: OAuth device login / PAT exchange, COSY request signing, the live model catalog, and the streaming chat gateway — no standalone CLI binary required.

```bash
pi install npm:pi-provider-qoder
# or: omp install npm:pi-provider-qoder
```

## Quick start

From the command line:

```bash
pi --provider qoder --model Lite
pi --provider qoder-cn --model Qwen3.7-Plus
```

Inside pi:

```text
/login qoder
/model Qwen3.8-Max
```

## Features

- **Two regions registered together** — `qoder` (global) and `qoder-cn` (China) in a single extension.
- **Two auth flows** — paste a PAT, or (global only) sign in through the browser device flow.
- **Startup auto-login** — a PAT found in the environment logs the provider in at startup, before the first request.
- **Live model catalog** — fetched from the authenticated Qoder `/model/list` endpoint and cached per region.
- **Effort-aware thinking** — pi's thinking levels are mapped onto each model's `enable_thinking` / `reasoning_effort` support.
- **Agentic tool use** — native tool calls, plus DSML markup embedded in the text stream, parsed into clean `toolCall` blocks.
- **Robust streaming** — handles Qoder's double-`[DONE]` SSE envelope, hidden `<thinking>` markup, idle timeouts with one transparent continuation from the partial assistant output, and orphaned/compacted tool history.
- **Usage reporting (host-dependent)** — exposes a `fetchUsage` OAuth hook that reads Qoder's Credits quota (user quota + org resource package). Hosts that consume the hook (OMP-style) can surface it; stock pi has no usage hook, so nothing extra is shown there.
- **WAF bypass / COSY signatures** — every request is signed with the same RSA/AES machine-bound headers Qoder expects.

## Providers

Both providers register together; each is a separate region with its own account, catalog, and cache.

| | `qoder` (global) | `qoder-cn` (China) |
| --- | --- | --- |
| Chat gateway | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |
| Login | `/login qoder` — browser OAuth **or** PAT | `/login qoder-cn` — PAT only |
| PAT page | https://qoder.com/account/integrations | https://qoder.com.cn/account/integrations |
| Account page | https://qoder.com | https://qoder.com.cn |
| Env PAT (first match) | `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` |
| Supports browser login | ✅ | ❌ |

## Authentication

Qoder PATs (`pt-...`) cannot authenticate API calls directly. Every flow ultimately exchanges one for a short-lived **job token** (`jt-...`), optionally alongside a job refresh token (`jrt-...`):

1. **Paste a PAT** — both regions prompt for a PAT and exchange it for a job token.
2. **Browser OAuth (global only)** — leave the PAT prompt empty and pi opens a Qoder sign-in URL; the plugin polls until you approve. This flow is a PKCE device grant.
3. **Environment variable** — set one of the PAT env vars above and the provider logs in automatically at startup. An explicit env PAT is authoritative and is re-exchanged on every startup (so an old cached token never silently shadows a new one).

A job token is short-lived; when it nears expiry the provider transparently refreshes it — by re-exchanging the stored PAT, or by using the job refresh token. Global browser and CN logins both persist credentials through pi. Refresh failures are reported rather than extending an invalid token's local expiry; HTTP 401/403 asks you to log in again.

Authentication, catalog and quota requests have a 15-second deadline covering headers and body. Browser login has a three-minute overall deadline. Login/refresh and chat identity resolution honor cancellation; chat also honors the host's optional `timeoutMs` in addition to the stream idle timeout.

### Credential storage

Credentials are managed by the host (pi uses `~/.pi/agent/`, or `PI_CODING_AGENT_DIR`; OMP uses its own store). Identity lookups are cached only in memory and never overwrite credentials:

- `auth.json` — the exchanged credentials (per provider), plus the resolved user identity (`userID`/`email`/`name`/`machineID`).
- The machine id used for COSY headers is read from `~/.qoder/.auth/machine_id` or, if absent, `~/.pi/agent/qoder-machine-id` (created if missing).

Qoder credits are billed per account; only the region you log into is affected.

## Models

After login, `/model` (or `pi --list-models`) lists what that region offers.

**Catalog source.** At startup and on each new session the provider checks its model cache. If it is missing, older than one hour, or was fetched for a different account it re-fetches the authenticated region catalog from `/model/list` and writes a fresh copy to:

- `~/.pi/agent/qoder-models-cache.json` (global)
- `~/.pi/agent/qoder-cn-models-cache.json` (China)

**Fallback catalog.** When the live catalog is unavailable, an explicit static catalog is used so models work offline. IDs in the fallback are also used as seeds until a live catalog arrives.

**Model ids.** The pi-visible id is the server `display_name` with all whitespace stripped (e.g. `Qwen3.8-Max`, `Qwen3.7Plus`). A hidden `upstreamKey` (`lite`, `qmodel`, `qmodel_latest`, `dmodel`, …) is kept internally and sent to the gateway on each request.

**Context & output.**

- Context window: taken from the **largest** context option the catalog advertises (e.g. 1M when 200K/400K/1M are offered). When the catalog omits context options, a 1M fallback is used for most models; a few models are pinned lower to what they actually advertise (e.g. Kimi 256K, and several CN models 200K).
- Output: capped at 128K tokens (`max_tokens` 131072), which can be lowered per-request by pi (e.g. compaction).
- Cost: Qoder bills in Credits, not USD, so pi's monetary `cost` is left at zero. The relative Credit multiplier (`price_factor`) is exposed as `priceFactor` metadata on each model when the live catalog reports it (it is not appended to the picker label, so `/model` never repeats the model name), and the official per-request `credits` / `original_credits` / `billable` fields are preserved on the runtime usage object when Qoder reports them.

### Thinking & effort

Models flagged as reasoning expose pi's thinking level picker (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, plus `off`). How they behave depends on what the catalog advertises:

- **Effort-based** models (`thinking_config.enabled.efforts`) map pi levels to Qoder's `reasoning_effort` (`low`/`medium`/`xhigh`/`max`, …); unsupported levels are hidden from the picker.
- **Toggle-based** models (thinking on/off only) treat any level as "on" and only send `enable_thinking`.
- Disabling thinking sends `enable_thinking: false` so non-reasoning models don't reason by default.

The streamed response is normalized into pi thinking blocks regardless of how the server delivers it — a dedicated `reasoning_content` channel or inline `<thinking>` / `<think>` / `<reasoning>` / `<summary>` tags split across chunks.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `QODER_API_KEY`, `QODER_PERSONAL_ACCESS_TOKEN`, `QODER_PAT` | Global PAT (first non-empty wins). |
| `QODERCN_API_KEY`, `QODERCN_PERSONAL_ACCESS_TOKEN`, `QODERCN_PAT` | China PAT (first non-empty wins). |
| `QODER_STREAM_IDLE_TIMEOUT_MS` | Stream idle timeout override (default `120000` ms). |
| `QODER_STREAM_DELTA_INTERVAL_MS` | Minimum gap between streamed text/thinking deltas (default `50` ms). Higher values cut UI CPU on long responses. |
| `QODER_DEBUG` | When set, log diagnostics for best-effort failures (catalog refresh, PAT exchange fallthrough, userinfo lookup). Malformed SSE and token refresh failures are always surfaced as errors. |

## How it works (protocol notes)

- **Request signing.** The provider rebuilds Qoder's COSY authorization: an AES-encrypted user blob + RSA-wrapped key, an MD5 signature over path/body, and machine-bound `Cosy-*` headers (client type, OS, machine id/token). This is what lets it talk to the gateway directly.
- **SSE gateway.** Chat streams from the Qoder `/algo/.../agent_chat_generation` endpoint. Qoder wraps events in an outer envelope with a JSON-string `body`, and can send the `[DONE]` sentinel both bare and wrapped — both are handled, plus a body that stays open after the sentinel.
- **Agentic "runs".** Qoder groups billing/records per agentic run. The provider infers run boundaries from the message tail and reuses a run-scoped `request_set_id` + `business` (stable id/name, advancing `init` → `start` → `processing`) across tool rounds, so the credit ledger shows one aggregated entry per user prompt instead of many tiny ones.
- **Tool calls.** Native structured `tool_calls` and DSML tool markup embedded in the text stream are both parsed into pi tool calls. Images returned by tools (e.g. screenshots, `read`) are forwarded to the model as data-URL image parts.
- **Prompt cache.** A stable session id derived from your user id + model keeps prompt-cache affinity across consecutive requests in a session.
- **History repair.** Before sending, orphaned tool results, dropped (error/aborted) assistant turns, and placeholderless tool-call messages are repaired so Qoder never rejects a request with "tool must follow a message with tool_calls".
- **Timeout continuation.** If Qoder's stream/request deadline fires after reasoning or text has arrived, the provider transparently makes one `is_retry` request with the partial assistant turn plus a no-repeat continuation instruction. It reuses the same `session_id`, `request_set_id`, and `business`; user cancellation and incomplete tool calls are never replayed automatically.

## Host request compatibility

The custom stream supports pi's `onPayload` (before encoding/signing), `onResponse` (before reading the body, including HTTP errors), injected `fetch` (chat and identity lookup), `headers`, `env`, `timeoutMs`, `temperature`, and model/request `maxTokens`. Header overrides are case-insensitive; `null` removes a default. Overriding COSY authentication headers can invalidate signatures. A model `baseUrl` override must point to a Qoder-compatible gateway, not a generic OpenAI endpoint.

pi 1.4's `identity` request option is intentionally not applied to Qoder chat requests. The gateway is not an attribution target, and Qoder's identity is carried by the COSY headers, so the host's `User-Agent` never changes a signature. Explicit `User-Agent` headers from a model or request still win.

Chat POST requests are not automatically retried, even when `maxRetries` is supplied: replaying a generation may duplicate billing. The host can decide when to retry. Transport remains SSE.

## Usage reporting

The provider attaches a `fetchUsage` hook to its OAuth config. It hits
`GET /api/v2/quota/usage` and returns:

- **User Quota** — used / total / remaining in Qoder Credits and the reset time.
- **Org Resource Package** — same shape, shown when present.
- A link to the account page to buy more Credits.

This hook is host-dependent: stock pi does not read it (no `fetchUsage`
reference exists in pi-coding-agent 0.75.5 through 1.4.0), so pi shows no Qoder
quota. Only hosts that opt into a usage hook (OMP-style) display it.

## Compatibility

Developed and tested against pi / pi-ai 1.4.0. Host packages stay declared as
`*` peer dependencies so older releases (0.75.5+) continue to load; when a host
lacks an optional hook or the temporary `@earendil-works/pi-ai/compat` entry
point, the plugin degrades instead of failing to load.

## Development

```bash
npm install
npm run build      # bundle the extension into dist/
npm test           # run the offline unit suite (replays recorded fixtures)
npm run test:live  # re-record live protocol fixtures (needs QODER_PAT / QODERCN_PAT)
```

See [`src/__fixtures__/live/README.md`](src/__fixtures__/live/README.md) for the fixture format and how to re-record it.

## Request and account Credits

The footer shows **actual session deductions in Credits**, accumulated from Qoder's
request-level `usage.credits` and `usage.billable` response fields. Tokens are shown
separately and are not used to estimate Credits. A non-billable request contributes zero
to actual deductions even when its reported nominal Credits are positive. Missing
billing metadata is counted as `unknown`, so an incomplete session total is visible.
Global and CN session totals are separate and are rebuilt from stored session entries,
including attributed compaction, summary and tool usage entries.

Account quota is an **account-wide period balance**, including other Qoder clients.
Personal, add-on and organization quota are displayed separately. Account balances may
be rounded or updated later; they do not determine per-request cost.

Assistant `usage` preserves Qoder's `credits`, `original_credits`, and `billable`, and
adds `qoder_provider`, `charged_credits`, and `usd_equivalent`. `charged_credits` is zero
for non-billable calls, or the returned discounted Credits for billable calls; it remains
absent when actual deductions cannot be determined. `usd_equivalent` is a reference
conversion at **$20 / 1,500 Credits**, not a dollar charge. Credits never enter pi's
dollar-denominated `usage.cost` fields. See the [Qoder usage field definitions](https://docs.qoder.com/cli/sdk/cost-usage).

For example, a CN response with `credits: 0.000613272` and `billable: true` contributes
`0.000613272` Credits, while a Global response with `credits: 0.005221428571428571` and
`billable: false` contributes zero. The UI keeps up to eight decimal places; serialized
usage preserves the full returned precision.

A compact **session-Credits** status is shown for the selected Qoder provider. Account-period
quota is account-wide (it includes other Qoder clients), so it is never published to the
always-on bottom bar; `/qoder-usage` shows the session deductions and the account quota.
For a full credit footer, opt in for the current pi session:

```text
/qoder-usage footer on
/qoder-usage
/qoder-usage footer off
```

Or start pi with `--qoder-credit-footer`. The custom footer replaces the misleading
`$0.000 (sub)` with labelled session Credits and account-quota rows. Input/output,
cache totals/hit rate, context, model/thinking level, directory, branch, session name,
and other extension statuses remain visible. Existing nonzero dollar charges in mixed
sessions are retained as `session $…` and are not relabelled as Qoder credits.
Narrow terminals wrap quota and put the model on its own line.

pi exposes one custom-footer slot. Enabling this option replaces another custom footer;
leave it off when using a separate footer extension. If another extension takes the slot
later, Qoder stops trying to reclaim it. Disabling restores pi's built-in footer only
while Qoder still owns the slot. The public API does not expose the current auto-compaction
setting, so the custom footer does not add the built-in `(auto)` hint. Alternate hosts without
pi's TUI footer API keep the status/command where supported.

Quota refreshes asynchronously at session start, model selection, before a new agent run,
and after an agent run. The in-memory cache lasts 30 seconds and coalesces simultaneous
requests; agent completion and `/qoder-usage` force a refresh. A local timer marks expired snapshots `[stale]`
without polling. Missing data shows `?`/unavailable, not zero; failed refreshes retain only
the last snapshot for the same account. Personal, add-on and organization quota are separate,
with the API's own units. The command also shows the allowance and expiry when provided.
Credential lookup and quota requests are each bounded to 10 seconds.

There is no dedicated host login/logout event. After changing authentication for an
already-selected model, run `/qoder-usage`; otherwise the next supported lifecycle event
rechecks identity. No account quota is written to disk. Per-request Credits are stored
with the assistant usage in the host's session log.

### Offline visual preview

```bash
npm ci
npm run demo:credits
```

The demo runs the same footer renderer inside pi-tui with **sample data only**. It makes
no account or model requests. Press `f` (fresh), `s` (stale), `u` (unavailable), `0` (zero
quota), or `q` (quit). It shows both standard and 54-column layouts. Global and CN
quota queries and request-level billing fields have been verified with live calls.

Sanitized billing samples in `src/__fixtures__/billing/usage.json` cover free Global
calls, paid Global/CN calls, and two Kimi-K3 calls totaling 1.03185159 Credits.
Session accounting regression tests use these samples without making live requests.

## License

MIT
