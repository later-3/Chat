# S5任务书：Note Capture第二纵向证明

> 状态：已批准，待实现验收  
> 阶段目标：用同一Catalog、IR、Compiler、Runner和Viewer完成真实笔记捕获，证明内核不是Planning专用抽象  
> 前置完成门：S4可配置Planning真实全链通过  
> 产品参考：Memos的快速Markdown捕获/标签筛选，Joplin的Note/Revision/Tag资源边界

## 0. 阶段约束

1. Note是Chat拥有的正式产品资源，不是Assistant Message、Artifact、Trace或Memory条目的别名。
2. 模型只能提出Note Candidate；标题、kind、正文和标签在用户确认或允许的低风险Policy Resolution后才成为Note Revision。
3. S5范围只含Markdown、kind、tags、来源、修订、归档和查询；不含分享、评论、附件、Notebook树、同步协议和公共可见性。
4. “明天提醒我”需要调度、时区、投递和确认语义，不伪装成Note流程；只作为未来独立Reminder Blueprint候选。
5. 第二流程必须复用S3/S4内核，禁止复制note-workflow-engine、第二套Node状态机或第二套Viewer。

## S5.1 Note、Revision、Candidate、Decision合同与领域不变量

### 目标与结果

定义一个足够完成真实笔记体验、又不会膨胀成知识库平台的最小产品模型，并把候选、确认与正式事实明确分开。

### 方案

1. Note聚合：noteId、ownerPrincipalId、currentRevisionId、status(active/archived)、revision、createdAt、updatedAt。
2. NoteRevision不可变：noteRevisionId、noteId、noteRevision、title、kind、contentMarkdown、tags、sourceRefs、sha256、createdAt。
3. Note kind固定为idea、project_idea、learning、general；新增kind需要Schema与查询兼容审查，不接受任意字符串。
4. Tag值采用显式结构{key,label}：key由NFKC、trim、连续Unicode空白折叠和稳定case-fold生成，label保存经过长度校验的用户显示文本；同Revision内key唯一。
5. NoteCandidate内容不可变：candidateId、productRunId、candidateSequence、supersedesCandidateId、proposed fields/source refs/hash、status、revision。request_revision或用户编辑产生新Candidate，不覆盖旧内容。
6. NoteDecision绑定candidate ID/revision/hash，kind为confirm、request_revision、reject；confirm后的正式Note只能来自所绑定Candidate。
7. ProductRun增加note_capture判别分支和专用phase：queued、extracting、classifying、note_review、committing、completed、rejected；不复用Planning currentPlan字段。

### 领域规则

- title非空且有上限；Markdown允许普通文本/链接/代码但不等于可执行HTML。
- sourceRefs至少一个Message或Selection ref，携带source hash；正式Revision始终可追溯来源。
- Candidate confirmed/rejected后不可重新打开；请求修订后只能由新Candidate继续。
- 一个note_capture Run最多提交一个初始Note；重复commit返回同一Note/Revision。
- Note修订序号从1递增；currentRevisionId必须指向最高已提交Revision。
- 归档不删除Revision，也不使历史Run引用失效。

### 测试设计

1. 所有Schema合法Fixture和unknown field/错误ID/错误kind/空title/超长content/tags/source拒绝。
2. Tag规范化：中英文、全半角、大小写、组合字符、重复空白、同key不同label冲突；规范算法golden version化。
3. Candidate状态机：confirm/reject/request_revision、终态重开、链断裂、sequence重复、跨Run supersedes失败。
4. Decision绑定错误revision/hash、跨Candidate、重复同command、同command异payload。
5. NoteRevision递增、current ref、归档/恢复允许矩阵。
6. ProductRun判别联合证明planning对象不能携带note字段，note对象不能携带plan字段。
7. Hash敏感性：正文/kind/tag/source任一变化改Hash；createdAt不参与内容Hash。

### 完成门

- 不读取Workflow/Store即可用纯domain测试证明候选不自动成为Note。
- 模型输出、用户编辑、Decision和正式Revision之间有不可歧义的绑定链。
- 模型足够支撑S5 UI，但没有把未来提醒/同步/分享塞入可选字段。

## S5.2 Note Store迁移、完整性与回滚

