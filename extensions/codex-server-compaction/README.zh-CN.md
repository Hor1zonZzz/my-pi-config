# Codex 服务端压缩

为 Pi 内置 `openai-codex/*` 模型提供 Codex Remote Compaction V2 的本地扩展。
它是 [`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
的 Codex-only 适配版，不覆盖 Pi provider 或 transport。

## 行为

Pi 进行手动或自动压缩时，扩展会并行启动两个请求：

1. 执行 Pi 内置文本压缩；
2. 请求 `POST /backend-api/codex/responses`，并在 input 末尾追加
   `{ "type": "compaction_trigger" }`。

V2 成功后会返回一个 opaque `compaction` item。扩展将最近用户消息和该
item 一起保存到 `CompactionEntry.details.remoteCompaction`。后续只有完全相同的
Codex provider/API/model 才会重放这段原生历史；其他模型正常使用 Pi 文本摘要和
保留消息。切回原 Codex 模型时，会从当前 session branch 恢复原生状态。

跨模型 assistant 回合不会写入 Codex-native replay，以免其他模型的 reasoning 和
tool-call 标识污染 artifact；这些回合仍保留在 Pi 的正常文本摘要路径中。

V2 失败或超过独立的五分钟请求上限时，已经并行运行的 Pi 内置压缩会直接成为结果。Pi 压缩失败而 V2 成功时，扩展会保留 artifact 并使用最小文本标记。扩展只恢复当前 V2 details shape，不为 legacy V1 或其他旧 artifact 格式提供迁移；这些 session 继续使用已保存的 Pi 文本摘要。

## Fast 模式

远程压缩请求继承当前 Codex service tier。本仓库 `/fast on` 生效时，请求携带
`service_tier: "priority"` 和对应 routing hint，与当前 Codex CLI 行为一致。
后端仍可能按默认层级执行，且 Fast 可能消耗更多 credits。

## 安装标识

请求遵循 Codex CLI 的 installation identity 约定：

- 设置 `CODEX_HOME` 时使用 `$CODEX_HOME/installation_id`；
- 否则使用 `~/.codex/installation_id`；
- 复用合法 UUID，文件缺失或无效时创建/替换。

该 UUID 是客户端 metadata，不是凭据；请求通过 `x-codex-installation-id` 发送。

## 数据与统计

对话上下文会发送到 ChatGPT Codex Responses 后端，opaque artifact 会保存在 Pi
本地 session JSONL 中。文本摘要和远程压缩 usage 会合并到 compaction usage，使
Pi session 统计恰好计入两个请求各一次；远程 usage 也保留在 details 中供检查。

## 范围

有意不实现：

- direct `openai/*` 与 Azure；
- provider override；
- 自定义 HTTP/WebSocket streaming；
- `previous_response_id`、`store: true` 与 `context_management` patch；
- 外部运行时依赖。

## 署名

基于 Alexis Gallagher 的 `pi-openai-server-compaction`（MIT）适配。参见
`LICENSE` 与仓库根目录 `THIRD_PARTY_NOTICES.md`。
