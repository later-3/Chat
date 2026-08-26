# 项目管理 DSH Presentation 实现事实

> 更新日期：2026-08-26

## 1. 已交付的用户结果

Chat 的项目管理内核通过 DSH 的公开 Cordis Slot 提供跨 Session 的全局项目表面。用户无需先发送消息，空白新会话也能从侧栏“项目”进入，并在同一个表面切换：

1. **Project**：目标、Profile、采用的 Configuration、阶段、对象计数、Attention、Workspace Resource 和 Presentation Capability；
2. **Timeline**：按时间倒序显示统一 Project Event、Decision 和项目建立事件；
3. **Review**：只投影仍需确认、验收或采用的对象，不把已被新版本取代的候选误报为待办；
4. **Query**：按文本、对象类型和状态查询同一 Product Store 中的项目对象。

DSH 不是第二套项目事实。Client 只保存当前选择和查询条件；刷新后重新经过
`DSH Client → LifeOS same-origin Bridge → Chat API → Application → Product Store`读取权威投影。

## 2. 接缝与源码定位

| 责任 | 实现 |
|---|---|
| 公开 Query / Create 合同 | `packages/contracts/src/project-management-api.ts` |
| 通用显式建项事务 | `packages/application/src/managed-project-creation-use-cases.ts` |
| Project Home / Timeline / Review / Query 编译 | `packages/application/src/project-management-query-use-cases.ts` |
| Chat REST 路由 | `apps/api/src/product-routes/project-routes.ts` |
| DSH 同源只读代理 | `packages/dsh-lifeos-bridge/src/chat-client.ts`、`bridge-service.ts`、`http-route.ts` |
| DSH 状态与四视图 | `packages/dsh-lifeos-bridge/src/client/project-management-controller.ts`、`ProjectManagementView.tsx` |
| 空白会话全局入口 | `packages/dsh-lifeos-bridge/src/client/ProjectManagementNavigation.tsx`、`index.tsx` |

Bridge 对查询参数执行严格白名单、单值和上限校验。浏览器不能提供文件路径、Provider Credential 或 Product Store 写端口。Project 页面与既有 conversation view 复用同一个 Controller，不复制状态机。

这部分是 DSH Cordis 插件实现。修改前必须读取 DSH 仓库自身的`AGENTS.md`与`cordis-plugin-development` Skill，并核对实际 Slot 接口；当前入口使用加法式`sidebar.footer.action`，表面使用`conversation.input.dock`与`shell.overlay`，不修改 DSH 原生会话状态。

## 3. 两个实际项目验证

- **Content Lab**：采用通用`content-production` Profile，Resource 指向受管 Content Lab Workspace；Project、Timeline、Review、Query展示内容工作、候选、历史和资源入口。
- **AI 学习**：采用通用`learning` Profile，Resource 指向`~/Code/ai-learning` Git Workspace；同一四视图展示目标、Need、Requirement和后续学习证据，没有专用类别代码。

AI 学习 Workspace 只保存可版本化资产和路标，禁止再用`PROJECT_STATUS.md`、`TODO.md`复制 Product Store 中的状态、Review 和 Timeline。代码、文档、媒体和其他资产仍由各自 Resource Viewer 展示。

## 4. 已验证结果

在隔离 worktree、隔离 Product Store 和端口`45110/45111/45114`上完成真实 DSH 浏览器验证：

1. 空白 DSH 新会话可见全局“项目”入口；
2. Content Lab Project 显示5个真实工作对象和 Workspace Resource；
3. Timeline 显示5条`work.created`及 Configuration / Decision 历史；
4. Review 只剩1个拟议的“烧录英文字幕替换质量门”，旧 Configuration 候选不再误报；
5. Query 以`Crash Course`检索到唯一的`[B站] Crash Course Botany EP02` Work；
6. 切换 AI 学习后，显示学习 Profile、Workspace Resource 和1个待审 Requirement。

## 5. 当前边界

- 已有 Project / Timeline / Review / Query 用户表面；Document、Code、Media 的正文仍由对应 Resource Viewer 承担，本页只显示 Capability Binding；
- Review 当前是只读审核队列，具体对象的接受、修订和验收 Command 仍按对象合同逐条接入；
- Maintenance Plan 已可查询，定时调度、Report Candidate 和自动 Agent 生命周期触发尚未接入；
- 正式 Store 采用仍需要独立迁移门，不能把隔离实例验证冒充常驻实例数据。

当前完成门是“同一项目管理内核可以在 DSH 被真实查看、查询和恢复”，不是“DSH取代所有资源工具”。
