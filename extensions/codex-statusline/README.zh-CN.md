# Codex 当前账号与周额度状态栏

[English](README.md) | 中文

TUI 中启用 `openai-codex` 模型时，自动在 Pi 原有 footer 中显示：

```text
person@example.com · weekly 82% left
```

无需命令或额外配置。其他模型和非 TUI session 不显示、不轮询；不替换 footer，
不影响现有 Fast 等状态项。

## 账号与额度含义

- 使用 Pi 公开的 `ctx.modelRegistry.getApiKeyAndHeaders()` 获取当前请求认证，
  OAuth 刷新交给 Pi；不读取 Codex CLI 登录文件，不管理账号或切换凭据。
- 从当前 token 读取完整邮箱；没有邮箱时回退为 `acct-<账号 ID 末八位>`。
  显示内容会过滤终端控制字符。
- 携带该 token 和账号 ID 查询
  `GET https://chatgpt.com/backend-api/wham/usage`，不是用本地 token 数量推算。
- 只取普通 `rate_limit` 额度组，不混入模型专属的额外额度。检查 primary、secondary
  两个窗口，选择时长在七天 ±5% 内的窗口，显示取整并限制在 0～100 的
  `100 - used_percent`。
- 与 CLI 一样，secondary 未提供时长时可作为回退；但这里是周额度专用状态项，
  不会把明确属于其他周期的 secondary 错标为 weekly。
- 自定义/代理 endpoint、缺少认证或没有周额度时显示 `weekly unavailable`。
  不会把自定义 endpoint 的凭据转发给 ChatGPT。不支持 API-key 账单和其他后端。

这里显示服务器周窗口的剩余比例，不是自然周预算、五小时额度、重置倒计时，
也不保证下一次模型请求一定被允许。

独立的 [`codex-accounts`](../codex-accounts/README.zh-CN.md) 扩展可以切换全局登录。
本状态栏接收同进程的账号变更事件；其他 Pi 进程通过正常认证检查发现新账号。
两种方式都不会绕过新账号已有的五分钟额度缓存。

## 跨 session 共享查询

缓存位于 `<Pi agent 目录>/cache/codex-statusline/`，使用 Pi 公开的 `getAgentDir()`
确定目录（通常为 `~/.pi/agent`，可用 `PI_CODING_AGENT_DIR` 覆盖）。
同一目录内跨项目、跨进程共享；不同 agent 目录相互隔离。

- 没有有效缓存时由第一个 TUI session 查询；其他 session 复用结果。
  新建 session、切回 Codex 都不会绕过有效缓存。
- 同一账号/用户身份每 **5 分钟**最多发起一次尝试，失败也共享等待周期。
  同一工作区内的不同用户不会误共享额度。
- 每个 TUI 每 **15 秒**检查当前认证和本地缓存，并在 agent start/settled 时检查。
  这些本地检查不是各自发起额度查询；必要的 OAuth 刷新仍由 Pi 管理。
  其他 session 更新的缓存、外部账号变更会在下一次本地检查时反映（取决于认证解析耗时）。
- 跨进程目录锁合并并发刷新，缓存原子写入；请求前先保存下一次允许查询的时间，
  即使查询进程崩溃，也不会引发其他 session 连续重试。后续检查可回收死亡进程的锁，
  不会强行抢占活进程的锁。
- 请求超时为 15 秒，不跟随重定向，响应体限制为 64 KiB；不发起模型推理请求。
- 刷新失败保留上次比例并标记 `(stale)`；没有旧数据时显示 `unavailable`。
  到达重置时间或缓存过期也会标记 stale，不自行假定恢复为 100%。初次查询短暂显示 loading。
- 切换模型/session、reload、shutdown 会取消本地工作；检测到账号变更后，
  旧账号请求的迟到结果不能覆盖新账号状态。

缓存只保存哈希身份、额度、时间戳和通用请求状态；不保存邮箱、token、响应正文或后端错误。
缓存文件权限为 `0600`，新建缓存目录为 `0700`；不写入 session 历史，不引入后台服务或跨机器同步。

## 验证

Node 24 可直接运行纯逻辑与跨进程缓存测试：

```sh
node --test extensions/codex-statusline/quota.test.ts extensions/codex-statusline/cache.test.ts
```

`index.test.ts` 和类型检查还需要能够解析已安装的 Pi host 包；应在依赖可用的临时副本中
运行，不在本仓库安装依赖或保存凭据。测试覆盖跨进程去重、崩溃锁恢复、失败冷却、账号隔离、
迟到结果和生命周期清理，不连接真实后端。

交互验证包括 Pi 启动/reload、切换 Codex/其他模型、窄终端及多 session 共享显示。
插件不保证后端可用性，也不会让模型请求本身加速。

## 参考

依据 OpenAI Codex CLI 的协议和显示行为独立实现，参考 checkout `38cbebaf3f`：

- `codex-rs/backend-client/src/client/rate_limit_resets.rs`
- `codex-rs/tui/src/chatwidget/status_surfaces.rs`
- `codex-rs/tui/src/chatwidget/status_controls.rs`
- `codex-rs/tui/src/chatwidget/rate_limits.rs`

上游：<https://github.com/openai/codex>（Apache-2.0），未复制其源代码。
Pi 接入遵循官方 `status-line.ts`、`model-status.ts` 示例和 `docs/extensions.md`。
本实现使用约定的固定五分钟周期，不照搬 CLI 的 60/30/15/5 秒动态轮询。
usage 接口是上游实现细节，后续可能变化。
