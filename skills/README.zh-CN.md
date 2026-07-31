# 受管技能

[English](README.md) | 中文

## Herdr

`install.sh` 每次运行时都会从 <https://github.com/ogulcancelik/herdr> 的 `master` 分支同步 `skills/herdr/SKILL.md`，然后将其安装到 `~/.pi/agent/skills/herdr/SKILL.md`（或由 `PI_CODING_AGENT_DIR` 指定的目录）。

下载得到的 `SKILL.md` 是一个被 git 忽略的缓存，而不是本仓库维护的副本。当远端可用时，远端版本会替换本地缓存与已安装的副本。如果远端不可用，安装程序会使用已有的缓存；在没有缓存的情况下进行首次安装会失败。

该技能是第三方内容，可能指示代理运行命令。安装前请审查其上游源码与许可证。

## Herdr Pi Reference

`extensions/herdr/skills/herdr-pi-reference/` 由本仓库维护，并归本地 Herdr 扩展所有；它会安装到
`~/.pi/agent/skills/herdr-pi-reference/`（或由 `PI_CODING_AGENT_DIR` 指定的目录下）。其中记录本机当前可用的模型和 thinking level。依赖其中的模型信息前，请运行 `pi --list-models` 刷新可用性。
