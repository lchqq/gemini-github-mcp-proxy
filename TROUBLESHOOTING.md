# Troubleshooting

先运行：

```bash
gemini-github-mcp verify
npx wrangler deployments status
```

`gemini-github-mcp verify` 会检查健康状态、OAuth metadata、动态客户端注册和 `/mcp` 的未认证保护。

## `gemini-github-mcp setup` 提示 Cloudflare 未登录

```bash
npx wrangler login
gemini-github-mcp setup
```

如果浏览器无法完成登录，改用 Cloudflare API Token，并确保账号拥有 Workers Scripts 编辑权限。

登录了多个 Cloudflare 账号时，setup 会要求选择账号。非交互环境可提前设置：

```bash
export CLOUDFLARE_ACCOUNT_ID=<account-id>
gemini-github-mcp setup
```

从 GitHub Release 安装后如果 npm 提示 `install-scripts` 被阻止，可重新安装并显式放行 Wrangler 的已知构建依赖：

```bash
npm install --global \
  https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/gemini-github-mcp-proxy.tgz \
  --allow-scripts=esbuild,fsevents,workerd
```

## 部署后没有 `workers.dev` 地址

打开 Cloudflare Dashboard → Workers & Pages，确认账号已启用 Workers，并创建 `workers.dev` 子域。企业策略可能禁止公开 `workers.dev`；此时需要配置自定义域名，并同步调整验收和 Connector URL。

## GitHub PAT 验证失败

检查：

- Token 是否过期或被撤销
- 是否选择了目标仓库
- 当前任务需要的资源权限是否已授予
- 组织仓库是否等待管理员批准 fine-grained token

PAT 的范围由你决定。需要 Actions、Workflows、Administration、Secrets 等能力时，添加对应权限；工具不会在 Worker 层替你扩大或缩小 PAT 权限。

## GitHub 返回 403

通常表示 PAT 缺少当前工具需要的权限。按操作检查：

- 读写文件或 commit：Contents
- 修改 workflow 文件：Contents + Workflows
- Issue：Issues
- PR 与审阅：Pull requests
- Actions：Actions
- 仓库管理：Administration 或相应组织权限

是否授予这些权限由你决定，不需要为了使用本工具统一开放更大权限。

## 工具太多、选择不准或超过模型上下文

默认会透传 GitHub Remote MCP 的全部工具，这是为了不替用户删减能力。需要更小的工具面时可显式指定：

```bash
gemini-github-mcp setup --tools get_file_contents,pull_request_read,issue_read
```

恢复全部工具：

```bash
gemini-github-mcp setup --tools all
```

`--tools` 会通过 GitHub Remote MCP 的 `X-MCP-Tools` 头生效；工具名拼写错误时，上游可能返回空集合或错误。

## Gemini 显示 Connector 已连接，但模型说工具不可用

1. 确认新聊天中先输入 `@`。
2. 从自动完成菜单选择 `GitHub Dev MCP`。
3. 确认没有把名称作为普通文本粘贴。
4. 优先使用“自动”或 `Neon`。
5. 新建聊天，避免沿用旧的工具绑定状态。
6. 检查每次工具调用时是否出现新的许可提示。

实测中 `Hydrogen` 曾无法绑定自定义工具，`Carbon` 受订阅档位限制。模式名称和可用性可能随 Gemini UI 变化。

## OAuth 授权页反复出现

检查：

1. 是否输入了 setup 最后输出的 12 位 PIN。
2. 是否运行过 `gemini-github-mcp setup --rotate`；轮换后旧 PIN 和旧令牌全部失效。
3. Worker 日志中是否有 `/authorize` 400，通常是回调前缀不匹配。
4. 是否在 Gemini 中重新添加了 Connector。

如果授权页返回 `429 Too many authorization attempts`，说明同一来源一分钟内提交 PIN 超过 10 次。等待 60 秒后重试；不要连续脚本化尝试。

## MCP 返回 401

这是预期保护。`/mcp` 必须携带 OAuth access token。

如果 Gemini 始终返回 401：

1. 删除并重新添加 Connector。
2. 完成 OAuth 授权。
3. 如果仍失败，轮换 Secrets 后重试。

## 文件工具只返回 SHA 或“非文本内容”

确认部署的是当前版本：

```bash
curl -fsSL https://github.com/hrygo/gemini-github-mcp-proxy/releases/latest/download/install.sh | sh
gemini-github-mcp setup --rotate
gemini-github-mcp verify
```

Worker 必须把 JSON 和 SSE 中的文本 `resource` 提升为普通 `text`。若仍只有状态行，查看 Cloudflare Worker Logs，确认上游响应类型和代理版本。

## 读取仓库返回 404

通常不是 Gemini 的问题，而是 PAT 没有目标仓库权限。用同一 PAT 检查：

```bash
curl -H "Authorization: Bearer <PAT>" \
  https://api.github.com/repos/<owner>/<repo>
```

不要在聊天、Issue 或日志中粘贴真实 PAT。

## 修改代码成功，但无法运行测试

这是预期限制。Gemini App 没有本地文件系统和 shell。正确流程是：

1. Gemini 创建分支、提交并打开 Draft PR。
2. GitHub Actions 运行测试。
3. Codex、Claude Code、Antigravity 或其他 code agent 基于同一 PR 继续修复。

## 如何安全重来

```bash
gemini-github-mcp setup --rotate
gemini-github-mcp verify
```

然后在 Gemini 中删除并重新添加 `GitHub Dev MCP`。旧令牌会因 `SIGNING_SECRET` 轮换而失效。