### 目标与结果

把Note模型和note_capture ProductRun分支安全加入Product Store，确保并发修订、重复提交和升级失败不会丢失或覆盖笔记。

### 方案

1. 从届时主干Store版本顺延，新增notes、noteRevisions、noteCandidates、noteDecisions集合；必要查询索引从权威集合重建。
2. ProductRun迁移到含planning/note_capture的严格判别联合；既有对象全部保持planning分支且语义不变。
3. Snapshot integrity验证Note聚合、Revision序列、Candidate链、Decision绑定、Run归属和Node Manifest refs。
4. ProductStorePort仍提供快照事务，不新增Repository-per-table；application用例在单事务协调相关集合。
5. 列表索引按owner/status/updatedAt/tagKey/kind构建；JSON Store规模基线不足时只记录边界，不提前引入数据库或全文搜索引擎。

### 迁移与回滚

- 老Store新增空Note集合，不从历史Message自动生成Note。
- 迁移重复执行字节语义等价；任何完整性错误保持旧文件。
- 新版本开始写Note后，旧构建不得写入；回滚只关闭Note入口并使用兼容reader。
- 不提供硬删除；误建Note通过archive可恢复，物理清理另立治理任务。

### 测试设计

1. 所有历史Store版本全链升级与当前上一版直升；原对象数量/hash守恒。
2. 空Note、单Revision、多Revision、多Candidate修订链、confirmed/rejected/archived Fixtures。
3. 损坏：currentRevision悬空、序号缺失、tagKey重复、Candidate跨Run、Decision hash错、commit Note跨owner。
4. 两个expectedRevision并发修改同Note，只有一个提交，另一个得到revision conflict且无半Revision。
5. 原子替换各故障点、升级后重启、重复升级和只读dry-run报告。
6. 代表Note数量下list/filter/page的时间与内存基线；未达风险前不引入虚构优化。
7. Store文件敏感扫描，不应出现Provider payload、hidden reasoning、Credential或Runtime Token。

### 完成门

- Store可以原子提交Candidate+review节点、Decision+resume Outbox、Note+Revision+commit节点。
- 迁移不会把任何旧Message擅自提升成Note。
- 查询索引可从Store完全重建，索引损坏不会成为事实丢失。

## S5.3 Note命令、查询与公开API

### 目标与结果

提供清晰的Note产品用例：查询列表/详情、修改正式Note、归档/恢复，以及Workflow所需的Candidate/Decision命令；Router不拥有业务事务。

### 方案

1. 公开Query：listNotes(cursor, kind, tagKey, status)、getNote(noteId)、getNoteHistory(noteId, cursor)、getNoteCandidateReview(run/candidate)。
2. 公开Command：reviseNote、archiveNote、restoreNote、submitNoteDecision；每个写命令含commandId和expectedRevision/hash。
3. 私有Workflow Command：publishNoteCandidate、failNoteCandidate、commitConfirmedNote；分别与Node Run业务终态原子提交。
4. 用户在review表单编辑Candidate时，submitNoteDecision可以在一个事务先创建user-edited successor Candidate再对其confirm，Receipt返回实际绑定Candidate；不允许Decision正文偷偷覆盖Candidate。
5. Hono公开DTO返回安全Markdown、Tag、source摘要、allowedActions和revision；source Message正文另按原权限查询。
6. 列表使用稳定cursor(updatedAt,noteId)，并发插入不重复/不漏掉已翻页边界内对象；全文搜索不在本阶段。

### 权限与错误

- owner或届时明确Participant权限才能读写；无权Note使用统一存在性策略。
- archived Note默认只读，仅restore允许；revision conflict要求rehydrate，不自动合并Markdown。
- Candidate只允许所属Run/session授权用户Decision；终态Candidate无可用动作。
- Markdown输出经DTO长度和安全策略，Router不渲染HTML。

### 测试设计

