/**
 * Escape-only repair for finished tool-call arguments.
 *
 * Models (notably DeepSeek writing kernel/C sources) sometimes emit string
 * literals whose bytes are not legal JSON: raw newlines/tabs copied out of the
 * file they are editing, or backslash sequences that are not a valid JSON
 * escape (`\d`, `\u12`, a trailing `\`). `JSON.parse` rejects the whole call,
 * which used to abort the turn even though the arguments are complete.
 *
 * The repair only re-escapes bytes *inside* string literals, so the decoded
 * value is byte-for-byte what the model meant. It never completes, truncates,
 * or otherwise guesses structure: a call cut off by the output limit stays
 * broken, which is what the caller's strict rejection relies on.
 */
const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b":
      return "\\b";
    case "\f":
      return "\\f";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default:
      return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

/**
 * Re-escape illegal bytes inside JSON string literals: raw control characters
 * become their `\n`/`\t`/`\u00xx` forms, and backslashes that do not start a
 * valid escape are doubled so they decode as literal backslashes.
 *
 * Returns the input unchanged when nothing needed repairing, so callers can
 * skip a second parse attempt.
 */
export function repairJsonEscapes(value: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = value[index + 1];
      // A backslash at the very end cannot escape anything: it must be a
      // literal backslash from a truncated or sloppily escaped string.
      if (nextChar === undefined) {
        repaired += "\\\\";
        continue;
      }
      if (nextChar === "u") {
        const unicodeDigits = value.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      // Illegal escape (`\d`, `\q`, short `\u`): the model meant a literal
      // backslash followed by that character.
      repaired += "\\\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}
