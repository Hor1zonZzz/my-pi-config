# Codex 服务端压缩

为 Pi 内置 `openai-codex/*` 模型提供 Codex Remote Compaction V2 的本地扩展。它是 [`pi-openai-server-compaction`](https://github.com/algal/pi-openai-server-compaction) 的 Codex-only 适配版，并仅覆盖内置 `openai-codex` stream transport，使普通请求与 V2 压缩共享同一 cached WebSocket continuation lane。

## 行为

Pi 进行手动或自动压缩时，扩展会并行启动两个请求：

1. 在独立临时 session lane 执行 Pi 内置文本压缩；
2. 通过主 cached WebSocket lane 请求 Codex V2，并在 input 末尾追加 `{ "type": "compaction_trigger" }`。

自定义 transport 会保存 canonical request/response items。live prefix 匹配时，压缩在线路上缩减为 `previous_response_id` 加 trigger；重连或 SSE fallback 则发送经过校验的完整历史。

V2 只保留真实的用户消息：[subagent 扩展](../subagent/README.zh-CN.md#状态通知)的 `<subagent_notification>` 消息和 Codex CLI 中一样属于上下文，不会被保留。

V2 成功后会返回一个 opaque `compaction` item。扩展按官方 64K 预算保留最近用户消息，并与该 item 一起保存到 `CompactionEntry.details.remoteCompaction`。扩展向完全相同的 Codex provider/API/model/账号提供精确原生历史，并删除压缩前可能残留的旧 `previous_response_id`。重放在 Pi payload hook 之后、自定义 transport 的实际请求 token 边界处完成，再交给 cached WebSocket 缩减：第一次请求或重连时在线路上发送显式 artifact history；live prefix 完全匹配后， Pi 会在线路上自动缩减为原生 `previous_response_id` 加新增 delta。其他模型正常使用 Pi 文本摘要和保留消息。

仅切换模型不会让 artifact 失效。但 artifact 之后一旦出现来自不同 provider/API/model 的 assistant 回合，扩展就会停止在当前 branch 重放旧 artifact，避免切回原模型时丢弃中间回合。此后由 Pi 的正常文本摘要上下文承接，直到完全相同的模型再次完成手动或自动 V2 压缩；切回模型本身不会额外触发压缩请求。

V2 失败时，已经并行运行的 Pi 内置压缩会直接成为结果。正式 transport 默认的 WebSocket 连接超时为 15 秒、SSE 响应头超时为 20 秒、流空闲超时为五分钟；这些是分阶段限制，不是整个压缩的五分钟总时限。重试或持续收到数据都可能使总耗时更长。Pi 压缩失败而 V2 成功时，扩展会保留 artifact 并使用最小文本标记。扩展只恢复当前 V2 details shape，不为 legacy V1 或其他旧 artifact 格式提供迁移；这些 session 继续使用已保存的 Pi 文本摘要。

## Fast 模式

远程压缩请求继承当前 Codex service tier。普通 SSE/WebSocket 请求、预热和远程压缩均从最终请求 tier 生成 routing hint，与 Codex CLI 一致。`/fast on` 时请求携带 `service_tier: "priority"` 和 `x-codex-routing-hint: model=<model>;tier=priority`； `/fast off` 时省略请求体 tier，hint 为 `model=<model>`。本地适配移除了上游仅用于路由的独立 Fast 标志，保持 Pi 客户端身份不变。现有 WebSocket 缓存将路由请求头计入连接身份，因此 tier 切换不会复用握手信息不匹配的连接。后端仍可能按默认层级执行，且 Fast 可能消耗更多 credits。

## 全局账号切换

`/codex-accounts` 保留 `openai-codex` provider 身份。新 V2 artifact 保存 `accountKey` 指纹，普通主 lane 请求记录 `codex-account-context` 历史归属（不含凭据或账号选择偏好）。出现其他账号回合后，A/B/A 不会重新启用 A 的旧 opaque artifact。没有账号归属的旧 V2 artifact 使用已保存的 Pi 文本回退；回退请求移除外来或无法确认归属的 opaque reasoning/compaction 和 response 引用，保留可见消息及工具结果。校验使用该请求实际绑定的 token，不会另查一次可能已被其他进程切换的全局认证。账号变化会重置缓存 lane，压缩使用 canonical history 前也校验归属。账号指纹的纯解析函数复用 `codex-statusline/quota.ts`。

## 安装标识

请求遵循 Codex CLI 的 installation identity 约定：

- 设置 `CODEX_HOME` 时使用 `$CODEX_HOME/installation_id`；
- 否则使用 `~/.codex/installation_id`；
- 复用合法 UUID，文件缺失或无效时创建/替换。

该 UUID 是客户端 metadata，不是凭据；请求通过 `x-codex-installation-id` 发送。

## 数据与统计

对话上下文会发送到 ChatGPT Codex Responses 后端，opaque artifact 会保存在 Pi 本地 session JSONL 中。文本摘要和远程压缩 usage 会合并到 compaction usage，使 Pi session 统计恰好计入两个请求各一次；远程 usage 也保留在 details 中供检查。

## 范围

有意不实现：

- direct `openai/*` 与 Azure；
- provider override；
- 参考 adapter 的 direct `openai/*`、Azure、工具、prompt、voice、Code Mode、Notebook 或 Responses Lite 功能；对应 vendor 实现路径已删除；
- `store: true` 或 `context_management` patch；
- 外部运行时依赖。

## 实现维护

正式远程路径是 `executeRemoteCompactionV2` 调用已注册的 Codex transport。已删除没有被正式流程调用的独立 fetch/SSE 压缩实现；`v2-request.test.ts` 使用模拟后端测试实际 V2 client 和 transport，包括 tier/header/trigger 序列化、输出数量校验、 incomplete/failed 响应及取消，不再用闲置辅助函数的测试证明总超时。

Pi 0.86.0 公开了 `@earendil-works/pi-ai/api/openai-responses-shared` 中的 `processResponsesStream`。前置原始事件捕获层可以取得 V2 artifact，但尚不能等价替换：本地回调会补全最终事件中缺失的 custom-tool 输入，本地解析器也保留了官方解析器会丢弃的原生 web-search 历史项。`parser-parity.test.ts` 对已安装 Pi 验证这些差异。在不引入另一套解析器的前提下保住这些行为之前，保留现有解析器和 transport。本次清理不改变消息/工具转换和账号隔离。

## 署名

基于 Alexis Gallagher 的 `pi-openai-server-compaction`，并移植 Igor Warzocha 及贡献者的 `@howaboua/pi-codex-conversion` cached Codex provider/compaction 实现；二者均为 MIT。参见 `LICENSE`、`vendor/howaboua/LICENSE` 与仓库根目录 `THIRD_PARTY_NOTICES.md`。
