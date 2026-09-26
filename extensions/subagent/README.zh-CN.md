# Subagent 子代理

[English](README.md) | 中文

把划定范围的任务交给专门的 agent。每个 subagent 都是一个独立的 `pi` 进程，拥有自己的
上下文窗口。它可以在前台运行（主代理等它），也可以在后台运行（`async: true`）。完整的
会话会保存下来供事后查看；运行期间，输入框下方的面板可以用来查看或停止它们。

```text
  ⠼  subagent  parallel · 1/3 done                                     12s · ↓1.2k
     ├ ● scout   Find the models …                                     8s · ↓900
     ├ ⠼ scout   Find the providers …                read src/providers.ts · 12s
     └ · worker  Update the docs …                                        queued

  ─ ⠼ Running subagent · 12s ──────────────────────────────────────────────────

  ─ gpt-5.6-sol · medium ─────────────────────────────────────── context 42% ──
  ▾ 2 subagents running  ·  ↑↓ select · enter view · x stop · esc back
  › ⠼ scout  Find the providers …                    read src/providers.ts · 12s
    ⠼ worker bg  Update the docs …                              $ npm test · 3s
```

这是本仓库自己的实现。agent 发现（`agents.ts`）、示例 agent、工作流提示词，以及进程
运行器的一部分来自 Pi 官方 subagent 示例，其余部分都是重写的。

## 目录结构

```text
subagent/
├── index.ts        # 装配：工具、命令、面板、浮层、生命周期
├── tool.ts         # subagent 工具：三种模式、同步/异步、结果
├── notices.ts      # 后台运行的一行状态通知
├── runner.ts       # 以 RPC 模式启动子 pi、发送任务、解析事件、写元数据
├── runs.ts         # 运行快照，以及本进程运行的内存登记表
├── store.ts        # 子会话目录、元数据、读取对话记录
├── background.ts   # 后台任务和 steer 投递
├── panel.ts        # 输入框下方的列表及按键处理
├── viewer.ts       # 实时对话记录视图和 /subagent-history
├── render.ts       # 工具行、完成卡片、面板行
├── format.ts       # 纯格式化函数
├── config.ts       # /subagent 模型与思考级别配置
├── agents.ts       # agent 发现与 frontmatter 更新
├── agents/         # scout、planner、reviewer、worker
└── prompts/        # /scout、/implement、/scout-and-plan、/implement-and-review
```

## 调用方式

工具每次只能用一种模式：

| 模式 | 参数 | 行为 |
| --- | --- | --- |
| 单个 | `{ agent, task }` | 一个 agent，一个任务 |
| 并行 | `{ tasks: [...] }` | 最多 8 个任务，同时最多跑 4 个 |
| 链式 | `{ chain: [...] }` | 依次执行；`{previous}` 替换为上一步的答案 |

三种模式默认都在前台运行，加上 `async: true` 就改为后台运行：

```json
{ "agent": "scout", "task": "Find authentication entry points.", "async": true }
```

- **前台（同步）**：主代理等待期间，工具行实时刷新。结果是 subagent 的答案；并行模式下
  每个任务一段，每段最多 50 KB；最后附 `Transcripts:`，每个运行一行，给出短 ID 和会话文件。
