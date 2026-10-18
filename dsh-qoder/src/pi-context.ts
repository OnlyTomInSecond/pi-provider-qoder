/**
 * Translation from the harness request vocabulary to the pi-ai transcript
 * shape the ported Qoder protocol already understands.
 *
 * Only the fields `buildQoderChatRequest` reads are materialized: a leading
 * system message carrying the prompt and tool declarations, then user,
 * assistant, and tool-result turns. DSH developer tool updates are dropped
 * because `options.tools` always carries the complete active set.
 */
import type {
  ImageContent,
  JsonObject,
  Message as PiMessage,
  TextContent,
  ThinkingContent,
  Tool as PiTool,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";

export interface DshContentBlock {
  type: string;
  text?: string;
  attachment?: { attachmentId: string; mediaType?: string; width?: number; height?: number; bytes?: number; name?: string };
  id?: string;
  name?: string;
  arguments?: string;
  toolName?: string;
}

export interface DshMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: readonly DshContentBlock[];
  toolCallId?: string;
  isError?: boolean;
}

export interface DshTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface DshGenerateOptions {
  provider: string;
  model: string;
  messages: readonly DshMessage[];
  system?: string;
  tools?: readonly DshTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  sessionId?: string;
  reasoningEffort?: string;
}

export interface AttachmentBridge {
  readImageRequest(
    ref: { attachmentId: string; mediaType: string; width: number; height: number; bytes: number },
    target: { width: number; height: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; mediaType: string }>;
}

export interface HostBridge {
  attachments?: AttachmentBridge;
}

type PreparedImage = { data: string; mimeType: string };

function blockText(blocks: readonly DshContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
        case "reasoning":
          return block.text ?? "";
        case "file": {
          const name = block.attachment?.name ?? "file";
          const bytes = block.attachment?.bytes;
          return `[File ${JSON.stringify(name)}${typeof bytes === "number" ? ` (${bytes} bytes)` : ""}; its contents are available through the file tools when needed.]`;
        }
        default:
          return "";
      }
    })
    .join("");
}

function hasImage(blocks: readonly DshContentBlock[]): boolean {
  return blocks.some((block) => block.type === "image");
}

function imagePart(block: DshContentBlock, images: ReadonlyMap<string, PreparedImage>): ImageContent | undefined {
  const id = block.attachment?.attachmentId;
  if (!id) return undefined;
  const image = images.get(id);
  if (!image) return undefined;
  return { type: "image", data: image.data, mimeType: image.mimeType };
}

function userContent(
  blocks: readonly DshContentBlock[],
  images: ReadonlyMap<string, PreparedImage>,
): string | (TextContent | ImageContent)[] {
  if (!hasImage(blocks)) return blockText(blocks);
  const parts: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "text" || block.type === "reasoning") {
      if (block.text) parts.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const part = imagePart(block, images);
      if (part) parts.push(part);
      else parts.push({ type: "text", text: `[image ${block.attachment?.attachmentId ?? "unknown"} omitted: bytes unavailable]` });
    } else if (block.type === "file") {
      const text = blockText([block]);
      if (text) parts.push({ type: "text", text });
    }
  }
  if (parts.length === 0) return "";
  return parts;
}

function parseArguments(raw: string | undefined): JsonObject {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
  } catch {
    return {};
  }
}

function assistantContent(
  blocks: readonly DshContentBlock[],
): (TextContent | ThinkingContent | ToolCall)[] {
  const content: (TextContent | ThinkingContent | ToolCall)[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block.type === "reasoning") {
      if (block.text) content.push({ type: "thinking", thinking: block.text });
    } else if (block.type === "tool-call") {
      content.push({
        type: "toolCall",
        id: block.id || `call_${content.length}`,
        name: block.name || "tool",
        arguments: parseArguments(block.arguments),
      });
    }
  }
  return content;
}

function toolResultContent(
  blocks: readonly DshContentBlock[],
  images: ReadonlyMap<string, PreparedImage>,
): (TextContent | ImageContent)[] {
  const content: (TextContent | ImageContent)[] = [];
  for (const block of blocks) {
    if (block.type === "text" || block.type === "reasoning") {
      if (block.text) content.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      const part = imagePart(block, images);
      if (part) content.push(part);
    } else if (block.type === "file") {
      const text = blockText([block]);
      if (text) content.push({ type: "text", text });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "(no output)" });
  return content;
}

/** Read every image reference in the request once, in stable order. */
export async function prepareImages(
  options: DshGenerateOptions,
  host: HostBridge,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, PreparedImage>> {
  const attachments = host.attachments;
  const result = new Map<string, PreparedImage>();
  if (!attachments) return result;
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== "image") continue;
      const ref = block.attachment;
      if (!ref?.attachmentId || result.has(ref.attachmentId)) continue;
      try {
        const image = await attachments.readImageRequest(
          {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType || "image/png",
            width: ref.width || 1,
            height: ref.height || 1,
            bytes: ref.bytes || 0,
          },
          { width: ref.width || 2048, height: ref.height || 2048, maxBytes: ref.bytes || 4 * 1024 * 1024 },
          signal,
        );
        result.set(ref.attachmentId, {
          data: Buffer.from(image.data).toString("base64"),
          mimeType: image.mediaType,
        });
      } catch {
        // The text placeholder in the projection keeps the request valid.
      }
    }
  }
  return result;
}

function toPiTools(tools: readonly DshTool[] | undefined): PiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Build a pi transcript context from one harness request.
 * @param options - the fully assembled harness request.
 * @param images - prepared inline image bytes keyed by attachment id.
 * @param provider - pi provider id (`qoder` / `qoder-cn`).
 * @param model - exact Qoder model id.
 * @returns a pi transcript context for the ported Qoder request builder.
 */
export function buildPiContext(
  options: DshGenerateOptions,
  images: ReadonlyMap<string, PreparedImage>,
  provider: string,
  model: string,
): TranscriptContext {
  const systemParts: string[] = [];
  if (options.system) systemParts.push(options.system);
  const messages: PiMessage[] = [];
  const toolNames = new Map<string, string>();

  for (const message of options.messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = blockText(message.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }
    if (message.role === "user") {
      messages.push({ role: "user", content: userContent(message.content, images), timestamp: Date.now() });
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool-call" && block.id) toolNames.set(block.id, block.name || "tool");
      }
      messages.push({
        role: "assistant",
        content: assistantContent(message.content),
        api: "qoder-api",
        provider,
        model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "tool") {
      const callId = message.toolCallId || "call_unknown";
      messages.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: toolNames.get(callId) || "tool",
        content: toolResultContent(message.content, images),
        isError: message.isError === true,
        timestamp: Date.now(),
      });
    }
  }

  // Qoder reads the system prompt and tool declarations from the transcript's
  // leading system message. One message carries both so a later tool list
  // update cannot be mistaken for a second prompt.
  const system: PiMessage = {
    role: "system",
    content: systemParts.join("\n\n"),
    timestamp: Date.now(),
    ...(toPiTools(options.tools) === undefined ? {} : { toolsAdded: toPiTools(options.tools) }),
  };
  messages.unshift(system);
  return { messages } as TranscriptContext;
}
