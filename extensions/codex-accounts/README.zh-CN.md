# Codex 订阅账号全局管理

[English](README.md) | 中文

`/codex-accounts` 打开 TUI 账号菜单。切换作用于**同一 Pi agent 目录的全局登录**，
不保存 session 专属账号选择。provider 保持 `openai-codex`，模型、thinking、Fast 不变。
安装时应同步更新本仓库的 `codex-statusline` 和 `codex-server-compaction` 目录，
它们提供共享身份解析、quota 即时更新和原生历史的账号隔离。本目录不是独立发布的第三方包替代品。

## 菜单

- **Import current Pi login**：当前登录尚未保存时显示，确认后导入最新凭据。
- **Add account / sign in again**：使用当前 provider 的公开 OAuth 实现（本配置中为
  Pi 原生 Codex 流程）。手动打开界面中的
  授权 URL，或选择设备码流程。设备码等待期间按 **Esc** 或选择 **Cancel login** 可停止轮询；
  成功或失败时等待框自动关闭。取消不保存，之后可重新打开账号菜单。新增账号不会自动切换；重新授权当前账号
  则更新该账号的有效凭据。
- **选择已保存账号**：确认全局影响后，保存当前账号最新 token，必要时刷新目标凭据，
  再更新全局登录。选择当前账号不做任何覆盖，避免恢复旧快照。

添加或导入后重新打开菜单即可选择。优先显示完整邮箱，附带账号 ID 后缀以区分工作区；
内部身份同时包含工作区和用户，不以邮箱作为凭据键。不做自动换号、删除、重命名或批量额度查询。

建好账号库后，建议用本菜单添加和切换。直接改 auth.json、混用其他切换器或重复执行
`/login openai-codex` 可能绕过快照同步，使旧授权需要重新登录。不会迁移或覆盖第三方
`pi-codex-account` 的旧账号库格式。

## 范围与安全

- 新建和恢复的 session 都使用**当前全局账号**，不会恢复历史账号选择。
  后续请求会在新账号下发送原有可见对话上下文；切换不会清空对话。
- 已经绑定认证或发出的请求继续使用旧账号；其他 Pi 0.86.0 进程在下一次读取认证时跟随新账号。
- 只在 TUI、当前 session 空闲时执行。不强制停止其他进程的请求；不支持运行时 API-key
  覆盖或自定义 Codex 后端。
- 当前进程的 quota 插件会收到变更事件；其他 TUI 通过原有认证检查发现变化。
  不清空、不绕过按账号共享的五分钟额度缓存。
- 用公开 `getAgentDir()` 定位 `auth.json` 与 `codex-accounts.json`；不同 agent 目录隔离。

账号库含有敏感 OAuth token，只保存在本机，已加入 `.gitignore`，安装脚本不复制或重置它。
文件使用 `0600` 权限，不能分享或提交。auth 和账号库均先写临时文件再原子替换，保留其他
provider 凭据；遇到文件损坏或无法读取时拒绝操作，不会把它当空文件覆盖。

先保存账号库，再提交 auth.json：若最后一步失败，旧登录仍有效、快照仍可恢复。
账号库不另存一个可能与 auth.json 冲突的 active 指针。若刷新已返回新 token，但随后取消切换，
会保留已轮换的快照，不改变全局选择。刷新失败不会静默换成其他账号；未过期的 token 也不代表
服务器一定接受后续请求，失效时可在菜单里重新登录。

## Pi 兼容性

针对 Pi **0.86.0** 验证。命令、对话框、OAuth 登录/刷新、模型目录刷新和事件使用公开 API。
唯一兼容性依赖是文件锁：Pi 没有公开覆盖 auth.json 和账号库的事务 API，故 `store.ts`
通过 `getPackageDir()` 复用 **Pi 自带的 `proper-lockfile`**，使用相同的
`auth.json.lock`、`realpath:false` 协议，与 Pi 自身 OAuth 刷新互斥。
锁会更新心跳，提交前检查锁归属和取消信号；升级 Pi 时需复核该依赖和协议。
不修改私有 runtime 对象。

Pi 0.86.0 会检查认证文件 revision，因此无需伪造 `expires: 0`，也无需每次切换都 reload。
仅刷新本进程的模型可用性，不请求远端模型目录。

配套压缩扩展给新 opaque artifact 标注账号指纹，按**该请求实际绑定的 token**验证重放。
旧 artifact 归属未知或存在其他账号回合时使用 Pi 文本回退，去除外来 opaque reasoning
和 response 引用；同账号的 Fast 与 V2 continuation 行为保持不变。
这类 session 指纹是历史归属记录，不是账号选择偏好，更不包含凭据。

## 测试与参考

Node 测试需在可解析 Pi host 依赖的临时副本中运行，覆盖导入、添加、切换、取消、损坏文件、
刷新失败/轮换、与真实 Pi 认证锁竞争，以及另一运行中的 Pi 认证实例无需 reload 即可读到切换。
transport 测试验证 A/B/A 重放和“请求已绑定 token 后全局登录变化”的场景；测试不使用真实账号。

全局快照工作流参考了
[fadilsflow/pi-codex-account](https://github.com/fadilsflow/pi-codex-account)
（MIT，检视 commit `35b77b8`），代码独立实现，未复制其源码。
这里增加了共享认证锁、原子提交、原生 OAuth 添加和账号感知的 quota/压缩联动，不采用强制过期策略。
