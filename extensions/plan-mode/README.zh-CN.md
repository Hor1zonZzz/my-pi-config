# Plan Mode 扩展

用于安全代码分析的只读探索模式。

[English](README.md) | 中文

## 功能

- **禁用内置写入工具**：利用 Pi Config Manager 的瞬态策略层禁用 edit/write，同时保留其他激活工具
- **Bash 白名单**：只允许只读的 bash 命令
- **计划提取**：从 `Plan:` 段落中提取编号步骤
- **进度跟踪**：执行期间通过 widget 显示完成状态
- **`[DONE:n]` 标记**：显式的步骤完成跟踪
- **会话持久化**：状态在会话恢复（resume）后仍然保留

## 命令

- `/plan` - 切换计划模式
- `/todos` - 显示当前计划进度
- `Ctrl+Alt+P` - 切换计划模式（快捷键）

## 用法

1. 使用 `/plan` 或 `--plan` 标志启用计划模式
2. 让代理分析代码并制定计划
3. 代理应在 `Plan:` 标题下输出编号计划：

```
Plan:
1. First step description
2. Second step description
3. Third step description
```

1. 出现提示时选择 "Execute the plan"
2. 执行期间，代理用 `[DONE:n]` 标记将步骤标记为完成
3. 进度 widget 显示完成状态

## 工作原理

### 计划模式（只读）

- 内置 edit/write 工具被禁用
- 其他激活工具保持可用
- Bash 命令经白名单过滤
- 代理在不做任何修改的情况下制定计划

### 执行模式

- 瞬态 Plan Mode 层被移除，恢复管理器的有效工具策略
- 代理按顺序执行各步骤
- `[DONE:n]` 标记跟踪完成情况
- Widget 显示进度

### 命令白名单

安全命令（允许）：

- 文件查看：`cat`、`head`、`tail`、`less`、`more`
- 搜索：`grep`、`find`、`rg`、`fd`
- 目录：`ls`、`pwd`、`tree`
- Git 读取：`git status`、`git log`、`git diff`、`git branch`
- 包信息：`npm list`、`npm outdated`、`yarn info`
- 系统信息：`uname`、`whoami`、`date`、`uptime`

被阻止的命令：

- 文件修改：`rm`、`mv`、`cp`、`mkdir`、`touch`
- Git 写入：`git add`、`git commit`、`git push`
- 包安装：`npm install`、`yarn add`、`pip install`
- 系统：`sudo`、`kill`、`reboot`
- 编辑器：`vim`、`nano`、`code`
