# btw

Claude Code 风格的 `/btw` 临时旁路快问扩展：

- **用法**：输入 `/btw <问题>`（或只输入 `/btw` 弹窗输入）。
- **零污染主上下文**：只读快照当前主对话的 `messages` 与 `systemPrompt`（直接复用主对话 Prompt Cache，响应快、成本低），回答完毕即止，**不写入主对话 context**，也不打断主线记录。
- **悬浮小窗交互**：
  - 实时流式 Markdown 渲染
  - `Esc` / `Enter` / `Space` 一键关闭（流式输出中按 `Esc` 立即取消请求）
  - `↑` / `↓` / `PgUp` / `PgDn` / 鼠标滚轮滚动长回答
  - `c` 一键复制回答到剪贴板
