#!/usr/bin/env node
import { randomBytes, randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  configPath,
  findWorkersDevUrl,
  normalizeBaseUrl,
  normalizeToolSelection,
  parseSetupOptions,
  readConfig,
  writeConfig,
} from "./lib.mjs";
import { verifyDeployment } from "./verify.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const wranglerPackagePath = require.resolve("wrangler/package.json");
const wranglerPackage = JSON.parse(await readFile(wranglerPackagePath, "utf8"));
const wranglerBin = join(
  dirname(wranglerPackagePath),
  wranglerPackage.bin.wrangler,
);
const rawArgs = process.argv.slice(2);

function printHelp() {
  console.log(`
Gemini GitHub MCP Proxy 一键部署

用法：
  gemini-github-mcp setup                          首次部署，默认开放全部 GitHub MCP 工具
  gemini-github-mcp setup --tools all              显式选择全部工具
  gemini-github-mcp setup --tools get_file_contents,delete_file
                                                    只暴露指定工具
  gemini-github-mcp setup --rotate                 轮换全部 Secret 并重新部署

安装方式：
  npm install --global https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/gemini-github-mcp-proxy.tgz

部署前：
  1. Node.js 22+
  2. 已执行 npx wrangler login
  3. 准备一个 fine-grained GitHub PAT

GitHub PAT 的仓库范围和权限由使用者决定。常见开发起点：
  Metadata: Read
  Contents: Read and write
  Issues: Read and write
  Pull requests: Read and write

需要 Actions、Workflows、Secrets、Administration 或其他能力时，
按实际要使用的 GitHub MCP 工具添加对应 PAT 权限。
`);
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: {
        ...process.env,
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        CI: options.interactive ? "" : "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.stream) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (options.stream) process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function runWrangler(wranglerArgs, options = {}) {
  const result = await run(process.execPath, [wranglerBin, ...wranglerArgs], options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout)
      .split("\n")
      .filter((line) => line.trim() && !line.includes("npm notice"))
      .slice(-8)
      .join("\n");
    throw new Error(`wrangler ${wranglerArgs.join(" ")} 失败\n${detail}`);
  }
  return result;
}

function hiddenPrompt(label) {
  if (!process.stdin.isTTY) {
    throw new Error("setup 需要交互式终端，以安全读取 GitHub PAT。");
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const previousRaw = stdin.isRaw;
    let value = "";

    function finish(error) {
      stdin.setRawMode(previousRaw ?? false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    }

    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === "\u0003") return finish(new Error("已取消。"));
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") value += char;
      }
    }

    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function selectAccount(accounts) {
  const selectedFromEnv = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (selectedFromEnv) {
    const match = accounts.find((account) => account.id === selectedFromEnv);
    if (!match) {
      throw new Error(
        `CLOUDFLARE_ACCOUNT_ID=${selectedFromEnv} 不属于当前登录账号。`,
      );
    }
    return match;
  }
  if (accounts.length === 1) return accounts[0];

  console.log("\n检测到多个 Cloudflare 账号：");
  accounts.forEach((account, index) => {
    console.log(`  ${index + 1}. ${account.name}`);
  });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`选择账号 [1-${accounts.length}]： `);
    const index = Number.parseInt(answer, 10) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= accounts.length) {
      throw new Error("Cloudflare 账号选择无效。已取消。");
    }
    return accounts[index];
  } finally {
    rl.close();
  }
}

async function validateGitHubPat(pat) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${pat}`,
      accept: "application/vnd.github+json",
      "user-agent": "gemini-github-mcp-proxy-setup",
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200) {
    throw new Error(
      `GitHub PAT 验证失败（HTTP ${response.status}）。请检查 token 是否有效、过期或缺少仓库权限。`,
    );
  }
  const user = await response.json();
  return {
    login: typeof user.login === "string" ? user.login : "unknown",
    classic: response.headers.has("x-oauth-scopes"),
  };
}

async function existingSecrets() {
  let result;
  try {
    result = await runWrangler(["secret", "list", "--format", "json"]);
  } catch {
    return [];
  }
  const start = result.stdout.indexOf("[");
  const end = result.stdout.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    return JSON.parse(result.stdout.slice(start, end + 1));
  } catch {
    return [];
  }
}

function generatePin() {
  return Array.from({ length: 2 }, () =>
    randomInt(0, 1_000_000).toString().padStart(6, "0"),
  ).join("");
}

async function verifyWithRetry(workerUrl) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await verifyDeployment(workerUrl);
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        console.log(`  第 ${attempt} 次验收未通过，等待 Secret 生效后重试...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw lastError;
}

