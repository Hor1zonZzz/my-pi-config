# my-pi-config

我的 [Pi Coding Agent](https://github.com/earendil-works/pi) 公开、可复现的个人配置。

[English](README.md) | 中文

## 包含内容

- `settings.json` — 默认思考等级、主题与可安装的 Pi 包（不指定默认模型，安装时保留本机已选的默认模型），包括 Herdr 工具集成、Pi Voice（本地语音转文字，提供录音快捷键和 `transcribe_file` 工具）、[`pi-subagent`](https://github.com/badlogic/pi-subagent)（在 tmux 中运行、可观察的 subagent，通过 `subagent` 命令行和其自带技能驱动），以及 [`pi-cliproxyapi-provider`](https://www.npmjs.com/package/@router-for-me/pi-cliproxyapi-provider)（注册 CLIProxyAPI 模型，通过 `/login cliproxyapi` 配置）。Pi 0.99.0 起内置 MCP 支持，本仓库不再包含独立的 MCP 适配器。
- `extensions/` — 本地扩展
- `prompts/` — 本地通用提示词模板，包括可手动选择是否探索仓库的 `/understand` 与 `/explore-understand`
- `skills/` — 远端受管的技能缓存；Herdr 会在安装期间从其上游 Git 仓库刷新
- `install.sh` + `install-cli.mjs` — 支持交互式空格多选与命令行参数的备份及安装脚本，安装到 `~/.pi/agent`

## 回复样式

[`pi-emphasis`](https://github.com/johnlindquist/pi-emphasis) 作为外部包安装，需要 Pi 1.5 或更新版本，为终端回复添加彩色状态标签、图标和粗体强调色。保留插件默认设置，包括回复格式规则（约 1,500 个提示词 tokens）；在启动 Pi 前设置 `PI_EMPHASIS_GUIDANCE=0` 可关闭规则但保留渲染。图标和圆角端帽需要 Nerd Font 符号；设置 `PI_EMPHASIS_PILL_ICONS=0` 和 `PI_EMPHASIS_ROUND_CAPS=0` 可改用无图标方形标签。

## 本地扩展

- `questionnaire.ts` — Pi 官方的交互式多问题工具示例
- `notify.ts` — 整个运行结束（`agent_settled`）后的终端通知
- `esc-clear/` — 空闲时输入框里有内容，500 毫秒内连按两次 Esc 清空；编辑器的撤销（`ctrl+-`）可以恢复。Esc 的其他用途不变：中断运行、关闭补全菜单和选择器，以及 Pi 自带的空输入框双击 Esc
- `herdr/` — 统一持有本地 Herdr 集成检查器、异步 `herdr_agent prompt` 监控器和 `herdr-pi-reference` 技能源码；它让显式 `wait: false` 调用保持非阻塞，并注入会话级完成 follow-up
- `background-task/` — 为每个 session 提供位于 `~/.pi/agent/scratchpad/<session-id>/` 的 scratchpad 目录，并新增 `background_task` 与 `monitor` 工具：长耗时 shell 命令在后台运行、不阻塞主循环，结束时以 steer 消息把退出码和日志末尾送回会话；在 TUI 与 RPC 会话中还会接管 `bash`，默认在前台等待完成，但一旦有新的用户插话消息（steer）到达就立刻原地转入后台运行（不杀进程），也可通过 `PI_BASH_BACKGROUND_AFTER_MS` 额外开启超时自动转后台；`/bg` 和底栏 `bg`/`mon` 入口可列出、查看输出或停止任务（[详细说明](extensions/background-task/README.md)）
- `memory/` — 按项目的记忆：注入记忆的用途和在 session 开始时冻结的笔记索引（不破坏 prompt cache），提供 `memory` 工具（Anthropic memory tool 命令，路径为 `/memories`），以及 Dream（DeepSeek Flash agent 会话逐个读历史会话核对笔记，再整体整理）；`/memory` 打开类似 `/settings` 的面板，管理开关、笔记、Dream 和模型调用历史（[详细说明](extensions/memory/README.md)）
- `codex-statusline/` — 在 Codex TUI 中自动显示当前账号与周额度剩余比例；`openai` ChatGPT 登录时显示其账号、邮箱相同的 Codex 登录的周额度以及额度用尽状态；同一 agent 目录内的 session 共享五分钟账号/用户额度缓存（[详细说明](extensions/codex-statusline/README.zh-CN.md)）

## Pi 兼容性

本地扩展适配 Pi 0.87.0。包括 `openai-codex` 在内，所有提供方都使用 Pi 内置的压缩。

## 安装

运行安装脚本前请先审查本仓库。扩展以与 Pi 相同的权限执行。

```bash
git clone https://github.com/Hor1zonZzz/my-pi-config.git
cd my-pi-config
./install.sh
```

在交互式终端中直接运行 `./install.sh` 会打开空格多选界面（初始默认全不选，已装项标注 `[已安装]`，采用同步模式；相互依赖的组件已打包为套装）：

- **打包套装（`[套装]`）**：
  - `herdr` — `extensions/herdr/` + `npm:@ogulcancelik/pi-herdr` 包 + `skills/herdr` 与 `skills/herdr-pi-reference`
  - `inline-chart` — `extensions/inline-chart/` + Rust `inline-chart-engine` 渲染引擎
  - `pi-subagent` — `git:github.com/badlogic/pi-subagent` 包 + `bin/subagent` CLI 软链
- **独立可选组件**：其余本地扩展（`background-task`、`btw`、`codex-statusline`、`esc-clear`、`memory`、`notify`、`questionnaire`、`tps`）、外部包（`pi-annotate`、`pi-voice`、`pi-cliproxyapi-provider`、`pi-emphasis`）和提示词模板（`understand`、`explore-understand`）均可单独勾选。
- **快捷键**：`↑`/`↓` 或 `j`/`k` 移动，`Space` 勾选/取消，`a` 全选/清空，`i` 载入当前已安装项，`Enter` 确认（若将移除已安装项会先显示预览并二次确认），`q`/`Esc` 退出。

同时支持命令行参数（非 TTY 环境不带参数时默认等同 `--all`）：

```bash
./install.sh --list                               # 查看所有组件、套装内容及当前安装状态
./install.sh --all                                # 全量安装（同步模式）
./install.sh --only memory,btw,esc-clear          # 仅保留选中项，其余本仓库组件先备份再移除（同步模式）
./install.sh --add inline-chart,pi-subagent       # 增量安装/更新指定项，不动其他已安装组件
./install.sh --all --exclude herdr,pi-voice       # 全量安装但排除指定项
./install.sh --remove pi-emphasis                 # 仅移除指定本仓库组件（先备份），保留其他项
```

`<列表>` 支持逗号分隔或重复传入，也支持分组别名：`all`、`extensions`、`packages`、`prompts`。

安装程序会在替换或移除受管文件之前，在 `~/.pi/agent/backups/` 下创建带时间戳的备份。它不设置模型覆盖项，不会修改本机的 `models.json`，并会保留 `settings.json` 中非本仓库管理的第三方包。仅当选中 `herdr` 时，才会从上游 `master` 分支刷新 Herdr 技能并安装 `herdr` 与 `herdr-pi-reference` 技能（远端不可用时回退本地缓存）；当 Pi 在 Herdr 内启动时，本地集成检查器会在 Herdr 的 Pi 集成缺失或过旧时发出警告，绝不会自动安装或更新由 Herdr 管理的集成。同步模式下还会先备份、再删除已退役的 `extensions/plan-mode/`、`extensions/code-mode/`、`extensions/hairline/`、`extensions/codex-fast-toggle/`、`extensions/codex-server-compaction/`、`extensions/codex-accounts/`、旧的全局 `codex-fast.json`、已退役的外部 `pi-openai-server-compaction` Git 包 checkout 以及旧本地 subagent 扩展及其代理与工作流提示词。仅当选中 `pi-subagent` 时，才会把 `~/.pi/agent/bin/subagent` 链接到 `pi-subagent` 包的 checkout（`pi-subagent` 需要 tmux 和 Node.js 22.19 或更新版本）。重启 Pi 或运行：

```text
/reload
```

`settings.json` 中声明的包依赖由 Pi 在启动时安装。请单独完成身份认证；本仓库有意不包含凭据。

安装脚本会仅对本次选中且需要自动更新的包（Pi Voice、`pi-subagent`、`pi-cliproxyapi-provider`、`pi-emphasis`）运行 `pi update --extension`：未安装时直接安装，已安装时更新到最新版；更新失败只打印警告，不会中断安装。

仅当选中 `inline-chart` 时，安装脚本才会同步（或在缺少预编译产物时编译）本地 `inline-chart` 的 Rust 渲染引擎到 `~/.pi/agent/extensions/inline-chart/bin/inline-chart-engine`，并清理旧的 `mpl` 扩展。

安装脚本会保留 Pi 用于 ChatGPT 登录的运行时 `deviceId` 和本机已选的默认 provider 与模型，并保留已退役的 `/codex-accounts` 扩展留下的两套本机账号库。

## 常用命令

```text
/understand [requirement]
/explore-understand [requirement]
```

`/subagent`（来自 `pi-subagent`）用于选择运行中的 subagent 并接入它的 tmux 会话。

`/understand` 直接澄清需求；`/explore-understand` 会明确先对仓库进行有针对性的只读探索。两者都会在开始实现前等待确认。

## 安全

本仓库有意排除凭据、会话、MCP 配置、信任决策、缓存、历史记录、`node_modules` 以及由 Herdr 管理的集成文件。绝不要提交 `~/.pi/agent/auth.json` 或原始的本地 `models.json`。

## 署名与许可证

部分扩展改编自 Pi 的官方示例。Pi 的许可证包含在 `licenses/pi-LICENSE` 中。
