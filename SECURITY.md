# Security

## 信任模型

每个使用者独立部署：

```text
一个使用者
  = 一个 Cloudflare Worker
  + 一个 GitHub PAT
  + 一个 Gemini Connected App
```

不要共享已经授权的 Worker URL。Worker 不维护多用户身份；所有请求最终都使用同一个 `GITHUB_PAT` 身份。

## 权限责任

| 层 | 负责什么 | 不是做什么 |
|---|---|---|
| GitHub PAT | 最终授权边界：仓库、资源类型、读写范围 | 不决定 Gemini 当前想调用哪个工具 |
| GitHub Remote MCP | 暴露工具及执行对应 API 操作 | 不扩大 PAT 已有权限 |
| Gemini | 选择工具、提交参数并逐次请求用户许可 | 不接触 PAT |
| Worker | OAuth、Bearer 校验、PAT 注入、正文兼容 | 不默认增加或削减工具白名单 |

Worker 默认透传 GitHub Remote MCP 全部工具。需要缩小上下文或主动限制工具集时，用户可显式运行：

```bash
gemini-github-mcp setup --tools tool_a,tool_b
```

是否允许删除文件、合并 PR、创建或删除仓库、修改 Actions、读取 Secrets 等，由用户选择 PAT 权限并在 Gemini 中确认。任何“推荐权限”都只是起点，不是 Worker 强制限制。

## PAT 选择

推荐 fine-grained PAT，并自行选择仓库范围。常见可写开发起点：

- Metadata：Read
- Contents：Read and write
- Issues：Read and write
- Pull requests：Read and write

按需增加：

- Workflows：修改 `.github/workflows`
- Actions：读取、取消或重跑 workflow
- Administration：仓库级管理操作
- Secrets：管理 Actions/环境 Secret
- Packages、Discussions、Projects 等：使用对应 MCP 工具时

classic PAT 同样可用，实际能力由 `repo`、`workflow`、`read:org`、`project`、`gist` 等 scope 决定。

PAT 是真实凭据。不要提交到仓库、粘贴到聊天、写进命令参数、日志或截图中。

## 数据边界

| 数据 | 保存位置 | 是否进入 Gemini |
|---|---|---|
| `GITHUB_PAT` | Cloudflare Worker Secret | 否 |
| `ADMIN_PIN` | Cloudflare Worker Secret、setup 一次性输出 | 用户手动输入授权页 |
| `SIGNING_SECRET` | Cloudflare Worker Secret | 否 |
| OAuth access / refresh token | Gemini 凭据存储；无状态签名令牌 | 是，作为 Bearer token |
| 仓库文件、Issue、PR、Actions 等 | GitHub；工具调用时经 Worker 转发 | 是，取决于任务内容 |

Provider 配置保存在用户配置目录，只含 Worker URL、MCP URL、Worker 名称、工具范围和部署时间，不含 Secret。

## OAuth 与令牌

- 动态客户端注册返回公共客户端 `token_endpoint_auth_method: none`。
- 注册回调必须匹配受信 Gemini 回调 origin 与路径前缀。
- 授权请求必须使用 `S256` PKCE。
- 授权 PIN 为随机 12 位数字，只在 setup 完成后显示一次。
- `/authorize` 的 PIN 提交使用 Cloudflare Rate Limiting binding，按来源每分钟允许 10 次尝试。
- access token 和 refresh token 是无状态 HMAC-SHA256 签名令牌，当前有效期 10 年。
- 授权码当前有效期为 10 分钟，没有服务端一次性消费记录。

轮换语义：

- 只轮换 `ADMIN_PIN`：阻止新授权，不使已有 token 失效。
- 轮换 `SIGNING_SECRET`：使所有已有 access/refresh token 失效。
- 轮换 `GITHUB_PAT`：旧 OAuth token 仍可访问 Worker，但后续 GitHub 请求改用新 PAT。
- 删除 Gemini Connector：停止该客户端使用，但不单独吊销无状态 token。

发生凭据泄露时：

1. 在 GitHub 撤销 PAT。
2. 运行 `gemini-github-mcp setup --rotate`。
3. 在 Gemini 删除并重新添加 Connector。
4. 检查 GitHub 审计日志、分支、commit、Issue、PR 与 Actions。

## 部署安全

- 保持 `workers_dev: true` 并使用 HTTPS。
- 不要把 Secret 写入 `.dev.vars`、源码、命令参数或 shell 历史。
- setup 通过 stdin 一次性上传三个 Secrets；PAT 不会进入仓库。
- 授权页返回 `no-store`、CSP、禁止 iframe 和 no-referrer 响应头。
- `/mcp` 未认证时返回 RFC 9728 OAuth discovery challenge。
- Worker 健康检查只返回 Secret 是否齐全，不返回值。

## 已知限制

- 当前未实现服务端客户端数据库或授权码一次性消费记录。Cloudflare Rate Limiting 按边缘位置近似计数，不提供全球严格单点限流。
- access/refresh token 长期有效，无法按 Connector 单独吊销；高风险场景应轮换 `SIGNING_SECRET`。
- Worker 不是完整权限沙箱，也不执行本地命令。GitHub PAT 才是授权边界。
- Gemini 仍可能提出错误或危险操作；高影响操作必须在逐次许可提示中核对仓库、分支、文件、PR 和参数。
