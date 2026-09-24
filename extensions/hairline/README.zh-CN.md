# Hairline 素线皮肤

[English](README.md) | 中文

安静的 Pi 终端皮肤：灰色细线，只用一道薄荷到天蓝的渐变做强调。它替换启动 Header、
输入框上下横线、footer 和工具调用行，并在输入框上方加一行 HUD，显示回复速度和 Codex 周额度。配色由扩展自己
绘制（真彩色），为 Ghostty 这类深色终端设计；终端不支持真彩色时退回最接近的 256 色。

```text
  ████████   pi 0.87.1                                       gpt-5.6-sol · medium
   ██  ██    ~/workspace/my-pi-config  main
  ▄█▀  ██▄   escape interrupt   / commands   ! bash   ctrl+o more

  ●  read  AGENTS.md:1-5                                           5 of 180 lines

  ⠼  bash  bash -n install.sh && git diff --check              running · 1.5s
     ╰ checking install.sh

  speed    ▁▁▁▁▁▁▁▁▁▁▁▁▂▅█▆  51 tok/s       weekly  ━━━━━━━━━━━━━───────  63% left
─ ⠼ Thinking · 12s ───────────────────────────────────────────────────────────

─ gpt-5.6-sol · medium ───────────────────────── context ▰▰▰▰▱▱▱▱▱▱ 42% ─
  ~/workspace/my-pi-config  main       ↑12k ↓3.1k  ·  $0.000 sub  ·  <其他状态>
```

用户消息和回复正文仍由 Pi 渲染，沿用当前主题；扩展只能通过主题改它们的颜色。

## 改动范围

| 部位 | Pi API | 效果 |
| --- | --- | --- |
| Header | `ctx.ui.setHeader()` | 三行渐变 π、版本、模型 · 思考级别、cwd 与分支、快捷键提示。 |
| 输入框 | `CustomEditor` 子类 | 只改上下两条横线，没有左右边框和圆角。下横线显示模型 · 思考级别和上下文刻度。输入 `!` 进入 bash 模式时横线变成薄荷色。 |
| 工作状态 | `embedWorkingStatus` | 上横线显示 `Thinking`、`Writing` 或 `Running <工具>`、本次运行耗时和工具出错次数，标签上有一道流光。重试、压缩、分支总结沿用 Pi 自己的文字。 |
| HUD | 输入框上方的 `ctx.ui.setWidget()` | 最近 16 条回复的速度曲线和当前 tok/s，以及 Codex 周额度剩余进度条。 |
| Footer | `ctx.ui.setFooter()` | cwd 与分支、`↑输入 ↓输出`、费用（订阅模型标 `sub`），以及其他扩展的全部状态。一行放不下时，状态移到第二行。 |
| 工具调用行 | 重新注册 `read`、`bash`、`edit`、`write` | 单行卡片；`ctrl+o` 展开后显示 Pi 原生的完整输出。 |

## 命令

```text
/hairline            查看当前状态
/hairline on|off     开关皮肤
/hairline hud on|off 显示或隐藏 HUD 行（不要 HUD 的纯皮肤）
```

状态只在当前 Pi 进程内有效；重启 Pi 或 `/reload` 后皮肤和 HUD 都恢复为开启。
`/hairline off` 之后，新的工具行使用 Pi 原生渲染，已有的行在下次重绘时切换；
工具覆盖本身会一直注册着，直到移除扩展并重新加载。

## 速度的算法

速度 = 一条回复的输出 token 数 ÷ 从 `message_start` 到 `message_end` 的时间，
包含首字延迟。被中止、出错或短于 0.25 秒的回复不计入。最多保留 64 个值，画出
最近 16 个，按可见范围内的最大值缩放。每个 session 开始和 `/reload` 后历史清空；
恢复的旧消息没有计时信息。

## 周额度

周额度进度条读取 [`codex-statusline`](../codex-statusline/README.zh-CN.md) 写入 footer
的 `codex-quota` 状态（`me@example.com · weekly 63% left`），所以不会额外请求额度，
和它共用五分钟的共享缓存。`loading` 和 `unavailable` 以文字显示，过期数据标
`(stale)`，剩余 25% 以下变琥珀色，10% 以下变红色。没有这条状态时（例如非 Codex
模型，或没装 `codex-statusline`）不显示进度条。footer 里仍保留完整的状态文字。

