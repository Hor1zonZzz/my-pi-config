# Code mode

[English](README.md) | 中文

`/tools` 可以开关任意已注册的工具，并切换 code mode。code mode 用一个
`execute_code` 工具替换 Pi 中已开启的内置工具（`read`、`bash`、`edit`、`write`、
`grep`、`find`、`ls`）：模型编写 JavaScript（Node.js）或 Python 3 程序，这些工具只
作为程序里全局 `tools` 对象上的函数存在。只有程序打印的内容会
回到模型，循环、过滤和汇总都在代码里完成，中间结果不必逐个经过上下文。

思路参考 Cloudflare 的 [Code Mode](https://blog.cloudflare.com/code-mode/) 和
Anthropic 的 [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)。
按 Pi 维护者的建议以扩展实现：Pi 核心没有 code mode，扩展也无法调用其他扩展的
工具，所以只包装内置工具。

## 使用

```text
/tools              选择器：code mode、sandbox、language，以及每个已注册工具各一个开关
/code-mode          切换 code mode
/code-mode on|off
pi --code-mode      新会话默认开启 code mode
```

在 `/tools` 中，↑/↓ 选择，Enter 或空格切换，输入文字可过滤，Esc 关闭。修改立即
生效。前三行是 code mode、[沙箱](#沙箱)和[语言](#语言)，接着是内置工具，然后是其他所有已注册工具（`subagent`、
`questionnaire`、`herdr_agent`、MCP 等），`execute_code` 本身除外。

- **code mode 关闭**：所有开启的工具都是普通活动工具。
- **code mode 开启**：所有开启的内置工具移入 `execute_code`（该行显示 `code`），
  其他开启的工具仍是普通工具。开关某个内置工具会改变程序可以调用的函数。直接调用
  内置工具会被拦截。
- **再次关闭 code mode**：所有开启的工具作为普通工具归还。

选择保存在当前会话分支中（`tools-state` 自定义条目），与 `/fast` 相同，在恢复会话、
`/reload` 和树导航时还原。保存的内容是 code mode、沙箱、语言、开启的内置工具，以及被你
关闭的其他工具。除此之外，其他工具保持 Pi 和所属扩展决定的激活状态：之后注册的工具默认开启，
扩展有意保持不活动的工具（例如 `pi-mcp-adapter` 在搜索前的 MCP 工具）不会被强制开启；
在 `/tools` 中开启它会立即激活。没有保存选择的分支从 Pi 当前的活动工具和
`--code-mode` 开始。code mode 开启时 footer 显示 `code mode · js` 或
`code mode · python`，沙箱关闭时再加上 `· unsandboxed`。

### 语言

`execute_code` 同一时间只接受一种语言：**JavaScript**（默认）或 **Python**，在
`/tools` 中选择，按会话分支保存。该工具没有 `language` 参数，模型无法选择另一种：
工具描述、API 签名（`tools.read({ path, offset?, limit? }) → string` 或
`tools.read(path, offset=None, limit=None) -> str`）、单行摘要和指引都只描述选中的
语言，所有程序都用对应的解释器运行。切换语言会在下一次请求前重新注册 `execute_code`。

这里固定的是 `execute_code` 程序的语言，而不是程序通过 `tools.bash` 执行的命令：
shell 仍然可以启动 `python3` 或 `node`。需要程序严格只用一种语言时，请在 `/tools`
中关闭 `bash`。

### 提示词

每当 `execute_code` 内的内置工具集合变化，就重新注册 `execute_code`，使模型读到的
所有内容都恰好覆盖这个集合：工具描述及生成的 API 参考、单行工具摘要，以及系统提示中
的指引。关闭的工具既不活动也不出现在文档中。Pi 只有在 `read` 或 `bash` 是活动工具时
才列出技能；code mode 下由扩展补上该列表，并提示模型在 `execute_code` 中用
`tools.read`（`read` 关闭时用 `tools.bash`）加载技能。

## 程序

```js
// 选择 JavaScript 时：支持 top-level await 的 ES module
const files = (await tools.find({ pattern: "src/**/*.ts" })).split("\n");
const texts = await Promise.all(files.map((path) => tools.read({ path })));
console.log(files.filter((_, i) => texts[i].includes("TODO")));
```

```python
# 选择 Python 时：同步调用，支持关键字参数或 dict
for path in tools.find(pattern="src/**/*.py").splitlines():
    if "TODO" in tools.read(path=path):
        print(path)
```

- 每次调用接收一个参数对象，先按该工具自己的 schema 校验，再执行 Pi 自己的工具
  实现，返回其文本输出。
- 调用失败会抛出 `ToolError`（消息为工具的错误文本；`bash` 的非零退出也会抛出，
  消息中包含命令输出）。
- 通过 `tools.read` 读取的图片会附加到 `execute_code` 的结果中（最多 8 张）。
- 输出为 stdout 与 stderr 合并，按 Pi 通常的 2000 行 / 50KB 保留末尾。被截断时，
  完整输出保存到临时文件，并把路径告诉模型。
- 非零退出、超时（可选 `timeout`，单位秒）或中断都会把结果标记为失败。程序在自己的
  进程组中运行，超时、中断以及程序退出后都会结束该进程组；程序没有等待完成的工具
  调用会被取消。

工具描述中的 API 参考由内置工具定义生成，因此与 Pi 的描述和 schema 保持一致。

## 沙箱

**Sandbox** 开启时（默认开启，按会话分支保存），`execute_code` 程序运行在 macOS
Seatbelt 沙箱（`/usr/bin/sandbox-exec`）中，程序只能通过 `tools.*` 接触外部，而
`tools.*` 由 Pi 在沙箱外作为普通内置工具执行。在沙箱中程序：

- 不能读取 `/Users`（家目录和项目）、`/Volumes`、`/private/tmp`、`/private/var/folders`
  下的文件内容，解释器自身的安装目录和本次运行目录除外；文件元数据（`stat`）仍可见；
- 除本次运行目录（`$TMPDIR`，运行后删除）和 `/dev/null` 外不能写入；
- 没有网络（TCP、UDP、DNS、Unix socket）；
- 不能启动进程、fork、向其他进程发信号、查找 Mach 服务或发送 Apple Events（后者可能
  让沙箱外的应用代为执行）；
- 只能看到 `PATH=/usr/bin:/bin`、`HOME=$TMPDIR`、`TMPDIR`、locale 和桥接变量，看不到
  Pi 的环境变量或其中的密钥。

只能导入 Node 内置模块、Python 标准库，以及安装在解释器自身前缀中的包；项目的
`node_modules`、解释器之外的虚拟环境和工作目录都不可读。解释器会解析到真实安装位置
（例如 uv 的 Python 或 nvm 的 Node）并直接启动；会暴露家目录的安装路径会被拒绝。
工具描述会把这些限制告诉模型。

沙箱失败时关闭：不在 macOS 或没有 `sandbox-exec` 时不会运行程序，错误信息会提示在
`/tools` 中关闭 Sandbox。关闭 Sandbox 后程序以你的权限无沙箱运行，footer 显示
`code mode · unsandboxed`。

沙箱限制的是程序，不是工具：`tools.bash` 仍能执行任意 shell 命令，`tools.write` 仍能
写入 Pi 能写的任何位置。需要只能读取、搜索和编辑的程序时，请在 `/tools` 中关闭这些工具。

## 设计

| 部分 | 文件 |
|---|---|
| 工具选择状态、`/tools`、`/code-mode`、`--code-mode`、活动工具切换、`execute_code`（重新）注册、技能提示、直接调用拦截 | `index.ts` |
| `/tools` 选择器 | `panel.ts` |
| 内置工具构建、API 参考生成、调用分发 | `tools.ts` |
| 子进程、JSON-lines 桥接、超时/中断、输出收集 | `runtime.ts` |
| Seatbelt 规则、解释器解析、沙箱命令与环境 | `sandbox.ts` |
| 子进程侧的 `tools` 对象 | `prelude.mjs`、`prelude.py` |
| 调用与结果渲染 | `render.ts` |

- 程序写入临时文件，用运行 Pi 的 Node（或 `PATH` 中的 `node`）或 `python3` 执行。
  请求经 fd 3 发给 Pi，响应经 fd 4 返回；stdout 和 stderr 完全属于程序。
- 内置工具通过 `create*ToolDefinition()` 创建，并使用与 Pi `AgentSession` 相同的
  设置（图片缩放、shell 路径、命令前缀、项目信任），与 `hairline/` 的做法一致。
  参数在执行前经过工具的 `prepareArguments` 和 Pi 的 `validateToolArguments`。
- Pi 会替换重新注册的工具，并在下一次请求前把工具和提示词的变化追加到会话记录中。

## 限制

- 沙箱仅支持 macOS，依赖 `sandbox-exec`；Apple 将其标为弃用，但仍随系统提供并在使用。
  它限制的是程序能做什么，而不是已开启的工具能做什么。
- 程序内部发起的调用不会触发 Pi 的 `tool_call`/`tool_result` 事件，也不会成为单独
  的会话记录，因此依赖这些事件进行拦截或观察的扩展看不到它们。`execute_code` 调用
  本身照常被观察。
- 没有包装 PowerShell；在 Windows 上 `bash` 的行为与 Pi 的 bash 工具相同。
- 针对直接调用 shell 和编辑工具训练较多的模型，在简单编辑上可能多花几轮。设为默认
  之前请用真实任务对比。

## 验证

测试会导入 Pi 的宿主包，因此请在一个临时副本中运行，并让其 `node_modules` 指向
已安装的 Pi 包（不要给本仓库添加依赖）：

```sh
node --test code-mode/*.test.ts
tsc -p tsconfig.json   # strict、NodeNext、allowImportingTsExtensions、noEmit
```

测试覆盖 JavaScript 与 Python 程序（并发、关键字/dict 参数、`ToolError`、traceback、
import、正常退出）、超时与中断、输出截断到临时文件、找不到解释器、沙箱（直接读取、写入、
网络、子进程和信号被拦截，工具调用和临时文件可用，看不到宿主环境变量，安装目录检查、
非 macOS 拒绝运行和超时）、生成的 API 参考、
真实内置工具（含图片）、在切换、`/tools` 修改、键盘输入、重载、树导航、`--code-mode`
和后注册工具下的工具计划与保存的选择、跟随 `execute_code` 内置工具集合的提示词、直接
调用拦截、技能提示、`execute_code` 端到端结果与失败，以及 1 到 160 列宽度下的渲染与
选择器。

交互检查：运行 `pi --no-extensions -e ./extensions/code-mode`，打开 `/tools`，
开启 code mode 并关闭一个内置工具，让模型完成一个需要读取和编辑文件的任务，在 `execute_code` 行上
切换 `ctrl+o`，在长时间运行的程序中按 Esc，再关闭 code mode 确认已开启的内置工具恢复。
