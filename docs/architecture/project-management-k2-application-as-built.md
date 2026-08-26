# 全项目生命周期 K2 Application 实现事实

## 1. 已形成的单一产品链

Chat现在拥有一条不依赖某个外部工具或某个DSH页面的项目管理产品链：

```text
Project
  → Profile Revision（项目类型方法）
  → Configuration Candidate（具体目标、范围、期限/Cadence、参与者、资源和呈现选择）
  → Human Project Decision
  → Adopted Configuration Revision
  → Need / Requirement / Work / Artifact / Evidence / Decision / Event / Metric
  → User View + Agent Context + Maintenance Plan
```

内置Profile在第一次提出Configuration时由Application确定性注册；这只是让系统方法版本可用，
不代表Project已经采用。采用必须经过候选的精确Revision与Hash校验，并由当前Project中的用户
Participant提交Decision。后续采用版本用`supersedesConfigurationRevisionId`形成历史链，旧版本
不被删除。

## 2. 写用例

当前Application公开以下产品用例：

- `registerBuiltInProjectProfile`：注册系统Profile版本，不产生项目承诺；
- `proposeProjectConfiguration`：创建可审核候选和`configuration.proposed` Event；
- `adoptProjectConfiguration`：提交用户Decision、采用版本和`configuration.adopted` Event；
- `captureProjectNeed`：记录Need与`need.captured` Event，始终从`captured`开始；
- `proposeProjectRequirement`：把一个或多个Need塑形成可验收候选，不自动接受；
- 既有Project Coordination继续管理Work、Claim、Block、Evidence、Review、Handoff和终态。

所有写用例都使用Command ID、请求Hash、Project Revision和对象Revision/Hash。Router只校验协议，
事务与Authority由Application拥有；Provider不能直接写Store。

## 3. 用户View

`getProjectHome`从当前采用Configuration和权威对象即时编译：

- 当前目标、Profile和Configuration精确版本；
- Need、Requirement、Work、Action、Resource、Artifact、Evidence、Decision、Metric、Event等计数；
- blocked、等待接受、资源不可用等Attention；
- 最近Project Event；
- Profile要求的View Capability，以及当前Configuration选择的Presentation Binding或fallback。

Profile只声明`document/code/media/work/timeline/report/...`等能力，不包含具体Viewer。Configuration
可以把`document`当前绑定到DSH内嵌文档视图，也可以绑定其他实现；更换Provider不改变Project、
Artifact、Event或历史身份。

## 4. Agent Context

`compileProjectAgentContext`实现六种固定目的：

1. `project_opening`：恢复目标、承诺、当前工作、风险、决定和最近变化；
2. `work_execution`：为精确工作读取Need、Requirement、依赖、Artifact和Evidence；
3. `delta`：读取自上次观察后的事件和对象变化；
4. `review`：读取验收标准、候选Revision、Evidence和风险；
5. `handoff`：读取Work、Claim、Block、交付物、决定和交接历史；
6. `maintenance`：读取项目健康、Attention、期限、Metric、Event和报告事实。

Context按Profile政策执行对象种类、Resource Role、最近事件数、对象数和字符预算，并显式返回
`omissions`。它绑定Profile/Configuration精确ID与Hash，生成自身Hash；Session丢失后可由Project
身份重新编译，完整历史不会无界塞入每轮Prompt。

现有统一Agent开工包已经自动附带`management`投影：已采用Configuration时包含
`project_opening` Context和`agent_started` Maintenance Plan；旧Project尚未采用时明确返回
`not_configured`，同时保留Work、Claim和Handoff读取能力。Codex、Pi和Chat内Agent不再
需要各自猜测该从哪些状态文档恢复项目。

## 5. Maintenance

`evaluateProjectMaintenance`把Agent开始/结束、Resource变化、Provider变化、Deadline、日/周/月和
手动触发编译为受治理的Maintenance Plan。它还从blocked、过期和其他Attention对象产生建议。

Maintenance当前只产生计划，不直接执行Provider写、不确认终态、不采用Profile、不发布内容。
`observe/reconcile/report/review/attention`会给出下一条建议Command；高影响动作仍必须进入既有
Candidate/Decision/Operation链。自动调度和报告Candidate提交属于后续Runtime接缝，不能把本阶段
的只读计划误报为已经执行。

## 6. 公开API

- `POST /api/projects/:projectId/configuration-candidates`
- `POST /api/projects/:projectId/configuration-adoptions`
- `POST /api/projects/:projectId/needs`
- `POST /api/projects/:projectId/requirements`
- `GET /api/projects/:projectId/home`
- `GET /api/projects/:projectId/contexts/:purpose`
- `GET /api/projects/:projectId/maintenance?trigger=...`
- 原有`GET /api/projects/:projectId/timeline`现已包含统一`project_event`。

这些JSON合同既可被DSH使用，也可被未来其他前端、CLI或Agent使用；API不是某个Viewer的专用后端。

## 7. 已验证场景

- Chat Fixture：`software-delivery`，强调需求、代码、测试、审核和Git Resource；
- Content Lab：`content-production`，强调来源、内容Revision、媒体、发布、案例和Practice；另有真实JsonProductStore重启纵向；
- AI学习 Fixture：通用`learning`类别的有期限实例，在Configuration中保存四个月目标、目标日期和复习节奏；
- 长期哲学阅读 Fixture：同一`learning`类别的无期限实例，Configuration使用`continuous`且没有目标日期或固定Cadence；
- 个人日报 Fixture：通用`personal-journal`类别的周期实例，在Configuration中保存每日/每周/月度节奏；
- 合成第五Profile继续证明新增项目类型不需要复制Store、Application或Router分支。

四个通用类别、五个具体Project形状的Fixture共用同一Application纵向；Application包93个测试、API包69个测试通过。Content Lab
另用真实JsonProductStore完成创建、采用、Need、Requirement、Home、Opening Context、Maintenance、
重启恢复纵向；`@chat/testing`共231个测试及55个本地运行合同测试通过。

## 8. 尚未误报为完成的边界

- 仓库中既有`content-lab-*`合同、P8 Rollout用例及`ai_learning` Bootstrap Resource Template是K0前后的兼容纵向，仍携带具体场景命名；它们不是新Profile/Application内核的建模先例，后续只能经正式数据与调用迁移收敛，不能直接删除或继续复制；
- DSH已通过公开Slot实现Project Home、Timeline、Review与Query基础表面，具体实现和真实浏览器证据见
  [项目管理 DSH Presentation 实现事实](./project-management-dsh-as-built.md)；Document、Code、Media仍由
  各自Resource Viewer承担，不在项目页复制；
- Artifact Ref和Metric Observation已经可持久化与查询，但专用写Command仍待具体用户场景；
- Maintenance自动调度、Report Candidate和Attention持久化尚未接入Workflow；
- 旧`Method Snapshot/Context Map`仍作为兼容事实存在，新管理语义以Profile/Configuration为准；
- Chat与Content Lab的正式Product Store尚未执行Profile采用数据迁移；这需要单独核对当前数据并授权。

不得因为API和确定性纵向通过，就宣称以上UI、调度或正式数据迁移已经完成。
