# Prompt Studio 与 Direct Prompt Assembly As-built

> 状态：`codex/prompt-management-design` 已实现管理、会话选择、语义预览和 Direct Agent 运行冻结纵向。Provider 前编辑、跨 Run 历史和压缩仍未实现。

## 1. 用户结果

用户现在有两个彼此独立的入口：

1. DSH「设置 → 提示词」是长期管理面。它展示 19 个 Region、Git 内置 Markdown 原文和来源，支持创建全局或指定 Workspace 的用户组件、派生副本、追加不可变 Revision、归档与恢复。
2. 每个会话的 Composer 工具行有「提示词」入口。发送前可按 Region 分别选择`默认 / 覆盖 / 追加`，在每个 Region 内勾选全局组件或当前 Workspace 组件。默认模式下直接勾选会自动切换为追加；组件可就地查看正文、来源与版本，空作用域可直接新建，用户组件可就地编辑，Git 内置组件可创建副本后编辑。
3. Composer 提供两个不同边界的预览：「提示词配置预览」不依赖本轮输入，只展示 Region、模式、精确 Revision、来源与编译后的 System/Messages 配置；「DSH 前端发送预览」加入当前用户输入、DSH 当前上下文注入投影、Workflow 选择，并显示 Bridge 真正提交给 Chat 的命令 Payload。
4. 首版选择只进入“执行 Agent（逐次提示词审核）”Direct Workflow。Planning/Memory Workflow 不接收该选择，界面明确说明这一点。
5. Direct Message Command 在启动 Workflow 的同一事务中冻结 Prompt Assembly。后续组件修改、归档或页面刷新都不能改变已经启动的 Run。
6. 上述两个预览都不是 Provider HTTP 请求。Prompt Review 的 Raw 才是 Provider Adapter 生成的真实完整请求；易读页在不修改真实正文的前提下增加 Assembly Region、精确 Revision、Hash、Scope 和 Git 文件来源。

## 2. 事实所有权

```text
prompts/catalog.json + prompts/**/*.md
  └── Git PromptCatalog（Builtin唯一事实源，只读）

Product Store v15
  ├── PromptFragment（owner/scope/status/current/CAS）
  ├── PromptFragmentRevision（不可变title/region/content/source/hash）
  └── PromptAssembly（一次Direct Run冻结的选择、正文投影与Hash）

DSH Bridge State v9
  └── 每个DSH Session的未发送选择草稿与请求冻结副本，不拥有正式Prompt事实
```

Builtin 不写入 Product Store。用户组件属于`global`或某个已登记`workspace rootId`；浏览器不能提交本机路径、DSH Workspace ID、owner或来源正文。

## 3. Catalog

- Manifest：`prompts/catalog.json`
- Region说明：`prompts/regions/catalog.md`
- 内置正文：`prompts/fragments/**/*.md`
- Adapter：`apps/api/src/prompt-catalog.ts`

Adapter 使用 `import.meta.url` 推导仓库根，与进程 cwd 无关；加载时拒绝绝对路径、`..`、越界 symlink、缺失文件、重复 ID/Region/Order 和 SHA-256 漂移。任一错误都会让 API 组合根启动失败关闭。

## 4. Product Store 与并发

`chat-product-store.v13 → v14` 新增两张 Prompt 管理表：

- `promptFragments`
- `promptFragmentRevisions`

`v14 → v15`为已有用户组件补`global` Scope，新增`promptAssemblies`。历史 Direct Run 回填`legacy-v0` Assembly，并重算包含 Assembly Hash 的 Direct Attempt Input Manifest；它不会伪造当时不存在的自定义 Region。迁移不 seed Git Builtin。

Revision 规则：

- 版本号必须从 1 连续递增；
- 第 2 版起必须绑定上一版 ID/Hash；
- Aggregate current 必须指向最高版；
- Hash 覆盖 region、title、description、content、revision 链、派生来源和作者；
- 归档后不能 revise；restore 只改变 Aggregate 状态，不修改正文 Revision。

## 5. 公开 API

Queries：

- `GET /api/prompt-regions`
- `GET /api/prompt-fragments`
- `GET /api/prompt-fragments/:promptFragmentId`
- `GET /api/prompt-fragment-revisions/:promptFragmentRevisionId`
- `GET /api/prompt-workspaces`

Commands：

- `POST /api/prompt-fragments`
- `POST /api/prompt-fragments/copies`
- `POST /api/prompt-fragments/:promptFragmentId/revisions`
- `POST /api/prompt-fragments/:promptFragmentId/archive-status`
- `POST /api/prompt-configuration-previews`
- `POST /api/prompt-assembly-previews`

写命令使用 Command Receipt；revision/archive 必须同时携带 Aggregate expectedRevision、current Revision ID 和 current Revision Hash。旧页面保存返回 `revision_conflict`，不能覆盖新版本。

浏览器在发出写命令前保存 `path + request body + commandId`。如果响应丢失，界面只允许原样重试同一个命令；确定性 4xx 才清除待确认命令。该记录只是网络恢复凭据，正式结果仍由 Product Store 与 Command Receipt 决定。

## 6. DSH 边界

继续使用唯一集成包 `packages/dsh-lifeos-bridge`，通过 DSH 公开 root-scope `settings.section` 注册长期管理面，并通过`conversation.input.left`注册每轮 Composer。没有新建插件、没有修改 DSH 派生、没有把正式 Prompt 放进 DSH local settings。

数据流：

```text
PromptStudio.tsx
→ PromptStudioController
→ /lifeos/prompts/* 同源路由
→ PromptStudioBridgeService
→ ChatProductClient
→ Chat公开Prompt API
```

