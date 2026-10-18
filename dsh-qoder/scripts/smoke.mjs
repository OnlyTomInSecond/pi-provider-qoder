// Real-call smoke test: lists the live Qoder catalog and, with
// QODER_SMOKE_STREAM=1, streams one short answer through the adapter.
import { apply } from "../index.js";

let adapter;
apply({ llm: { registerAdapter(_providers, value) { adapter = value; return {}; } }, get() { return undefined; } }, {});
const models = await adapter.listModels("qoder");
console.log(`qoder: ${models.length} models, first: ${models.slice(0, 5).map((m) => m.id).join(", ")}`);
if (process.env.QODER_SMOKE_STREAM !== "1") process.exit(0);

let text = "";
for await (const chunk of adapter.stream({
  provider: "qoder",
  model: process.env.QODER_SMOKE_MODEL || "Qwen3.8-Flash",
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly QODER_DSH_OK" }] }],
  maxTokens: 64,
})) {
  if (chunk.type === "text-delta") text += chunk.text;
  if (chunk.type === "usage" || chunk.type === "finish") console.log(chunk.type, JSON.stringify(chunk));
}
console.log("text:", JSON.stringify(text));
