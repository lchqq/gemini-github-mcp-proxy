#!/usr/bin/env node
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const destination = join(root, "dist");
const stableName = "gemini-github-mcp-proxy.tgz";

function run() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      npm,
      ["pack", "--pack-destination", destination, "--json"],
      {
        cwd: root,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || stdout || `npm pack 退出码 ${code}`));
    });
  });
}

async function main() {
  await mkdir(destination, { recursive: true });
  const output = await run();
  const parsed = JSON.parse(output.trim());
  const packed = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!packed?.filename) throw new Error("无法解析 npm pack 输出。");

  const versionedPath = join(destination, packed.filename);
  const stablePath = join(destination, stableName);
  await copyFile(versionedPath, stablePath);
  await copyFile(join(root, "install.sh"), join(destination, "install.sh"));
  await copyFile(join(root, "install.ps1"), join(destination, "install.ps1"));

  const digest = createHash("sha256")
    .update(await readFile(stablePath))
    .digest("hex");
  await writeFile(
    join(destination, "SHA256SUMS"),
    `${digest}  ${stableName}\n`,
    "utf8",
  );

  console.log(`
GitHub Release 制品已生成：
  ${stablePath}
  ${join(destination, "SHA256SUMS")}

SHA-256：
  ${digest}

安装：
  npm install --global --allow-scripts=esbuild,fsevents,workerd "${stablePath}"
  gemini-github-mcp setup
`);
}

main().catch((error) => {
  console.error(`打包失败：${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
