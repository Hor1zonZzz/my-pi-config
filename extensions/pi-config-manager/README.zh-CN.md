# Pi Config Manager

适用于 Pi 0.83.0 的统一资源策略扩展。

[English](README.md) | 中文

Pi 始终负责发现、解析、加载、去重工具、技能、上下文文件、扩展与包，并为它们标注来源（provenance）。管理器消费 Pi 的这些公开清单，仅控制某个资源是否启用。

## 命令

```text
/config-manager  打开统一概览
/tools           打开工具页
/skills          打开技能页
/contexts        打开上下文文件页
/extensions      打开扩展页
```

工具、技能与上下文的开关是当前会话的覆盖项，会立即生效。全局默认值可以通过非交互方式修改：

```text
/tools global enable|disable <name>
/skills global enable|disable <name>
/contexts global enable|disable <absolute-path>
```

扩展的变更采用暂存（staged）机制。在扩展页按 `S` 保存、确认并重新加载 Pi。管理器通过公开的 `SettingsManager` 写入 Pi 原生的设置过滤器；重新加载后加载什么由 Pi 决定。Pi 无法过滤直接点名单个扩展文件的本地包来源，因此管理器会如实报告这种边界情况，而不会声称保存了一个实际无效的开关。

## Context Monitor 演示

管理器以居中浮层打开：左侧是资源列表，右侧是带边框的 Context Monitor。在工具、技能与上下文列表中移动选择时，会预览所选资源对模型可见的贡献内容：

- 工具显示其描述、参数 schema、激活的 `promptSnippet` 以及激活的提示词指南（prompt guidelines）。
- 技能显示其在 Pi 系统提示词技能目录中的条目。
- 上下文文件显示其完整的 `project_context` 系统提示词块。

在代理运行之前，监视器显示的是 Pi 当前的系统提示词预览；该预览尚未经过即将发生的回合的 `before_agent_start` 处理器。在一次代理运行之后，监视器显示在 `agent_start` 时捕获的完整生效 Pi 系统提示词。两种视图都会在对应内容存在时，高亮所选激活技能、上下文或工具的提示词片段（prompt snippet）与提示词指南。未激活的工具、已禁用的技能或已禁用的上下文则保持显示其各自的描述/预览，因为它们本不应出现在系统提示词中。对于未激活的工具，Pi 不会暴露其 `promptSnippet`；监视器会将其标注为不可用，同时仍将任何已发布的提示词指南作为未激活元数据显示。缓存的提示词会在下一次代理运行时刷新，因此在管理器打开期间所做的策略变更要等到那时才会反映出来。工具描述与 schema 始终属于提供方负载数据，而不是系统提示词文本。按 `Right` 聚焦监视器，按 `Left` 返回资源列表；当监视器处于聚焦状态时，`Up`/`Down` 每次滚动三行。

## 生命周期

在 `session_start` 时，管理器恢复策略并显示加载中的 HUD。500 毫秒的稳定期刷新可避免发布不完整的包提供清单。`before_agent_start` 与命令上下文提供权威的技能与上下文快照。每次调和（reconcile）都是幂等的，因此之后由 Pi 发现的资源无需单独的 discovery 实现即可被纳入。

策略优先级为：

```text
运行时约束 > 会话覆盖 > 预设 > 项目/全局默认 > Pi 默认
```

Plan Mode 贡献一个运行时约束层，而不是自行调用 `setActiveTools()`。Pi Config Manager 是本地唯一写入有效激活工具集的扩展。

## 附带技能

`skills/preset-settings/SKILL.md` 会被安装为全局的 `preset-settings` 技能。在默认模式下，它引导代理选择正确的全局、项目或纳入版本控制的 `presets.json`，保留无关的配置档（profile），校验模型/工具/技能字段，并避免把名为 `default` 的预设当作 Pi 的默认模式。

Pi 按常规方式从 `~/.pi/agent/skills` 发现已安装的技能；Config Manager 并不实现平行的技能扫描器。

## 状态

全局默认值存放在 `~/.pi/agent/resource-settings.json`；受信任的项目可以使用 `.pi/resource-settings.json`。会话覆盖项以 `pi-config-manager-state` 条目的形式存储，并跟随会话树分支。

首次运行可以从旧的 `skill-settings.json` 导入被禁用的技能列表。当管理器能定位 Pi 的标准提示词区段时，已禁用的技能与上下文文件会被移除；若自定义提示词省略或改写了这些区段，管理器会发出警告并保持提示词不变。这并不是文件访问层面的安全边界。

## 验证

使用当前安装的 Pi 运行 Config Manager 行为契约测试：

```bash
./tests/pi-config-manager.sh
```
