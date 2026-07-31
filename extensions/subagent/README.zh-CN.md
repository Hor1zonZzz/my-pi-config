# 子代理示例

将任务委派给具有隔离上下文窗口的专用子代理。

[English](README.md) | 中文

## 功能

- **隔离上下文**：每个子代理运行在独立的 `pi` 进程中
- **阻塞或后台执行**：`action: "block"` 等待完成；`action: "background"` 立即返回任务 ID
- **会话任务管理**：`list`、`status` 与 `cancel` 操作用于管理当前 Pi 会话创建的任务
- **TUI 任务查看器**：编辑器下方的紧凑摘要可展开为键盘驱动的任务选择器，并带有实时详情
- **流式输出**：阻塞调用会实时显示工具调用与进度
- **并行流式**：所有阻塞的并行任务同时流式更新
- **Markdown 渲染**：最终输出以正确格式渲染（展开视图）
- **用量跟踪**：显示每个代理的回合数、token、成本与上下文用量
- **中止支持**：Ctrl+C 会传播并终止子代理进程
- **扩展隔离**：代理定义可以禁用自动扩展发现，并显式允许选定的扩展

## 结构

```text
subagent/
├── README.md            # 本文件
├── index.ts             # 精简的扩展入口与生命周期接线
├── tool.ts              # 工具执行、管理操作与注册
├── task-manager.ts      # 会话任务状态、持久化与完成处理
├── viewer.ts            # 编辑器下方的任务选择器与详情浮层
├── agents.ts            # 用户级/项目级代理发现与覆盖逻辑
├── schema.ts            # 工具参数 schema 与执行限制
├── types.ts             # 共享的执行/结果类型
├── runner.ts            # 单个隔离的子 Pi 进程
├── execution.ts         # 单个、并行与链式编排
├── render.ts            # 工具调用与结果的 TUI 渲染
├── scheduler.ts         # 共享的子进程 FIFO 调度器
├── task-storage.ts      # 持久化的任务状态与结果文件
├── settings.ts          # 调度器设置加载器
├── output.ts            # 模型可见输出的截断
├── agents/              # 示例代理定义
│   ├── scout.md         # 快速侦察，返回压缩后的上下文
│   ├── planner.md       # 制定实现计划
│   ├── reviewer.md      # 代码审查
│   └── worker.md        # 受控的实现工具
└── prompts/             # 工作流预设（提示词模板）
    ├── explore-and-gather.md # 并行 scout 仓库探索
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner（不做实现）
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## 安装

在本仓库根目录运行：

```bash
./install.sh
```

安装程序会将 `extensions/subagent/` 复制到目标扩展目录，然后将其嵌套资源复制到 Pi 的发现位置：

- `extensions/subagent/agents/*.md` → `~/.pi/agent/agents/`
- `extensions/subagent/prompts/*.md` → `~/.pi/agent/prompts/`

源路径相对于仓库根目录，因此资源布局具有单一事实来源，不存在根级别的 `agents/` 或 `prompts/` 镜像。

## 代理发现

该工具使用委派的系统提示词与工具/模型配置执行独立的 `pi` 子进程。

每次调用时都会从两个位置发现代理：

- `~/.pi/agent/agents/*.md` 下的用户级代理；
- 从当前工作目录向上找到的最近 `.pi/agents/*.md` 下的项目级代理。

两组代理会自动合并。同名的项目级代理会覆盖用户级代理。父代理不选择发现范围，项目级代理运行时也不需要额外的确认提示。

合并后的代理名称会被注入到 `subagent` 工具描述中，但不包含更长的描述。扩展会在会话启动时，以及每当可用名称集合发生变化时、在每次父代理运行前刷新该工具元数据。

## 用法

### 阻塞式单代理

```json
{
  "action": "block",
  "agent": "scout",
  "task": "Find all authentication code"
}
```

### 后台并行执行

```json
{
  "action": "background",
  "tasks": [
    { "agent": "scout", "task": "Find models" },
    { "agent": "scout", "task": "Find providers" }
  ]
}
```

### 阻塞式链式工作流

```json
{
  "action": "block",
  "chain": [
    { "agent": "scout", "task": "Find the read tool" },
    { "agent": "planner", "task": "Suggest improvements from:\n{previous}" }
  ]
}
```

链式步骤会完整接收上一步的最终文本，不做截断。只有最后一个链式步骤会返回给父代理，上限为 50 KB。

### 任务管理

```json
{ "action": "list" }
{ "action": "status", "taskId": "task_..." }
{ "action": "cancel", "taskId": "task_..." }
```

### 工作流提示词

```text
/explore-and-gather
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## 工具模式

`action` 是可选的。省略时，恰好包含一个有效的 single/parallel/chain 模式的请求默认按阻塞方式执行。如果省略 action 且不是恰好一个模式，工具会返回当前可发现的代理列表（旧的空调用行为）。

| 操作 | 参数 | 说明 |
| --- | --- | --- |
| `block`（或省略） | `{ agent, task }`、`{ tasks }`、`{ chain }` 三者之一 | 持久化任务并等待完成 |
| `background` | 恰好一个执行模式 | 持久化任务，启动/排队后立即返回其 ID |
| `list` | 无 | 列出当前 Pi 会话的任务 |
| `status` | `taskId` | 显示持久化的状态 JSON |
| `cancel` | `taskId` | 取消已排队或正在运行的任务 |

并行模式最多接受 8 个子代理。一个由阻塞与后台调用共享的全局 FIFO 调度器限制实际的子 Pi 进程数。

## 输出显示

**折叠视图**（默认）：

- 状态图标（✓/✗/⏳）与代理名称
- 最近 5-10 项（工具调用与文本）
- 用量统计：`3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`
- 扩展策略：自动发现、无，或显式允许列表（完整来源见展开视图）

**展开视图**（Ctrl+O）：

- 完整任务文本
- 所有工具调用及格式化参数
- 以 Markdown 渲染的最终输出
- 每个任务的用量（用于链式/并行）

**并行模式流式**：

- 显示所有任务及其实时状态（⏳ 运行中，✓ 完成，✗ 失败）
- 随每个任务的进展更新
- 显示 "2/3 done, 1 running" 状态
- 将每个已完成子代理的最终输出返回给父模型，每个子代理上限 50 KB
- 当子进程在产生输出前退出时，返回来自 stderr/错误信息的失败诊断

**后台完成：**

- 已完成的任务会以 `followUp` 注入，并自动触发父代理。
- 父代理繁忙时到达的完成会等待 `agent_settled`；该次运行期间累积的所有
  完成会被合并为一条 follow-up。
- 单代理最多返回 50 KB/2,000 行；并行模式对每个子代理应用该上限；链式
  只返回其最后一步，适用同样的上限。

## TUI 任务查看器

当前会话创建第一个子代理任务后，Pi 会在输入编辑器下方显示紧凑摘要。Pi 的正常历史顺序被保留：Down 从较旧的提示移动到最新提示，然后恢复当前草稿。当光标已经位于该草稿底部、Down 无法继续移动时，再按一次 Down 会打开任务选择器。

- 每一行代表一个持久化任务；并行与链式子任务出现在该任务的详情视图中。
- 任务按最新优先排序，并在排队、运行或完成时更新。
- Up/Down 移动选择，Enter 打开详情浮层，Escape 返回编辑器。在第一行按
  Up 也会返回编辑器。
- `/subagents` 直接打开选择器，是不暴露光标与自动补全状态的自定义编辑器
  的回退方案。
- 详情为只读，预览限制在 50 KB/2,000 行。完整输出可在显示的 `result.md`
  与 `details.json` 路径中获取。
- 查看器仅显示当前 Pi 会话的任务。它不支持终端鼠标点击；请使用 Enter
  打开任务。

## 任务文件

每次阻塞与后台调用都会在以下位置写入完整输出：

```text
<cwd>/.pi/subagent-tasks/<sessionId>/<taskId>/
├── status.json
├── result.md
└── details.json
```

`result.md` 包含每个子代理的完整最终文本。`details.json` 包含结构化消息、stderr、用量、模型与退出信息。这些文件不会被自动删除。

## 调度器设置

全局设置位于 `~/.pi/agent/subagent-settings.json`：

```json
{
  "version": 1,
  "maxConcurrentProcesses": 4,
  "maxQueuedProcesses": 16
}
```

设置在会话启动时读取。没有任务超时。队列按子进程请求以 FIFO 排列；一个大型并行任务可能会先于之后的任务占满队列。

**工具调用格式**（模仿内置工具）：

- `$ command` 表示 bash
- `read ~/path:1-10` 表示 read
- `grep /pattern/ in ~/path` 表示 grep
- 等等

## 代理定义

代理是带有 YAML frontmatter 的 Markdown 文件：

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
# 省略 extensions 以保留正常的扩展发现。
# 使用 `extensions: none` 不加载任何发现的扩展，或使用 YAML 数组
# 仅加载显式的 Pi 扩展来源。
extensions:
  - npm:pi-lens
  - ../extensions/my-extension.ts
---

代理的系统提示词写在这里。
```

**位置：**

- `~/.pi/agent/agents/*.md` — 用户级
- `.pi/agents/*.md` — 从工作目录向上找到的最近的项目级目录

两个级别始终都会被加载，项目级代理覆盖同名的用户级代理。

### 扩展隔离

可选的 `extensions` frontmatter 控制子 Pi 进程的扩展发现：

```markdown
# 省略：保留正常的自动扩展发现。

extensions: none # 传递 --no-extensions。

extensions:
  - npm:pi-lens # 传递 --no-extensions -e npm:pi-lens。
  - ../extensions/my-extension.ts
```

显式数组会先禁用自动扩展发现，然后只加载列出的 Pi 扩展来源。本地 `./` 与 `../` 路径相对于代理定义文件解析；诸如 `npm:` 和 `git:` 的包来源会原样传递给 Pi。无效的配置值会使代理调用失败，而不是静默加载所有扩展。

`tools` 是独立的允许列表：它控制模型可以调用哪些工具，但不会阻止已加载扩展的命令或生命周期处理器。扩展来源会在子 Pi 启动时执行代码，因此请只使用来自你信任的仓库的项目本地代理与来源。该设置不会禁用技能、提示词模板或上下文文件。

## 示例代理

| 代理 | 用途 | 模型 | 工具 | 扩展 |
| --- | --- | --- | --- | --- |
| `scout` | 快速代码库侦察 | Luna | read, grep, find, ls, bash | 自动发现 |
| `planner` | 实现计划 | Sol | read, grep, find, ls | 自动发现 |
| `reviewer` | 代码审查 | Sol | read, grep, find, ls, bash | 自动发现 |
| `worker` | 通用实现 | Sol | read, bash, edit, write, lsp_diagnostics | 仅 `npm:pi-lens` |

## 工作流提示词

| 提示词 | 流程 |
| --- | --- |
| `/explore-and-gather` | 并行 scout 探索不同的仓库目录并收集上下文 |
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## 错误处理

- **退出码 != 0**：任务失败，stderr/输出记录在其结果文件中
- **stopReason "error"**：LLM 错误会被传播并持久化
- **stopReason "aborted"**：取消时发送 `SIGTERM`，如有需要 5 秒后发送 `SIGKILL`
- **链式模式**：在第一个失败的步骤处停止
- **会话关闭**：已排队/运行中的任务被取消；陈旧的运行中状态会在下一次
  会话启动时被标记为 `interrupted`
- **会话树导航**：当当前会话存在已排队或运行中的子代理任务时，`/tree`
  会被阻止

## 限制

- 折叠视图中输出截断为最近 10 项（展开可查看全部）
- 模型可见输出上限为每个子代理 50 KB 或 2,000 行，以先到者为准；完整
  结果保留在任务文件中
- 链式 `{previous}` 传递有意不设上限，可能超出后续代理的上下文窗口
- 每次调用都会重新发现代理（允许在会话中途编辑）
- 并行模式限制为 8 个子代理
- 调度器限制仅在单个父 Pi 进程内生效；不同的 Pi 进程之间不协调配额
