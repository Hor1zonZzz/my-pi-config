# Codex Fast 开关

派生自 `pi-openai-codex-fast`（MIT）的本地 Pi 扩展，提供持久化的 Fast 开/关控制。

[English](README.md) | 中文

## 行为

- 保留 Pi 内置的 `openai-codex` 提供方，仅修改发出的请求负载（payload）。
- Fast 开启时，Codex 请求会携带 `service_tier: "priority"`。
- Fast 关闭时使用默认服务层级。
- 提供方与模型标识始终保持为 `openai-codex/<model>`。
- 全局状态存储在 `~/.pi/agent/codex-fast.json` 中，由各个 Pi 进程与子代理共享。
- 仅在 `openai-codex` 模型处于激活状态时才显示 `/fast` 自动补全。
- 当 Codex 模型启用 Fast 时，状态栏会显示 `⚡ fast`。

## 用法

```text
/fast
/fast on
/fast off
```

该扩展使用输入拦截而非 `registerCommand()`，以便在非 Codex 模型下隐藏斜杠补全。

## 署名

最初的 fast 模式行为派生自 Kaan Ozdokmeci / 2h2d-co 的 `pi-openai-codex-fast`，基于 MIT 许可证。参见 `LICENSE` 与 `UPSTREAM-README.md`。
