# Releasing

## 发布模型

本工具通过 GitHub Release 分发，不依赖 npm 账号或 npm 包名：

- CI 在每个 push / PR 上运行测试。
- 推送 `v*` tag 后，Release workflow 会再次执行完整检查。
- Release 制品是固定名称的 `gemini-github-mcp-proxy.tgz`。
- 同时发布 `SHA256SUMS`、`install.sh` 和 `install.ps1`。
- 使用者可用 `npm install --global <tgz>` 安装；依赖仍从 npm 公共 Registry 下载。

固定下载地址：

```text
https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/gemini-github-mcp-proxy.tgz
https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/SHA256SUMS
https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/install.sh
https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/install.ps1
```

## 发布新版本

先确保工作区干净并通过本地检查：

```bash
npm run check
npm audit --audit-level=high
npm audit signatures
git status --short
```

按变更性质更新版本并创建 tag：

```bash
npm version patch   # 缺陷修复
# 或
npm version minor   # 向后兼容的新行为或能力
git push origin main
git push origin "v$(node -p "require('./package.json').version")"
```

tag 推送成功后，`.github/workflows/release.yml` 会：

1. 检查 tag 与 `package.json` 版本完全一致。
2. 运行高危漏洞审计、npm registry 签名审计、测试、类型检查和脚本语法检查。
3. 构建稳定命名的 `.tgz` 与 `SHA256SUMS`。
4. 在临时目录从制品执行全局安装和 CLI 版本验收。
5. 创建 GitHub Release，或向已有 Release 覆盖上传同版本制品。

## 本地验证制品

```bash
npm run pack:release
sh -n install.sh
npm install --global --prefix /tmp/gemini-github-mcp-install \
  --allow-scripts=esbuild,fsevents,workerd \
  dist/gemini-github-mcp-proxy.tgz
/tmp/gemini-github-mcp-install/bin/gemini-github-mcp --version
(cd dist && shasum -a 256 -c SHA256SUMS)
```

检查 npm 包内容，确保测试和发布脚本不进入制品：

```bash
npm pack --dry-run --json
```

## 发布后验收

```bash
curl -fsSL \
  https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/SHA256SUMS \
  -o /tmp/SHA256SUMS
curl -fsSL \
  https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/gemini-github-mcp-proxy.tgz \
  -o /tmp/gemini-github-mcp-proxy.tgz
cd /tmp
shasum -a 256 -c SHA256SUMS
```

再在全新环境执行 `install.sh`，确认 `gemini-github-mcp --version` 正常。

## 回退

Release tag 与制品不可变地表达一个版本。发现问题时：

1. 保留失败版本的 Release 供追溯，或将其标记为 Pre-release。
2. 修复后发布新的 patch 版本。
3. 不要用同名 tag 强推覆盖旧制品。