## 工具调用行

- **执行仍是 Pi 的。** 每次调用都用 Pi 的内置工具定义执行，按调用时的 cwd 创建，
  并带上 Pi 给自己工具的同一组设置：`read` 的 `images.autoResize`，`bash` 的
  `shellPath` 和 `shellCommandPrefix`。只有 `ctx.isProjectTrusted()` 为真时才读取
  项目设置。定义按 cwd 和信任状态缓存，session 开始时清空，所以改设置后要
  `/reload` 才生效，和 Pi 自己的工具一样。
- **模型看到的完全不变。** 名称、描述、参数 schema、提示片段、使用准则、约束采样
  和参数预处理都从 Pi 的定义复制，`tools.test.ts` 会逐项比较。
- **折叠行**显示状态标记、工具名、参数（路径相对 cwd，read 范围写成
  `file:120-159`，命令压成一行）和右对齐摘要：read 显示 `N lines` 或
  `N of M lines`，edit 显示 `+新增 −删除` 和五个小方块，write 显示写入行数，
  bash 显示运行时长或退出码加耗时。运行中的命令显示最后一行输出，失败时显示相关
  的错误行。
- **展开行**（`ctrl+o`）用 Pi 自己的渲染器和独立状态，语法高亮、diff、截断提示
  都保持原样。
- 只覆盖 Pi 默认启用的四个工具。`grep`、`find`、`ls` 不动，因为注册它们会在
  `/reload` 时把它们启用。同理，如果你停用了 `read`、`bash`、`edit` 或 `write`，
  `/reload` 会把它们重新启用。

## 兼容性

在 Pi 0.87.1 上验证。升级 Pi 时需要复查：

- `CustomEditor` 受保护的 `renderTopBorder()` 和 `Editor.renderBottomBorder()`
  钩子、`embedWorkingStatus`，以及状态指示器的 `kind` 和 `renderInBorder()`。
  指示器类型没有导出，这里按鸭子类型使用。
- 工具渲染约定：`renderShell: "self"`、共享的 `context.state`、复用
  `lastComponent`。Pi 的 bash 渲染器在命令未结束时会在自己的状态上挂一个每秒
  刷新的定时器，收到最终结果时清除；行折叠后，Hairline 会把最终结果交给它一次。
- Pi 的 `AgentSession` 传给 `createReadToolDefinition()` 和
  `createBashToolDefinition()` 的选项。如果 Pi 新增了来自设置的选项，要同步加到
  `tools.ts` 的 `createBaseTool()`。
- `codex-statusline` 的状态键 `codex-quota` 和 `weekly N% left` 文案。`index.test.ts`
  会把它真实的 `formatStatus()` 输出交给 `parseWeekly()` 解析。
- `SettingsManager.create()` 读取时会加文件锁，所以工具定义做了缓存，而不是每次
  调用都重建。

## 验证

测试会导入 Pi 的宿主包和 `../codex-statusline`，请在临时副本里运行：副本里放这两个
扩展目录，并让 `node_modules/@earendil-works` 指向已安装的 Pi 包（不要给本仓库添加
依赖）：

```sh
node --test hairline/*.test.ts
tsc -p tsconfig.json   # strict、NodeNext、allowImportingTsExtensions、noEmit
```

测试覆盖 1 到 200 列的宽度安全、输入框横线、工作状态、footer 换行、HUD 速度统计和周额度解析、
单行工具卡片、模型可见的工具定义、bash 的设置与项目信任处理、展开和关闭时交回
Pi 渲染器，以及 bash 刷新定时器的清理。

交互检查：运行 `pi --no-extensions -e ./extensions/hairline`，发一条会用到 `read`
和 `bash` 的提示，按 `ctrl+o` 展开和折叠，把终端缩窄，同时加载 `./extensions/codex-statusline`
查看周额度进度条，再试
`/hairline hud off`、`/hairline off` 和 `/hairline on`。
