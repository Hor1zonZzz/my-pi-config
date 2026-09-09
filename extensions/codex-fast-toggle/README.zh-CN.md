# Codex Fast 开关

派生自 `pi-openai-codex-fast`（MIT）的本地 Pi 扩展，提供 session 级 Fast 开/关控制。

[English](README.md) | 中文

## 行为

- 保留 Pi 内置的 `openai-codex` 提供方，仅修改发出的请求负载（payload）。
- Fast 开启时，Codex 请求会携带 `service_tier: "priority"`。
- Fast 关闭时使用默认服务层级。
- 提供方与模型标识始终保持为 `openai-codex/<model>`。
- 没有已保存状态的 session 默认关闭 Fast。
- 状态存储在当前 Pi session 中；恢复或重载该 session 时会还原状态，树导航则跟随当前活动分支。
- 其他 Pi session、进程与独立子代理不受影响。fork 和 clone 会继承复制分支点的状态，之后各自独立变化。
- 仅在 `openai-codex` 模型处于激活状态时才显示 `/fast` 自动补全。
- 当 Codex 模型启用 Fast 时，状态栏会显示 `⚡ fast`。

## 用法

```text
/fast
/fast on
/fast off
```

`/fast` 保留 On/Off 选择框，取消不改变状态。命令使用 Pi 官方的
`registerCommand()` 和参数补全 API；仅保留一个小型补全过滤层，在非 Codex
模型下隐藏命令及参数，手动执行则提示不可用。非法参数在本地处理，不会发送给模型。
命令拼写遵循 Pi 标准的小写 `/fast` 分发。

配合本仓库的 `codex-server-compaction` transport，普通 SSE/WebSocket 请求、
预热与远程压缩都像 Codex CLI 一样，从最终请求 tier 生成
`x-codex-routing-hint`：开启时为 `model=<model>;tier=priority`，关闭时为
`model=<model>`，且请求体不携带 `service_tier`。不再依赖第二个 Fast 标志，也不改变
客户端身份。单独使用 Fast 扩展时，它仍仅修改 payload。

session 级持久化和按 provider 判断可用性仍是有意保留的 Pi 行为；不引入
Codex CLI 的全局默认设置或模型 tier 目录。

## 署名

最初的 fast 模式行为派生自 Kaan Ozdokmeci / 2h2d-co 的 `pi-openai-codex-fast`，基于 MIT 许可证。参见 `LICENSE` 与 `UPSTREAM-README.md`。
