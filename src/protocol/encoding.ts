const qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const qoderStdAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const qoderCustomByCode = new Array<string | undefined>(128);
for (let i = 0; i < qoderStdAlphabet.length; i++) {
  qoderCustomByCode[qoderStdAlphabet.charCodeAt(i)] = qoderCustomAlphabet[i];
}

function getBase64Text(plaintext: string | Buffer): string {
  return Buffer.isBuffer(plaintext) ? plaintext.toString("base64") : Buffer.from(plaintext).toString("base64");
}

function encodeRange(rearranged: string, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    const c = rearranged[i];
    if (c === "=") {
      out += "$";
    } else {
      out += qoderCustomByCode[c.charCodeAt(0)] ?? c;
    }
  }
  return out;
}

function rearrangeBase64(std: string): string {
  const n = std.length;
  const a = Math.floor(n / 3);
  return std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
}

export function qoderEncodeBody(plaintext: string | Buffer): string {
  const rearranged = rearrangeBase64(getBase64Text(plaintext));
  return encodeRange(rearranged, 0, rearranged.length);
}

/**
 * Encode large request bodies without monopolizing Node's event loop.
 * Qoder's gateway requires the complete transformed body, so this preserves
 * the same output as qoderEncodeBody while yielding between chunks.
 */
export async function qoderEncodeBodyAsync(plaintext: string | Buffer): Promise<string> {
  const rearranged = rearrangeBase64(getBase64Text(plaintext));
  const chunkSize = 64 * 1024;
  const chunks: string[] = [];
  for (let start = 0; start < rearranged.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, rearranged.length);
    chunks.push(encodeRange(rearranged, start, end));
    if (end < rearranged.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return chunks.join("");
}