- **后台（异步）**：调用立即返回，每个任务一行：短运行 ID、agent、初始状态（`running`；链式
  后续步骤和并行中排在前 4 个之后的任务为 `queued`）和会话文件。之后的行为见
  [主 agent 看到什么](#主-agent-看到什么)。最多同时 4 个后台任务。异步需要长驻的 TUI 或 RPC 会话，print 和 JSON
  模式会拒绝；subagent 内部也会拒绝（它的会话在自己的任务结束时就退出了）。

项目本地的 agent（`.pi/agents/*.md`）只在 `agentScope` 为 `"project"` 或 `"both"` 时运行，
而且即使项目已被信任，运行前也一定会先确认，除非调用时设置了 `confirmProjectAgents: false`。

## 查看和停止运行中的 subagent

只要有 subagent 在运行（前台或后台），输入框下方就会列出它们，显示当前动作和已用时间。

| 按键 | 位置 | 作用 |
| --- | --- | --- |
| `↓` | 空的输入框 | 进入列表 |
| `↑` `↓` | 列表 | 选择；在第一项按 `↑` 回到输入框 |
| `Enter` | 列表 | 打开实时对话记录 |
| `x` `x` | 列表或对话记录 | 停止选中的运行（3 秒内按两次） |
| `Esc` | 列表 | 回到输入框，不会中断主代理 |
| 其他任意键 | 列表 | 回到输入框，正常打字 |

只有输入框为空并且有焦点时 `↓` 才会被接管，所以历史记录和多行编辑都不受影响。停止只影响
这一个运行：并行中的其他任务继续，链式在这一步停下，工具或后台任务会把它报告为已停止。
subagent 已经做完的改动不会回滚。停止时先给子 Pi 发 `abort` 并关闭它的输入，让它有序退出；
2 秒后仍在运行就发 SIGTERM，再过 5 秒发 SIGKILL。

对话记录视图会显示任务、思考过程（前几行，按 `t` 显示全部）、工具调用、工具结果，以及
正在流式输出的答案。它会自动跟随新输出，直到你往上滚；按 `G` 或 `End` 恢复跟随。按键：
`↑↓`、`PgUp`/`PgDn`、`g`/`G`、`t`、`x x`、`Esc`。

## 历史记录

```text
/subagent-history
```

列出当前会话的全部运行，包括 `/reload` 或重启之前的，最新的在前。`Enter` 打开对话记录，
`x x` 停止正在运行的，`r` 刷新，`Esc` 关闭。

每次运行会保存 Pi 自己的会话文件和一个元数据文件：

```text
<agent 目录>/subagent-sessions/<主会话 ID>/
├── <短运行 ID>.jsonl    # 子会话，运行时逐条写入
└── <运行 ID>.meta.json  # agent、任务、模式、状态、时间、用量、答案
```

派发时，扩展选一个前 8 位在该目录中唯一的运行 ID，并创建空文件 `<短运行 ID>.jsonl`。子进程
用 `--session <这个文件>` 启动：Pi 遇到空的会话文件会立即写入会话头，之后每条记录也立即追加，
所以交给主 agent 的路径从一开始就存在。从未启动的任务（中途停止的链、被取消的任务）不会留下
文件。在此之前记录的运行使用 Pi 自己的文件名 `<时间戳>_<运行 ID>.jsonl`，仍然能找到。这些文件永久
保留，需要腾空间时直接删目录。它们和普通 Pi 会话一样，包含 subagent 读过的内容；它们
不会出现在 `/resume` 里。Pi 进程在运行结束前退出的记录会显示为中断。

在 TUI 里，`/subagent-jobs` 打开同一个列表；`/subagent-jobs cancel <id|all>` 在任何模式下都
可以取消后台任务。

## 主 agent 看到什么

对后台运行，主 agent 会收到三种消息；运行状态没变时什么都不收到：

```text
工具结果   Started background job subagent-37690385. State changes arrive as …
           67380226 scout running /…/subagent-sessions/<主会话>/67380226.jsonl
           8edb76e2 scout running /…/subagent-sessions/<主会话>/8edb76e2.jsonl

通知       <subagent_notification>
           {"run":"67380226","status":"completed"}
           </subagent_notification>

最终消息   Background job subagent-37690385 completed.
           <subagent_result run="67380226" agent="scout" status="completed">
           ONE
           </subagent_result>
           <subagent_result run="8edb76e2" agent="scout" status="completed">
           …
           </subagent_result>
```

- **通知**：派发之后，运行每次状态变化各一条：`queued → running`，以及 `running →
  completed | failed | stopped`。只包含运行 ID 和状态（约 20 token），和普通消息一样写入会话，
  以 `triggerTurn: false` 发送：主 agent 工作时，Pi 在当前这一轮结束时追加；空闲时立即追加。
  它从不触发新一轮对话，在聊天里显示为一行。实时动作（正在读的文件、正在调用的工具）、耗时和
  用量都不算状态变化。
- **最终消息**：结束整个任务的那次变化不单独通知。任务的最终消息给出每个子任务的状态和回答
  （每个最多 16 KB；链式中没运行的步骤为 `not started`），以 `deliverAs: "steer"` 加
  `triggerTurn: true` 投递，空闲的主 agent 会开始新的回复。整条消息最多 32 KB、1000 行。
- **过程**：想看 subagent 做了什么，主 agent 用 `read` 读它的会话文件。没有单独的查看工具。
- 前台运行不发通知：主 agent 正在这次调用里等待。
- [`codex-server-compaction`](../codex-server-compaction/README.zh-CN.md) 远程压缩时不会把通知
  当作用户输入保留。通知只在历史末尾追加，所以前缀缓存和 Codex 续接都不受影响。

## 配置 agent

```text
/subagent
```

依次打开可搜索的选择器：选择一个用户 agent、一个当前会话可用的模型（配置了会话模型范围
时只在范围内选），以及该模型支持的思考级别，然后把 `model` 和 `thinkingLevel` 写回 agent
的 frontmatter。下一次运行即生效，无需 `/reload`。重新运行本仓库的安装脚本会用仓库里的
agent 文件替换已安装的，所以想长期保留的改动要先写进 `agents/`。

没有设置 `model` 的 agent 继承主代理的模型和思考级别；设置了 `model` 的 agent 保留自己的
思考级别。

工具描述里会列出每个用户 agent 的名字和说明，模型靠它知道能调用哪些 agent。描述在扩展加载
时生成，所以新增或改名 agent 文件后要 `/reload`。调用不存在的名字会报错，并列出实际存在的
agent。

## Agent 定义

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: "provider/model-id"
thinkingLevel: "high"
---

System prompt for the agent.
```

用户 agent 在 `<agent 目录>/agents/`，项目 agent 在最近的 `.pi/agents/`。

## 工具行和消息

折叠时每个运行一行：状态标记（spinner 运行中、`●` 完成、`✕` 失败、`○` 已停止、`·` 排队），
agent 和任务，以及当前动作，或者耗时和输出 token 数。`Ctrl+O` 展开后显示每个运行的任务、
工具调用、以 Markdown 渲染的答案、用量，以及对话记录所在位置。后台任务完成时显示为同样
布局的卡片。旧版本扩展记录下来的会话也能正常显示。

## 兼容性与验证

在 Pi 0.87.1 上验证。依赖：

- `pi --mode rpc` 及 `--session`（空文件会立即写入会话头，之后每条记录立即追加）、
  `--session-dir`、`--name`、`--model`、`--thinking`、
  `--tools`、`--append-system-prompt`；任务作为 stdin 上的第一条 `prompt` 命令发送，
  `prompt` 的响应为 `success: false` 时运行记为失败；
- 会话事件 `message_start`、`message_update`、`message_end`、`tool_execution_*`、
  `auto_retry_start`、`compaction_start` 和 `agent_settled`；收到 `agent_settled` 后关闭 stdin，
  Pi 随即退出；
- `abort` 命令，以及关闭 stdin 后的有序退出；
- RPC 扩展 UI 请求：`select`、`confirm`、`input`、`editor` 会一直阻塞到收到回答，所以运行器
  一律回答 `cancelled: true`（subagent 没有人可问）；通知和状态更新直接忽略。RPC 模式下子进程
  里的扩展看到的是 `ctx.hasUI === true` 和 `ctx.mode === "rpc"`。扩展直接写到 stdout 的终端
  转义序列（例如 `notify.ts` 的 OSC 通知）在解析前会被去掉。子进程带有 `PI_SUBAGENT_CHILD=1`，
  `subagent` 工具看到它就拒绝 `async: true`；
- 会话文件名 `<时间戳>_<会话 ID>.jsonl` 和其中的 `message` 条目；
- `ctx.ui.onTerminalInput()` 在焦点组件之前执行、具体 TUI 实现的 `getFocusedComponent()`，
  以及 Pi 主输入框带有 `actionHandlers`（面板靠它区分主输入框和对话框）；
- `ctx.ui.setWidget(..., { placement: "belowEditor" })` 和浮层形式的 `ctx.ui.custom()`；
- `pi.sendMessage(..., { triggerTurn: false })`：主 agent 运行时在当前这一轮结束时追加，空闲时
  立即追加。

测试用 Node 24 针对已安装的 Pi 包运行。请在临时副本里运行，并让副本的
`node_modules/@earendil-works` 和 `node_modules/typebox` 指向已安装的包：

```sh
node --test subagent/*.test.ts
```

测试覆盖：用假 RPC 子进程测试运行器（会话参数、任务 prompt、事件、元数据、用户停止与主代理
中断的区别、abort 命令、SIGKILL 升级、被取消的对话框、忽略的通知、混入的转义序列、被拒绝的
prompt 和子进程标记）、后台任务、面板按键处理、1 到 160 列宽度下的渲染、旧格式兼容、对话记录和
历史视图、“选中 → 查看 → 停止 → 历史”的端到端流程、后台状态通知与最终回答、预留的会话
文件，以及用真实子进程验证中途停止的链不会给未运行的步骤留下文件。

交互检查时请直接加载入口文件。传目录的话，因为里面有 `prompts/`，Pi 会把它当成资源包：

```sh
pi --no-extensions -e ./extensions/subagent/index.ts
```
