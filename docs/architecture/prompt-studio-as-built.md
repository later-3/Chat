# Prompt Studio 管理纵向 As-built

> 状态：`codex/prompt-management-design` 已实现。本文是管理纵向的唯一实现说明；Prompt Assembly 与 Runtime Prompt 编辑尚未接入。

## 1. 用户结果

用户可以在 DSH「设置 → 提示词」中：

1. 查看 19 个 Prompt Region 的含义、计划位置、可编辑性、Catalog 来源和 Hash；区域卡显示当前组件数，并可直接筛选该区域的组件；
2. 查看 4 个 Git 内置 Markdown 组件的完整正文、相对路径、Revision 和 Hash；
3. 从内置组件创建自己的副本，内置正文保持不变；
4. 新建用户组件，修改标题或正文时保存为新的不可变 Revision；
5. 查看任意历史 Revision，使用精确 Revision/Hash 做并发控制；
6. 归档与恢复用户组件。

本纵向不会调用 Provider、不会启动 Workflow，也不会改变 Planner、Executor 或 Direct Agent 的现有 Prompt。

## 2. 事实所有权

```text
prompts/catalog.json + prompts/**/*.md
  └── Git PromptCatalog（Builtin唯一事实源，只读）

Product Store v14
  ├── PromptFragment（owner/status/current/CAS）
  └── PromptFragmentRevision（不可变title/region/content/source/hash）

DSH Prompt Studio
  └── Query/Command投影与浏览器草稿，不拥有正式Prompt事实
```

Builtin 不写入 Product Store。复制命令只提交精确 Source Revision ID/Hash；Application 从服务端 Catalog 读取真实正文并写入新用户 Revision，浏览器不能提交任意仓库路径或伪造来源正文。

## 3. Catalog

- Manifest：`prompts/catalog.json`
- Region说明：`prompts/regions/catalog.md`
- 内置正文：`prompts/fragments/**/*.md`
- Adapter：`apps/api/src/prompt-catalog.ts`

Adapter 使用 `import.meta.url` 推导仓库根，与进程 cwd 无关；加载时拒绝绝对路径、`..`、越界 symlink、缺失文件、重复 ID/Region/Order 和 SHA-256 漂移。任一错误都会让 API 组合根启动失败关闭。

## 4. Product Store 与并发

`chat-product-store.v13 → v14` 只新增两张空表：

- `promptFragments`
- `promptFragmentRevisions`

迁移不 seed Git Builtin，也不修改旧事实、Store Revision 或提交时间。

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

Commands：

- `POST /api/prompt-fragments`
- `POST /api/prompt-fragments/copies`
- `POST /api/prompt-fragments/:promptFragmentId/revisions`
- `POST /api/prompt-fragments/:promptFragmentId/archive-status`

写命令使用 Command Receipt；revision/archive 必须同时携带 Aggregate expectedRevision、current Revision ID 和 current Revision Hash。旧页面保存返回 `revision_conflict`，不能覆盖新版本。

浏览器在发出写命令前保存 `path + request body + commandId`。如果响应丢失，界面只允许原样重试同一个命令；确定性 4xx 才清除待确认命令。该记录只是网络恢复凭据，正式结果仍由 Product Store 与 Command Receipt 决定。

## 6. DSH 边界

继续使用唯一集成包 `packages/dsh-lifeos-bridge`，通过 DSH 公开 root-scope `settings.section` 注册 `lifeos-prompts`。没有新建插件、没有修改 DSH 派生、没有把 Prompt 放进 DSH local settings。

数据流：

```text
PromptStudio.tsx
→ PromptStudioController
→ /lifeos/prompts/* 同源路由
→ PromptStudioBridgeService
→ ChatProductClient
→ Chat公开Prompt API
```

列表不携带正文；详情和精确 Revision 按需读取。Prompt 写路由单独使用 96 KiB 有界请求体，其他 LifeOS 命令仍保持 16 KiB。浏览器编辑草稿保存在本机 `localStorage`，只用于防止 Settings 关闭时丢稿；正式版本仍只由 Product Store 拥有。

组件通过 `regionKey` 与区域目录严格关联。组件卡和详情同时显示区域名称与稳定 Key；区域卡的“查看 N 个组件”会切换到组件页并应用对应筛选。内置组件详情中的来源文件路径是可点击控件，展开后显示 Catalog Adapter 从该 Git 文件读取、并通过 Manifest SHA 校验的只读原文。它不调用 VS Code，也不允许浏览器凭任意路径读取仓库文件。

真实浏览器门只启动 API 与 DSH，并使用隔离的 `45111`、`45110/45114` 端口和专用 Product Store；它不清理或争抢正在运行的正式 `431xx` 开发实例。

## 7. 尚未实现

以下内容属于后续 Prompt Assembly 纵向：

- Prompt Profile、选择器和“仅本次使用”的冻结快照；
- 把 Region 编译进 `system/messages/tools/options`；
- Assembly Manifest 与 Prompt Review 的真实来源/JSON Pointer；
- Workflow 节点配置、跨 Run 历史、预算、摘要和压缩；
- 在 Provider 前编辑并重新审核新的 Payload Revision。
- 把 DSH 所选 Workspace 映射成 Chat 受权 Root，并让模型通过工具自行读取 `AGENTS.md`；当前管理页只展示 `platform_workspace` 与 `target_workspace` 两个已规划的运行时区域。
