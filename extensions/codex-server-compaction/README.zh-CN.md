# Codex 服务端压缩

为 Pi 内置 `openai-codex/*` 模型提供 Codex Remote Compaction V2 的本地扩展。
它是 [`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction)
的 Codex-only 适配版，并仅覆盖内置 `openai-codex` stream transport，使普通请求与 V2 压缩共享同一 cached WebSocket continuation lane。

## 行为

Pi 进行手动或自动压缩时，扩展会并行启动两个请求：

1. 在独立临时 session lane 执行 Pi 内置文本压缩；
2. 通过主 cached WebSocket lane 请求 Codex V2，并在 input 末尾追加
   `{ "type": "compaction_trigger" }`。

自定义 transport 会保存 canonical request/response items。live prefix 匹配时，
压缩在线路上缩减为 `previous_response_id` 加 trigger；重连或 SSE fallback 则发送
经过校验的完整历史。

V2 成功后会返回一个 opaque `compaction` item。扩展按官方 64K 预算保留最近用户消息，并与该
item 一起保存到 `CompactionEntry.details.remoteCompaction`。扩展向完全相同的
Codex provider/API/model 提供精确原生历史，并删除压缩前可能残留的旧
`previous_response_id`。Pi 的 cached WebSocket transport 在扩展 hook 之后运行：
第一次请求或重连时在线路上发送显式 artifact history；live prefix 完全匹配后，
Pi 会在线路上自动缩减为原生 `previous_response_id` 加新增 delta。其他模型正常
使用 Pi 文本摘要和保留消息。

仅切换模型不会让 artifact 失效。但 artifact 之后一旦出现来自不同
provider/API/model 的 assistant 回合，扩展就会停止在当前 branch 重放旧 artifact，
避免切回原模型时丢弃中间回合。此后由 Pi 的正常文本摘要上下文承接，直到完全相同
的模型再次完成手动或自动 V2 压缩；切回模型本身不会额外触发压缩请求。

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
- 参考 adapter 的 direct `openai/*`、Azure、工具、prompt、voice、Code Mode、Notebook 或 Responses Lite 功能；对应 vendor 实现路径已删除；
- `store: true` 或 `context_management` patch；
- 外部运行时依赖。

## 署名

基于 Alexis Gallagher 的 `pi-openai-server-compaction`，并移植 Igor Warzocha
及贡献者的 `@howaboua/pi-codex-conversion` cached Codex provider/compaction
实现；二者均为 MIT。参见 `LICENSE`、`vendor/howaboua/LICENSE` 与仓库根目录
`THIRD_PARTY_NOTICES.md`。
