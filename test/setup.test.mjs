import { describe, expect, it } from "vitest";
import {
  findWorkersDevUrl,
  normalizeBaseUrl,
  normalizeToolSelection,
  parseSetupOptions,
} from "../scripts/lib.mjs";

describe("setup helpers", () => {
  it("accepts root and MCP URLs and returns the Worker origin", () => {
    expect(normalizeBaseUrl("https://example.workers.dev")).toBe(
      "https://example.workers.dev",
    );
    expect(normalizeBaseUrl("https://example.workers.dev/mcp")).toBe(
      "https://example.workers.dev",
    );
  });

  it("rejects insecure remote URLs", () => {
    expect(() => normalizeBaseUrl("http://example.com/mcp")).toThrow(
      "必须使用 HTTPS",
    );
  });

  it("extracts the deployed workers.dev URL", () => {
    const output = `
Deployed gemini-github-mcp-proxy triggers
  https://gemini-github-mcp-proxy.friend.workers.dev
`;
    expect(findWorkersDevUrl(output)).toBe(
      "https://gemini-github-mcp-proxy.friend.workers.dev",
    );
  });

  it("defaults to the full upstream tool surface", () => {
    expect(normalizeToolSelection(undefined)).toBeNull();
    expect(normalizeToolSelection("")).toBeNull();
    expect(normalizeToolSelection("all")).toBeNull();
  });

  it("accepts an explicit tool selection", () => {
    expect(
      normalizeToolSelection(" get_file_contents, delete_file,get_file_contents "),
    ).toBe("get_file_contents,delete_file");
    expect(() => normalizeToolSelection("get_file_contents,../bad")).toThrow(
      "只能包含逗号分隔的工具名",
    );
  });

  it("parses setup flags strictly", () => {
    expect(parseSetupOptions([])).toEqual({
      help: false,
      rotate: false,
      tools: undefined,
    });
    expect(parseSetupOptions(["--rotate", "--tools", "all"])).toEqual({
      help: false,
      rotate: true,
      tools: "all",
    });
    expect(parseSetupOptions(["--tools=get_file_contents,delete_file"])).toEqual({
      help: false,
      rotate: false,
      tools: "get_file_contents,delete_file",
    });
    expect(() => parseSetupOptions(["--tool", "delete_file"])).toThrow(
      "未知参数",
    );
    expect(() => parseSetupOptions(["--tools"])).toThrow("缺少参数值");
    expect(() => parseSetupOptions(["--tools="])).toThrow("缺少参数值");
    expect(() => parseSetupOptions(["--tools", "all", "--tools", "all"])).toThrow(
      "只能指定一次",
    );
  });
});
