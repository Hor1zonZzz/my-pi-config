# my-pi-config

我的 [Pi Coding Agent](https://github.com/earendil-works/pi) 公开、可复现的个人配置。

[English](README.md) | 中文

## 包含内容

- `settings.json` — 模型默认值与可安装的 Pi 包，包括 Herdr 工具集成、Pi Voice（本地语音转文字，提供录音快捷键和 `transcribe_file` 工具），以及 [`pi-subagent`](https://github.com/badlogic/pi-subagent)（在 tmux 中运行、可观察的 subagent，通过 `subagent` 命令行和其自带技能驱动）。Pi 0.99.0 起内置 MCP 支持，本仓库不再包含独立的 MCP 适配器。
- `model-overrides.json` — 受管理的、不含凭据的内置模型覆盖项
- `extensions/` — 本地扩展
- `prompts/` — 本地通用提示词模板，包括可手动选择是否探索仓库的 `/understand` 与 `/explore-understand`
- `skills/` — 远端受管的技能缓存；Herdr 会在安装期间从其上游 Git 仓库刷新
- `install.sh` — 备份并安装到 `~/.pi/agent`

## 本地扩展

- `questionnaire.ts` — Pi 官方的交互式多问题工具示例
- `notify.ts` — 整个运行结束（`agent_settled`）后的终端通知
- `herdr/` — 统一持有本地 Herdr 集成检查器、异步 `herdr_agent prompt` 监控器和 `herdr-pi-reference` 技能源码；它让显式 `wait: false` 调用保持非阻塞，并注入会话级完成 follow-up
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

安装程序会在替换受管文件之前，在 `~/.pi/agent/backups/` 下创建带时间戳的备份。它会将 `model-overrides.json` 合并进目标 `models.json`，保留所有无关的本地提供方、凭据与模型设置。它还会从上游 `master` 分支刷新 Herdr 技能，将其安装到 `~/.pi/agent/skills/herdr/`，并把 Herdr 扩展持有的 `herdr-pi-reference` 技能安装到 `~/.pi/agent/skills/herdr-pi-reference/`；当远端暂时不可用时，会使用已有的 Herdr 缓存。当 Pi 在 Herdr 内启动时，本地集成检查器会在 Herdr 的 Pi 集成缺失或过旧时发出警告；它绝不会自动安装或更新由 Herdr 管理的集成。迁移期间还会先备份、再删除已退役的 `extensions/plan-mode/`、`extensions/code-mode/`、`extensions/hairline/`、`extensions/codex-fast-toggle/`、`extensions/codex-server-compaction/` 与 `extensions/codex-accounts/`、旧的全局 `codex-fast.json` 状态文件以及已退役的外部 `pi-openai-server-compaction` Git 包 checkout。它还会删除以前的本地 subagent 扩展及其安装的代理（`planner`、`reviewer`、`scout`、`worker`）和工作流提示词，并把 `~/.pi/agent/bin/subagent` 链接到 `pi-subagent` 包的 checkout，使 `subagent` 命令出现在 Pi bash 的 `PATH` 中；Pi 安装该包后链接即生效。`pi-subagent` 需要 tmux 和 Node.js 22.19 或更新版本。重启 Pi 或运行：

```text
/reload
```

`settings.json` 中声明的包依赖由 Pi 在启动时安装。请单独完成身份认证；本仓库有意不包含凭据。

安装脚本会保留 Pi 用于 ChatGPT 登录的运行时 `deviceId`，并保留已退役的 `/codex-accounts` 扩展留下的两套本机账号库。

## 常用命令

```text
/understand [requirement]
/explore-understand [requirement]
```

`/subagent`（来自 `pi-subagent`）用于选择运行中的 subagent 并接入它的 tmux 会话。

`/understand` 直接澄清需求；`/explore-understand` 会明确先对仓库进行有针对性的只读探索。两者都会在开始实现前等待确认。

## 安全

本仓库有意排除凭据、会话、MCP 配置、信任决策、缓存、历史记录、`node_modules` 以及由 Herdr 管理的集成文件。绝不要提交 `~/.pi/agent/auth.json` 或原始的本地 `models.json`。

`model-overrides.json` 是受管配置，而不是 `models.json` 的副本；它只包含不含凭据的模型覆盖项，由安装程序合并进本地文件。

## 署名与许可证

部分扩展改编自 Pi 的官方示例。Pi 的许可证包含在 `licenses/pi-LICENSE` 中。
