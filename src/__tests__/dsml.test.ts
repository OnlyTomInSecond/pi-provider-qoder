import { describe, expect, it } from "vitest";
import { DsmlToolCallParser, MAX_DSML_BUFFER_LENGTH } from "../protocol/dsml.js";

const START = "<｜DSML｜tool_calls>";
const END = "</｜DSML｜tool_calls>";
const INVOKE = "<｜DSML｜invoke";
const INVOKE_END = "</｜DSML｜invoke>";
const PARAMETER = "<｜DSML｜parameter";
const PARAMETER_END = "</｜DSML｜parameter>";

function parameter(name: string, value: string, stringType: boolean): string {
  return `${PARAMETER} name="${name}" string="${stringType ? "true" : "false"}">${value}${PARAMETER_END}`;
}

describe("DsmlToolCallParser", () => {
  it("parses a tool call when every DSML boundary is split across chunks", () => {
    const input =
      `${START}\n${INVOKE} name="bash">\n` +
      parameter("command", "ls -la", true) +
      "\n" +
      parameter("timeout", "10", false) +
      `\n${INVOKE_END}\n${END}`;
    const parser = new DsmlToolCallParser();
    const events = [];
    for (const character of input) events.push(...parser.processChunk(character));
    events.push(...parser.finalize());

    expect(events).toEqual([
      { type: "tool_start", id: "dsml_call_0", name: "bash" },
      { type: "tool_arguments", id: "dsml_call_0", arguments: '{"command":"ls -la","timeout":10}' },
    ]);
  });

  it("keeps ordinary text and parses multiple function calls", () => {
    const input =
      `before ${START}\n` +
      `${INVOKE} name="read">${parameter("path", "/tmp/a", true)}${INVOKE_END}\n` +
      `${INVOKE} name="search">${parameter("limit", "3", false)}${INVOKE_END}\n` +
      `${END} after`;
    const parser = new DsmlToolCallParser();
    const events = parser.processChunk(input);
    events.push(...parser.finalize());

    expect(events).toEqual([
      { type: "text", text: "before " },
      { type: "tool_start", id: "dsml_call_0", name: "read" },
      { type: "tool_arguments", id: "dsml_call_0", arguments: '{"path":"/tmp/a"}' },
      { type: "tool_start", id: "dsml_call_1", name: "search" },
      { type: "tool_arguments", id: "dsml_call_1", arguments: '{"limit":3}' },
      { type: "text", text: " after" },
    ]);
  });

  it("accepts function_calls/function aliases and JSON parameter values", () => {
    const input =
      `<｜DSML｜function_calls>\n<｜DSML｜function name="configure">\n` +
      `${PARAMETER} name="enabled" string="false">true${PARAMETER_END}\n` +
      `${PARAMETER} name="options" string="false">{"mode":"fast"}${PARAMETER_END}\n` +
      "</｜DSML｜function>\n</｜DSML｜function_calls>";
    const parser = new DsmlToolCallParser();
    const events = [...parser.processChunk(input), ...parser.finalize()];

    expect(events).toEqual([
      { type: "tool_start", id: "dsml_call_0", name: "configure" },
      { type: "tool_arguments", id: "dsml_call_0", arguments: '{"enabled":true,"options":{"mode":"fast"}}' },
    ]);
  });

  it("rejects an unbounded incomplete DSML call", () => {
    const parser = new DsmlToolCallParser();
    expect(() => parser.processChunk(`${START}${"x".repeat(MAX_DSML_BUFFER_LENGTH)}`)).toThrow(/DSML buffer exceeded/);
  });

  it("falls back to the original text for an incomplete or malformed wrapper", () => {
    const input = `answer <｜DSML｜tool_calls>not-an-invoke`;
    const parser = new DsmlToolCallParser();
    const events = [...parser.processChunk(input), ...parser.finalize()];

    expect(events.every((event) => event.type === "text")).toBe(true);
    expect(events.map((event) => (event.type === "text" ? event.text : "")).join("")).toBe(input);
  });
});
