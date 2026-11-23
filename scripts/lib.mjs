import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function configPath() {
  if (process.env.GEMINI_GITHUB_MCP_CONFIG_DIR) {
    return join(process.env.GEMINI_GITHUB_MCP_CONFIG_DIR, "config.json");
  }
  if (process.platform === "darwin") {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "gemini-github-mcp-proxy",
      "config.json",
    );
  }
  if (process.platform === "win32") {
    return join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "gemini-github-mcp-proxy",
      "config.json",
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
    "gemini-github-mcp-proxy",
    "config.json",
  );
}

export function normalizeBaseUrl(input) {
  const url = new URL(input);
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !isLocal) {
    throw new Error("MCP URL 必须使用 HTTPS；仅本机开发可使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("MCP URL 不能包含用户名、密码、查询参数或片段。");
  }
  if (url.pathname !== "/" && url.pathname !== "/mcp" && url.pathname !== "/mcp/") {
    throw new Error("MCP URL 只支持 Worker 根路径或 /mcp。");
  }
  return url.origin;
}

export async function readConfig() {
  try {
    return JSON.parse(await readFile(configPath(), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeConfig(config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  if (process.platform !== "win32") await chmod(path, 0o600);
}

export function findWorkersDevUrl(output) {
  const matches = output.match(/https:\/\/[^\s"'<>]+\.workers\.dev(?:\/[^\s"'<>]*)?/g);
  return matches?.at(-1)?.replace(/[),.;]+$/, "") ?? null;
}

export function normalizeToolSelection(input) {
  if (input === undefined || input === null || input.trim() === "") return null;
  if (input.trim().toLowerCase() === "all") return null;

  const tools = [
    ...new Set(
      input
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
  if (tools.length === 0) return null;
  if (tools.some((tool) => !/^[A-Za-z0-9_-]+$/.test(tool))) {
    throw new Error("UPSTREAM_TOOLS 只能包含逗号分隔的工具名。");
  }
  return tools.join(",");
}

export function parseSetupOptions(rawArgs) {
  const options = {
    help: false,
    rotate: false,
    tools: undefined,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const value = rawArgs[index];
    if (value === "--help" || value === "-h") {
      options.help = true;
      continue;
    }
    if (value === "--rotate") {
      options.rotate = true;
      continue;
    }
    if (value === "--tools" || value.startsWith("--tools=")) {
      if (options.tools !== undefined) {
        throw new Error("--tools 只能指定一次。");
      }
      const inline = value.startsWith("--tools=");
      const selected = inline ? value.slice("--tools=".length) : rawArgs[index + 1];
      if (
        selected === undefined ||
        selected.trim() === "" ||
        (!inline && selected.startsWith("--"))
      ) {
        throw new Error("--tools 缺少参数值。使用 --tools all 或逗号分隔的工具名。");
      }
      options.tools = selected;
      if (!inline) index += 1;
      continue;
    }
    throw new Error(`未知参数：${value}。运行 gemini-github-mcp setup --help 查看用法。`);
  }

  return options;
}