1. 列表按kind/tag/status筛选、cursor边界、同updatedAt稳定排序、归档默认排除。
2. Revision：成功修改、并发冲突、重复command、同command异payload、历史不可变。
3. Candidate：confirm、edited confirm、request_revision、reject、错误hash、跨Run/跨owner。
4. commit事务故障注入：Note/Revision/Candidate/Node Run/Product Run/Final Message一起成功或不提交。
5. API合法/非法ID、404/403策略、unknown field、超大Markdown、恶意tag、ETag。
6. 安全：source refs不会绕过Message权限；响应无内部Runtime/Provider字段。
7. 架构：Router不mutate Store；Workflow只能调私有Command，不能直接写Note集合。

### 完成门

- 在没有Workflow的用例测试中，可以人工构造Candidate并安全完成/拒绝/修订/提交。
- 正式Note的每个Revision都有来源和创建actor，列表/详情可重启恢复。
- API合同足够S5.5 UI使用，不暴露通用Patch或任意过滤表达式。

## S5.4 Note节点、内置Definition与同一Runner接入

### 目标与结果

使用S3/S4既有内核实现Note Capture Definition：从消息/选区提取候选、分类、可选审核、提交正式Note，全程在S2 Viewer可观察。

### 方案

1. 通过Store Seed增加system Note Capture Definition与已发布Revision；使用相同Definition/Revision/RunSpec集合和Compiler。
2. note.extract Executor读取冻结Message/Selection ref，调用pi Adapter生成结构化title/content candidate；结果严格parse后发布NoteCandidate。
3. note.classify可以与extract合并或独立：只有当能形成独立、可观察的kind/tag建议证据且不重复模型调用时才保留独立节点；实施以纵向证据决定。
4. human.note_review使用同一Runner human_review控制结构、Runtime Binding、Decision-first resume顺序；Review内容为Candidate，不复用Plan schema。
5. note.commit调用commitConfirmedNote，原子创建Note+Revision、Node success、Run success和最终Assistant Message摘要。
6. 低风险auto policy可以确认纯Note Candidate，但必须有运行前用户选择和Policy Resolution；来源、标签仍可审计。若用户设置manual则一定等待。

### 复用边界

必须复用：Definition lifecycle、IR/Compiler、RunSpec、NodeRun/Transition/Manifest、Runner控制容器、HITL恢复、Workflow View、通用错误族和Outbox Dispatcher。

允许专用：Note domain/application命令、Note public projector、note.extract/note.commit Executors、Note Review UI。

禁止复制：第二套Runner循环、NoteNodeRun、NoteOutbox dispatcher、Note专属graph DTO或通用模型调用代码副本。

### 测试设计

1. Definition seed/hash/重复迁移；Compiler能用Note Blueprint且拒绝Planning-only节点。
2. full_message与utf16_range来源，错误range/hash、空选择、Unicode surrogate边界。
3. 模型合法候选、Schema非法、恶意Markdown、超限tag、Provider失败/超时/重放。
4. manual review：等待、edited confirm、request_revision两轮、reject、重复resume。
5. auto policy允许/禁止及Policy Resolution绑定。
6. commit前后崩溃、重复commit、Run取消、Note Store冲突。
7. 同一Runner harness同时执行Planning Fixture和Note Fixture，控制逻辑测试不分叉。

### 完成门

- Note真实Run无需任何Planning-specific字段或特殊Runner分支，human review只通过类型化业务Adapter差异工作。
- 一次模型重放不会产生多个Candidate或多个Note。
- Viewer直接显示Note节点和Manifest，无Note专属假图。

## S5.5 Note捕获、审核、列表与详情UI

### 目标与结果

用户可以从Composer选择Note Capture、输入或选择一段内容，审核候选并在专门位置查看/筛选/修订正式笔记。

### 方案

1. Composer WorkflowPicker显示Note Capture的用途与最小配置：source(full message/selection)、默认kind可选、建议tags开关、review mode。
2. 消息选区入口复用现有Memory Import已验证的selection snapshot/hash原则；不直接把DOM selection当持久事实。
3. Note review节点显示title、kind、Markdown、tags的受控表单；编辑并确认通过S5.3的successor Candidate事务，不在前端声称已修改原Candidate。
4. 增加Notes入口：列表卡片显示title/kind/tags/source摘要/updatedAt，服务端cursor分页与筛选；详情显示当前Revision和可展开历史。
5. 正式Note编辑使用expectedRevision；冲突保留本地草稿并显示新旧版本，不自动last-write-wins。
6. Markdown用安全Renderer；外链明确提示，远程资源默认不自动加载。