async function main() {
  const options = parseSetupOptions(rawArgs);
  if (options.help) return printHelp();
  const rotate = options.rotate;
  console.log("\nGemini GitHub MCP Proxy 一键部署\n");

  const packageJson = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  console.log(`使用工具版本 ${packageJson.version}。`);

  const whoami = await runWrangler(["whoami", "--json"]);
  const auth = JSON.parse(whoami.stdout);
  if (!auth.loggedIn || !auth.accounts?.length) {
    throw new Error("Cloudflare 尚未登录。请先运行：npx wrangler login");
  }
  const account = await selectAccount(auth.accounts);
  process.env.CLOUDFLARE_ACCOUNT_ID = account.id;
  console.log(`Cloudflare 已登录：${account.name}`);

  const secrets = await existingSecrets();
  if (secrets.length > 0 && !rotate) {
    const proceed = await confirm(
      "检测到现有 Secrets。继续会轮换 PAT、授权 PIN 与签名密钥，使当前 Connector 失效。继续？[y/N] ",
    );
    if (!proceed) {
      console.log("已取消，没有修改云端配置。");
      return;
    }
  }

  console.log("\n请粘贴 fine-grained GitHub PAT。输入不会显示，也不会写入磁盘。");
  const pat = (await hiddenPrompt("GitHub PAT: ")).trim();
  if (pat.length < 20) throw new Error("GitHub PAT 为空或过短。");

  process.stdout.write("正在验证 GitHub PAT... ");
  const github = await validateGitHubPat(pat);
  console.log(`通过（账号 ${github.login}）。`);
  if (github.classic) {
    console.log(
      "警告：检测到可能为 classic PAT。建议改用仅授权目标仓库的 fine-grained PAT。",
    );
  }

  const adminPin = generatePin();
  const signingSecret = randomBytes(48).toString("hex");
  const previousConfig = await readConfig();
  const requestedTools =
    options.tools ?? process.env.UPSTREAM_TOOLS ??
    previousConfig?.upstreamTools;
  const upstreamTools = normalizeToolSelection(
    typeof requestedTools === "string" ? requestedTools : undefined,
  );

  console.log("正在部署 Worker...");
  const deployArgs = ["deploy"];
  if (upstreamTools) {
    deployArgs.push("--var", `UPSTREAM_TOOLS:${upstreamTools}`);
  }
  const deployment = await runWrangler(deployArgs, { stream: true });
  const deployedUrl = findWorkersDevUrl(`${deployment.stdout}\n${deployment.stderr}`);
  if (!deployedUrl) {
    throw new Error("部署成功，但无法从 wrangler 输出识别 workers.dev 地址。");
  }
  const workerUrl = normalizeBaseUrl(deployedUrl);

  console.log("正在一次上传 Cloudflare Secrets...");
  await runWrangler(["secret", "bulk"], {
    input: JSON.stringify({
      GITHUB_PAT: pat,
      ADMIN_PIN: adminPin,
      SIGNING_SECRET: signingSecret,
    }),
  });

  console.log("正在验收 OAuth、DCR 与鉴权端点...");
  const verification = await verifyWithRetry(workerUrl);
  await writeConfig({
    workerUrl,
    mcpUrl: verification.mcpUrl,
    workerName: packageJson.name,
    upstreamTools: upstreamTools ?? "all",
    configuredAt: new Date().toISOString(),
  });

  console.log(`
部署成功

Connector 名称：GitHub Dev MCP
MCP URL：${verification.mcpUrl}
授权 PIN：${adminPin}
GitHub MCP 工具范围：${upstreamTools ?? "全部（默认透传）"}

授权 PIN 只在这里显示一次。请立即复制；遗失后运行：
  gemini-github-mcp setup --rotate

下一步：
1. 打开 Gemini Web → 设置 → 已连接的应用
2. 添加自定义 MCP App，名称填 GitHub Dev MCP
3. MCP URL 填上面的地址，完成授权
4. 在每个新聊天输入 @，从菜单选择 GitHub Dev MCP

本机部署信息已保存到：
  ${configPath()}
`);
}

main().catch((error) => {
  console.error(`\n部署失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
