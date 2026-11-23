#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scripts = {
  setup: "setup.mjs",
  verify: "verify.mjs",
};

function help() {
  console.log(`
Gemini GitHub MCP Proxy

用法：
  gemini-github-mcp setup                         首次部署，默认开放全部 GitHub MCP 工具
  gemini-github-mcp setup --tools all             显式选择全部工具
  gemini-github-mcp setup --tools tool_a,tool_b   只暴露指定工具
  gemini-github-mcp setup --rotate                轮换 Secrets 并重新部署
  gemini-github-mcp verify                        验收当前部署
  gemini-github-mcp verify --url https://<worker>.workers.dev

从 GitHub 安装：
  npm install --global https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/gemini-github-mcp-proxy.tgz

首次使用前：
  1. Node.js 22+
  2. npx wrangler login
  3. 准备 fine-grained GitHub PAT
`);
}

const args = process.argv.slice(2);
const command = args.shift() || "setup";

if (command === "--help" || command === "-h" || command === "help") {
  help();
  process.exit(0);
}
if (command === "--version" || command === "-v" || command === "version") {
  const { readFile } = await import("node:fs/promises");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const packageJson = JSON.parse(await readFile(`${root}/package.json`, "utf8"));
  console.log(packageJson.version);
  process.exit(0);
}

const script = scripts[command];
if (!script) {
  console.error(`未知命令：${command}\n`);
  help();
  process.exit(1);
}

const scriptPath = fileURLToPath(new URL(script, import.meta.url));
const child = spawn(process.execPath, [scriptPath, ...args], {
  stdio: "inherit",
});
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