### 体验边界

- 快速捕获主路径不超过：选Note Definition → 输入/选区 → 发送 → manual时确认；auto允许时发送后直接得到Note。
- 列表不是社交Feed；无点赞、分享、评论或公开状态。
- Tags显示后端canonical key/label，不在浏览器另做不一致规范化；前端可预览，提交由服务端最终决定。
- Reminder语句可作为general Note内容，但UI不显示“已提醒”或日程状态。

### 测试设计

1. full message、选区、idea/project_idea/learning/general、零/多tags。
2. manual确认、编辑后确认、请求修订、拒绝、auto完成。
3. 列表筛选/分页/空状态/归档/恢复，详情Revision历史与source跳转权限。
4. 编辑冲突、离线、响应丢失、重复提交、切会话/切Run草稿隔离。
5. Markdown XSS、长正文、长tag、Unicode、代码块、外链安全。
6. 375/768/1440 viewport、键盘和焦点；review表单与Run Inspector整合不重复。
7. UI断言最终Note来自API Query，不能只检查聊天出现“已保存”。

### 完成门

- 用户能在真实浏览器找到笔记、确认其标签/来源、修订并刷新恢复。
- Candidate、Policy auto与正式Note在文案/状态上不混淆。
- Notes UI不向内核添加通用知识库需求。

## S5.6 真实E2E与跨流程复用审计

### 目标与结果

以一条真实模型+Workflow+浏览器Note场景证明第二流程可用，并用代码/测试审计证明没有为Note复制内核。

### 方案与真实主场景

1. 用户选择一段包含项目想法的Message，选择Note Capture和manual review。
2. note.extract生成title、project_idea kind、Markdown和tag建议。
3. 用户修改一个tag和正文后确认；系统创建正式Note Revision。
4. Notes列表按tag找到该Note，详情能回到来源Message并显示修订/Decision证据。
5. 刷新浏览器、重启API/Workflow后，Run图与Note内容不变。

### 复用审计

1. 统计新增控制流代码：不得出现与executeSequence/Choice/Loop/Human resume等价的Note副本。
2. 架构依赖测试证明Note domain不依赖workflows/web，Note Executor不打开Store，UI不导入Note持久Schema。
3. Catalog/Compiler/Runner/Viewer通用测试同时参数化Planning和Note Fixture。
4. 对比新增Node Type步骤是否全部经过Catalog、Parser、policy、Executor、projector、version evidence和测试。
5. 删除Note专用代码后，通用Kernel测试仍通过；删除通用Kernel保证时，Planning与Note测试都失败。

### 测试设计：故障与成本

- paid真实场景只调用最少模型轮次并记录调用数/token摘要。
- 模型失败、Candidate响应丢失、Decision冲突、commit失败使用可控Adapter完成矩阵。
- 同时发起Planning与Note Run，确认ProductRun分支、Node identity、Hook和Viewer不串。
- 无权限用户无法读取Note或通过source ref读取原Message。

### 完成门

- 真实Note存在于Product Store，列表/详情可查；不是仅有Artifact/Message。
- 同一Kernel支持两个产品场景且复用审计无第二引擎。
- Reminder、知识库分享、附件等未实现项在产品文案中没有伪入口。
- S5通过后才能合理投入S6设计器；否则先修复Kernel抽象，而不是用设计器掩盖Planning特化。

## 7. S5阶段反向验证

| 用户原始描述 | 产品回答 |
| --- | --- |
| 临时做笔记 | Note Capture Definition从消息/选区创建Candidate |
| idea、项目想法、学习积累 | 固定Note kind与可查询Revision |
| 打标签 | 候选tag经确认后成为canonical Note tags |
| 专门存储笔记 | Notes列表/详情由Product Store拥有 |
| 不同工作流 | Planning与Note是不同Definition，共用内核而非复制代码 |
| 明天提醒 | 明确不伪装完成，留给有调度/时区/投递语义的未来Blueprint |

S5通过证明“有限可配置工作流内核值得保留”；未通过则必须重新审视S3抽象，不继续堆S6画布。
