import { yieldToEventLoop } from "../yield.js";

const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Byte table: standard base64 code point -> Qoder custom code point. Identity
// for anything outside the alphabet (so stray bytes pass through unchanged).
const encodeTable = new Uint8Array(256);

for (let i = 0; i < encodeTable.length; i++) {
  encodeTable[i] = i;
}

for (let i = 0; i < qoderStdAlphabet.length; i++) {
  encodeTable[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet.charCodeAt(i);
}

// Qoder uses "$" instead of standard Base64 "=" padding.
encodeTable["=".charCodeAt(0)] = "$".charCodeAt(0);

/** Qoder's gateway requires the full transformed body in one piece. */
export const QODER_ENCODE_CHUNK = 64 * 1024;

function toStdBase64(plaintext: string | Buffer): string {
  return Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
}

/**
 * Translate Qoder's block-reordered base64 into `out` (the output Buffer) one
 * source position at a time.
 *
 * Standard base64 of length n is reordered into three blocks:
 *   std[n-a .. n-1] + std[a .. n-a-1] + std[0 .. a-1]      (a = floor(n/3))
 * For an output slot `dst`, the source slot is:
 *   src = dst < a                ? n - a + dst   // tail moved to front
 *       : dst < n - a            ? dst           // middle stays put
 *       :                          dst - (n - a) // head moved to back
 */
function encodeChunkInto(out: Buffer, std: string, start: number, end: number): void {
  const n = std.length;
  const a = Math.floor(n / 3);
  for (let dst = start; dst < end; dst++) {
    let src: number;
    if (dst < a) src = n - a + dst;
    else if (dst < n - a) src = dst;
    else src = dst - (n - a);
    out[dst] = encodeTable[std.charCodeAt(src)];
  }
}

/**
 * Encode a request body with Qoder's custom Base64 alphabet and block reorder.
 * Returns a Buffer of ASCII bytes. Uses a single preallocated buffer and no
 * intermediate strings, so allocation stays constant regardless of body size.
 */
export function qoderEncodeBody(plaintext: string | Buffer): Buffer {
  const std = toStdBase64(plaintext);
  const out = Buffer.allocUnsafe(std.length);
  encodeChunkInto(out, std, 0, out.length);
  return out;
}

/**
 * Async equivalent of {@link qoderEncodeBody}. Same output (a Buffer of ASCII
 * bytes), but it yields to the event loop between {@link QODER_ENCODE_CHUNK}
 * byte chunks so a very large request body does not monopolize Node's event
 * loop. Returns the identical bytes as {@link qoderEncodeBody}.
 */
export async function qoderEncodeBodyAsync(plaintext: string | Buffer): Promise<Buffer> {
  const std = toStdBase64(plaintext);
  const out = Buffer.allocUnsafe(std.length);
  for (let start = 0; start < out.length; start += QODER_ENCODE_CHUNK) {
    const end = Math.min(start + QODER_ENCODE_CHUNK, out.length);
    encodeChunkInto(out, std, start, end);
    if (end < out.length) await yieldToEventLoop();
  }
  return out;
}
