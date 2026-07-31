# my-pi-config

我的 [Pi Coding Agent](https://github.com/earendil-works/pi) 公开、可复现的个人配置。

[English](README.md) | 中文

## 包含内容

- `settings.json` — 模型默认值与可安装的 Pi 包，包括为兼容性固定版本的 [Pi Config Manager](https://github.com/Hor1zonZzz/pi-config-manager)、Pi Lens、MCP 适配器、Herdr 工具集成以及服务端压缩（compaction）支持
- `presets.json` — `quick`、`explore`、`orchestrator` 与 `deep-code` 预设
- `codex-fast.json` — 本地 Codex 优先级（priority）开关的全局状态
- `resource-settings.json` — 针对 Pi 发现的工具、技能（skills）与上下文文件的默认启用/禁用策略
- `model-overrides.json` — 受管理的、不含凭据的内置模型覆盖项
- `extensions/` — 本地扩展；`extensions/subagent/` 同时持有其代理定义与工作流提示词
- `skills/` — 远端受管的技能缓存；Herdr 会在安装期间从其上游 Git 仓库刷新
- `install.sh` — 备份并安装到 `~/.pi/agent`

## 本地扩展

- `preset/` — 通过 `/preset` 切换模型、思考等级、工具与指令；在输入编辑器上边框右侧嵌入当前预设名称，同时保留 Pi 的滚动指示器，并持有随附的 `preset-settings` 技能
- `plan-mode/` — 只读规划模式，通过已安装的 `pi-config-manager` 包提供的瞬态（transient）工具策略层集成
- `questionnaire.ts` — Pi 官方的交互式多问题工具示例
- `notify.ts` — 代理回合结束时的终端通知
- `herdr/` — 统一持有本地 Herdr 集成检查器、异步 `herdr_agent prompt` 监控器和 `herdr-pi-reference` 技能源码；它让显式 `wait: false` 调用保持非阻塞，并注入会话级完成 follow-up
- `subagent/` — 直接复制 Pi 官方上游的子代理示例，仅将示例代理的模型 frontmatter 改为本地 OpenAI Codex 模型
- `codex-fast-toggle/` — `/fast on|off` 切换 Codex 优先级服务层级（service tier），同时保持提供方标识为 `openai-codex`

## 安装

运行安装脚本前请先审查本仓库。扩展以与 Pi 相同的权限执行。

```bash
git clone https://github.com/Hor1zonZzz/my-pi-config.git
cd my-pi-config
./install.sh
```

安装程序会在替换受管文件之前，在 `~/.pi/agent/backups/` 下创建带时间戳的备份。它会将 `model-overrides.json` 合并进目标 `models.json`，保留所有无关的本地提供方、凭据与模型设置。它还会从上游 `master` 分支刷新 Herdr 技能，将其安装到 `~/.pi/agent/skills/herdr/`，把 Herdr 扩展持有的 `herdr-pi-reference` 技能安装到 `~/.pi/agent/skills/herdr-pi-reference/`，并把 Preset 扩展持有的 `preset-settings` 技能安装到 `~/.pi/agent/skills/preset-settings/`；当远端暂时不可用时，会使用已有的 Herdr 缓存。当 Pi 在 Herdr 内启动时，本地集成检查器会在 Herdr 的 Pi 集成缺失或过旧时发出警告；它绝不会自动安装或更新由 Herdr 管理的集成。已有的 `resource-settings.json` 状态会被保留；首次迁移时，安装程序会从旧的 `skill-settings.json` 导入被禁用的技能列表。重启 Pi 或运行：

```text
/reload
```

`settings.json` 中声明的包依赖由 Pi 在启动时安装。请单独完成身份认证；本仓库有意不包含凭据。

## 常用命令

```text
/config-manager
/preset
/tools
/skills
/contexts
/extensions
/plan
/fast
/implement <task>
/scout-and-plan <task>
/implement-and-review <task>
```

## 安全

本仓库有意排除凭据、会话、MCP 配置、信任决策、缓存、历史记录、`node_modules` 以及由 Herdr 管理的集成文件。绝不要提交 `~/.pi/agent/auth.json` 或原始的本地 `models.json`。

`model-overrides.json` 是受管配置，而不是 `models.json` 的副本；它只包含不含凭据的模型覆盖项，由安装程序合并进本地文件。

`resource-settings.json` 是受管配置，不是机密。已安装的 `pi-config-manager` 包会将已禁用的技能与上下文文件从模型提示词中隐藏，并阻止已禁用的 `/skill:<name>` 展开；但它有意不阻止对已知路径的直接 `read` 访问。

## 署名与许可证

部分扩展与子代理工作流改编自 Pi 的官方示例。Pi 的许可证包含在 `licenses/pi-LICENSE` 中。

`codex-fast-toggle` 的流式处理方式源自 `pi-openai-codex-fast`；其上游 MIT 许可证与 README 包含在该目录中。参见 `THIRD_PARTY_NOTICES.md`。
