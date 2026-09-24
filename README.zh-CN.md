# my-pi-config

我的 [Pi Coding Agent](https://github.com/earendil-works/pi) 公开、可复现的个人配置。

[English](README.md) | 中文

## 包含内容

- `settings.json` — 模型默认值与可安装的 Pi 包，包括 MCP 适配器、Herdr 工具集成，以及 Pi Voice（本地语音转文字，提供录音快捷键和 `transcribe_file` 工具）
- `model-overrides.json` — 受管理的、不含凭据的内置模型覆盖项
- `extensions/` — 本地扩展；`extensions/subagent/` 同时持有其代理定义与工作流提示词
- `prompts/` — 本地通用提示词模板，包括可手动选择是否探索仓库的 `/understand` 与 `/explore-understand`
- `skills/` — 远端受管的技能缓存；Herdr 会在安装期间从其上游 Git 仓库刷新
- `install.sh` — 备份并安装到 `~/.pi/agent`

## 本地扩展

- `questionnaire.ts` — Pi 官方的交互式多问题工具示例
- `notify.ts` — 整个运行结束（`agent_settled`）后的终端通知
- `herdr/` — 统一持有本地 Herdr 集成检查器、异步 `herdr_agent prompt` 监控器和 `herdr-pi-reference` 技能源码；它让显式 `wait: false` 调用保持非阻塞，并注入会话级完成 follow-up
- `subagent/` — 把任务交给 `pi` 子进程，支持单个、并行、链式三种模式，可前台运行，也可用 `async: true` 在后台运行；保存每个子会话，在输入框下方列出运行中的 subagent（输入框为空时按 `↓` 选中后可查看或停止），并提供 `/subagent-history` 和 `/subagent` 模型/思考级别选择器（[详细说明](extensions/subagent/README.zh-CN.md)）
- `codex-fast-toggle/` — 使用 Pi 原生命令 `/fast on|off`，仅在 Codex 下显示补全，按 session 切换优先级；Codex transport 让普通请求和压缩请求的路由提示与最终 tier 一致，不改变提供方身份
- `codex-server-compaction/` — 并行执行 Pi 内置文本压缩与 Codex Remote Compaction V2，持久化 opaque 原生历史，继承当前 Fast service tier，并在远程失败时使用 Pi 结果
- `codex-accounts/` — `/codex-accounts` 导入、添加和全局切换 Codex 订阅账号，保留 provider/模型；设备码登录可按 Esc 取消。凭据只存本机，在同一 agent 目录内共享（[详细说明](extensions/codex-accounts/README.zh-CN.md)）
- `codex-statusline/` — 在 Codex TUI 中自动显示当前账号与周额度剩余比例；同一 agent 目录内的 session 共享五分钟账号/用户额度缓存（[详细说明](extensions/codex-statusline/README.zh-CN.md)）
- `code-mode/` — `/tools` 开关已注册的工具并切换 code mode 及其沙箱（也可用 `/code-mode on|off` 和 `pi --code-mode`）；code mode 把已开启的内置工具移入 `execute_code`，模型编写 JavaScript 或 Python 程序把它们当作函数调用，只有打印的输出回到上下文；在 macOS 上程序本身运行在沙箱中，除通过工具外不能访问文件、网络和进程（[详细说明](extensions/code-mode/README.zh-CN.md)）
- `hairline/` — Hairline 素线皮肤：渐变 π Header、只有上下横线的输入框（上横线显示工作状态，下横线显示模型和上下文刻度）、保留其他扩展状态的单行 footer、显示回复速度和 Codex 周额度进度条的 HUD，以及单行的 `read`/`bash`/`edit`/`write` 工具行（执行仍由 Pi 完成）；`/hairline on|off` 与 `/hairline hud on|off`（[详细说明](extensions/hairline/README.zh-CN.md)）

## Pi 兼容性

本地扩展适配 Pi 0.87.0；`hairline/` 与 `code-mode/` 在 Pi 0.87.1 上验证。Codex 远程压缩遵守上下文编辑；编辑使旧 native checkpoint 失效后，使用 Pi 已应用编辑的文本上下文，直到下一次成功压缩恢复 native replay。参见[兼容性说明](extensions/codex-server-compaction/README.md#context-edits-pi-0870)。

## 安装

运行安装脚本前请先审查本仓库。扩展以与 Pi 相同的权限执行。

```bash
git clone https://github.com/Hor1zonZzz/my-pi-config.git
cd my-pi-config
./install.sh
```

安装程序会在替换受管文件之前，在 `~/.pi/agent/backups/` 下创建带时间戳的备份。它会将 `model-overrides.json` 合并进目标 `models.json`，保留所有无关的本地提供方、凭据与模型设置。它还会从上游 `master` 分支刷新 Herdr 技能，将其安装到 `~/.pi/agent/skills/herdr/`，并把 Herdr 扩展持有的 `herdr-pi-reference` 技能安装到 `~/.pi/agent/skills/herdr-pi-reference/`；当远端暂时不可用时，会使用已有的 Herdr 缓存。当 Pi 在 Herdr 内启动时，本地集成检查器会在 Herdr 的 Pi 集成缺失或过旧时发出警告；它绝不会自动安装或更新由 Herdr 管理的集成。迁移期间还会先备份、再删除已退役的 `extensions/plan-mode/`、旧的全局 `codex-fast.json` 状态文件以及已退役的外部 `pi-openai-server-compaction` Git 包 checkout；仓库管理的 Codex-only 扩展会完全取代该依赖。重启 Pi 或运行：

```text
/reload
```

`settings.json` 中声明的包依赖由 Pi 在启动时安装。请单独完成身份认证；本仓库有意不包含凭据。

## 常用命令

```text
/tools
/code-mode
/fast
/hairline
/subagent
/subagent-history
/understand [requirement]
/explore-understand [requirement]
/scout <task>
/implement <task>
/scout-and-plan <task>
/implement-and-review <task>
```

`/understand` 直接澄清需求；`/explore-understand` 会明确先对仓库进行有针对性的只读探索。两者都会在开始实现前等待确认。

## 安全

本仓库有意排除凭据、会话、MCP 配置、信任决策、缓存、历史记录、`node_modules` 以及由 Herdr 管理的集成文件。绝不要提交 `~/.pi/agent/auth.json` 或原始的本地 `models.json`。

`model-overrides.json` 是受管配置，而不是 `models.json` 的副本；它只包含不含凭据的模型覆盖项，由安装程序合并进本地文件。

## 署名与许可证

部分扩展与子代理工作流改编自 Pi 的官方示例。Pi 的许可证包含在 `licenses/pi-LICENSE` 中。

`codex-fast-toggle` 的 Fast 行为最初源自 `pi-openai-codex-fast`，现使用 Pi 原生命令与请求 hook；其上游 MIT 许可证与 README 包含在该目录中。

`codex-server-compaction` 基于 Alexis Gallagher 的 `pi-openai-server-compaction`（MIT）适配，保留 Codex V2 endpoint、并行 Pi/native 压缩、持久化与 replay 路径；许可证与派生说明包含在该目录中。参见 `THIRD_PARTY_NOTICES.md`。