会话选择链路是：

```text
PromptComposer.tsx（直接读取DSH真实input.draft）
→ PromptComposerController
→ GET/PUT /lifeos/sessions/:id/prompt-selection
→ Bridge State v9按DSH Session保存草稿并按请求冻结
→ Direct Submit Message携带promptSelection
→ Application编译并原子提交Prompt Assembly
```

两个预览故意使用不同数据源：

```text
提示词配置预览
Prompt Selection草稿
→ /lifeos/prompts/configuration-previews
→ /api/prompt-configuration-previews
→ Application只编译Region配置（没有用户输入、没有DSH上下文）

DSH前端发送预览
DSH真实input.draft + 当前Session producer context + Workflow/Prompt Selection草稿
→ /lifeos/sessions/:id/bridge-send-previews
→ BridgeService按实际Submit政策投影Bridge→Chat命令Payload
```

DSH 到 Bridge 的预览读取与真实发送相同的当前输入和`agent-instructions`提取逻辑。Bridge 到 Chat 的政策也与真实发送一致：Direct携带`promptSelection`且不携带DSH `workspaceInstructions`；非Direct携带DSH `workspaceInstructions`且不携带`promptSelection`。Prompt正文不会在Bridge命令中重复传输，Chat后端会按冻结的Revision ID与Hash重新读取并编译。

列表不携带正文；详情和精确 Revision 按需读取。Prompt 写路由单独使用 96 KiB 有界请求体，其他 LifeOS 命令仍保持 16 KiB。浏览器编辑草稿保存在本机 `localStorage`，只用于防止 Settings 关闭时丢稿；正式版本仍只由 Product Store 拥有。

组件通过 `regionKey` 与区域目录严格关联。组件卡和详情同时显示区域名称与稳定 Key；区域卡的“查看 N 个组件”会切换到组件页并应用对应筛选。会话 Composer 复用同一个 Prompt Studio Controller 和相同公开 API：每个 Scope 都有“新建”，每个组件都有“查看”，详情继续提供来源、历史版本、派生副本与用户版本编辑，不建立第二套 Prompt 事实或写入协议。内置组件详情在版本区下方始终显示 Catalog Adapter 从 Git 文件读取、并通过 Manifest SHA 校验的只读原文，独立来源色块明确区分文件正文与 UI 解释。

本地模式还提供两类相同的“打开”菜单：组件详情的“打开文件”和区域卡的“打开配置文件”。DSH Host只投影本机实际安装的白名单应用；当前macOS实现支持Visual Studio Code、TRAE CN、Cursor、Sublime Text、文本编辑与系统默认应用。浏览器只提交Catalog登记的相对路径与应用ID；Host重新校验真实路径、普通文件和symlink边界后调用本机应用。公网部署不装配该能力，不能让远端浏览器启动服务器应用，也不能用任意路径读取或打开仓库文件。

真实浏览器门只启动 API 与 DSH，并使用隔离的 `45111`、`45110/45114` 端口和专用 Product Store；它不清理或争抢正在运行的正式 `431xx` 开发实例。

## 7. Region选择、Workspace与运行冻结

每个 Region 独立选择`default / replace / append`：默认采用固定 Direct Profile；覆盖只用显式组件；追加先放默认组件再放显式组件。在 default 状态直接勾选组件等价于“切换到 append 并勾选该版本”，避免出现可见但不可操作的组件。选择冻结精确 Revision ID 与 Hash。全局组件对所有 Workspace 可见，Workspace组件只有在当前DSH Session映射为同一个Chat `rootId`时可见；Workspace变化会清掉旧Root的显式选择。

提示词配置预览不需要用户输入，System Region编译为`systemPromptAppend`，Messages Region编译为`messageContext`；它回答“目前配置了什么”。DSH发送预览需要真实的本轮用户输入；空输入时按钮仍可点击并明确提示用户先回到主输入框输入消息，不能用无解释的disabled状态伪装成系统故障。它回答“DSH现在会把什么交给Bridge，以及Bridge会怎样调用Chat”。

正式Direct提交仍调用同一个`direct-agent-prompt-compiler.v1`，把Messages Region与真实当前输入编译为`userPrompt`。两个前端预览都明确不是Provider HTTP请求；真实请求仍只在Provider Gate的Prompt Review中出现。

Direct Message Command在Product Store事务内再次校验用户Revision的owner、状态、Scope和Hash，然后原子写入Message、Run、RunSpec、Outbox与Assembly。Direct Run与Assembly强制1:1；Input Manifest绑定Assembly Hash；Executor只从Application授权响应取得冻结的System/User文本和可选Workspace rootId。

当前 Workspace Runtime 是单一目标Root，模型通过只读工具自行决定是否读取其中的`AGENTS.md`，Chat不会预读正文。文档设计中的`platform_workspace + target_workspace`双Root工具边界尚未实现；当目标是Chat时，`root_chat`同时承担平台与目标Workspace。目标为其他项目时，当前Agent只获得目标Root，不能声称同时可读Chat基础Root。

## 8. 尚未实现

- 在Provider前编辑Raw Payload并生成新的审核Revision；
- Planner、Planning Executor和Memory Workflow接入统一Prompt Profile；
- 双Root Workspace Tool边界、跨Product Run历史、预算、摘要和压缩；
- 临时未保存正文直接用于一次发送；当前必须先保存为组件Revision再选择；
- Prompt Profile的用户自定义、命名和版本管理；当前Direct Profile由代码固定版本拥有。
