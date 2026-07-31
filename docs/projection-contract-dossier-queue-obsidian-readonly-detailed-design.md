# Projection合同、Project Dossier、个人工作台与Obsidian只读详细设计

> 状态：**已批准；固定本地Scope只读纵向切片已实现**（2026-07-30）  
> 工作包：`W4-03`  
> 上位边界：[总体架构§8.3](./overall-architecture-proposal.md#83-app-projectionprojection-query--command-gateway)、[能力开发地图D2](./product-capability-architecture-map.md#7-d2多前端投影与obsidian合同)  
> 重要限制：本轮实现不是完整多用户Projection、双向Obsidian同步、Schedule、Delivery或完整Evidence/Artifact视图；这些区块必须显示真实的`unknown/partial`。

## 1. 结论

Chat正式采用一条同源呈现链：

```text
14个状态所有者的公开Query/Event
 -> APP-PROJECTION Read Model Composer
 -> 带schema/revision/freshness/permissions/section-state的Envelope
 -> Web Adapter / Obsidian Adapter / 第三方Adapter
```

1. Project、Work、Note、Evidence等权威事实仍归对应模块；Projection不建第二套领域库。
2. Web工作台和Obsidian目录使用同一稳定对象ID、源revision和Projection revision。
3. Web可采用卡片、看板、责任泳道和进度摘要；Obsidian采用目录与Markdown。它们只是不同Presentation Adapter，不定义不同业务事实。
4. 当前落地为**固定`local-user` Scope、即时组合、只读Web + 可下载确定性Obsidian ZIP**。服务器不接受任意本地路径，也不写用户Vault。
5. 后续编辑只能生成`ChangeProposal/ChangeSet`，经Identity、CAS、HITL、Validation与源模块命令写回；Markdown永远不直接覆盖Product Store。

## 2. 三类合同不能混用

| 层 | 例子 | 谁拥有 | 是否权威 |
|---|---|---|---|
| Domain Fact | Project、WorkItem、NoteRevision、Action、Evidence | 14个状态所有者 | 是 |
| Projection Read Model | Personal Workspace、Project Dossier、Learning Queue、责任泳道 | APP-PROJECTION，可重建 | 否 |
| Presentation Artifact | React组件、Markdown文件、ZIP、Obsidian链接 | 各Adapter/浏览器 | 否 |

前端页面状态、展开项、排序、搜索词和当前打开Project只存浏览器；Projection缓存可丢弃；任何文件mtime、目录名或Checkbox状态都不能成为Product revision。

## 3. Projection Envelope v1

所有稳定视图返回：

```json
{
  "schema_version": "1.0",
  "view_schema": "project-dossier.v1",
  "view_type": "project_dossier",
  "subject": {"kind": "project", "id": "...", "revision": 3},
  "projection_revision": "sha256...",
  "generated_at": "...",
  "source_snapshot_at": "...",
  "freshness": {
    "status": "fresh",
    "as_of": "...",
    "source_updated_at": "...",
    "consistency": "per_query_snapshot_with_revision_vector",
    "reason_code": null
  },
  "source_revisions": [],
  "sections": {},
  "permissions": {},
  "data": {}
}
```

### 3.1 revision语义

1. `projection_revision`是Envelope语义内容的SHA-256，不包含`generated_at`，同一事实重复生成保持一致。
2. `source_revisions`按Owner/资源/ID/revision稳定排序并去重；跨Owner快照不冒充单数据库全局事务。
3. `source_snapshot_at`取可观察来源的最新更新时间；没有来源时间时为`null`，不能用生成时间冒充。
4. JSON和ZIP响应公开`ETag`、`X-Projection-Revision`与`X-Projection-Schema-Version`；相同revision的Obsidian请求支持304。

### 3.2 区块状态

| 状态 | 含义 | UI/文件必须怎样显示 |
|---|---|---|
| `available` | 成功读取且有事实 | 展示事实与来源 |
| `empty` | 成功读取，确定没有对象 | “尚无…”；可给创建入口 |
| `partial` | 有部分事实，覆盖不完整 | 显示已有数据和缺口说明 |
| `unknown` | 未实现、来源不可确定或引用失效 | 显示未知原因，不能显示0 |
| `forbidden` | 当前Principal无权读取 | 隐藏内容，显示权限原因 |
| `error` | 本区块读取失败 | 显示错误与重试；其他区块可继续 |

整个核心Subject不存在/不可见时返回404；核心Owner查询失败返回整体错误，不能生成一个假空Dossier。可选Owner失败独立降级，并记录结构化日志而不输出内部异常。

### 3.3 权限投影

当前只读切片诚实返回：

```text
authorization_mode = legacy_fixed_scope
audience = local_scope_user
principal_id = local-user
allowed = view, export_obsidian
denied = propose_projection_change(readonly_projection_slice),
         cross_user_view(identity_not_implemented)
```

Identity落地后由Authorization Query生成真实Principal/Role/Scope能力；客户端不能提交或覆盖这一字段。

## 4. Personal Workspace v1

### 4.1 入口与筛选

Web App Shell新增一级“我的工作台”，包含`全部/生活/工作/学习/研究`5个筛选。筛选只改变Projection查询，不建立5套Project模型：

| Project kind | 工作台领域 |
|---|---|
| `delivery` | `work` |
| `learning` | `learning` |
| `research` | `research` |
| `personal` | `life` |

无法确定归属的独立Work只在“全部”显示为`unclassified`；Projection不得根据标题猜它属于生活还是工作。

### 4.2 用户看见的信息

工作台固定显示：

1. 来源可信行：固定Scope限制、快照时间、同源ID/revision说明。
2. 总览：当前Project数、开放Work数、开放Action数、阻塞数；明确“状态计数不代表质量或投入时长”。
3. Project卡：领域、标题、目标、状态、Work状态计数、责任分配、下一行动、关注项和稳定ID入口。
4. 责任分配：`你 / Chat与AI / 外部协作`3类，不只靠颜色区分。
5. 独立Work：没有Project的事项及“不猜分类”说明。
6. Learning Queue：学习单元完成数、下一行动；下一复习时间在Schedule未实现时显示`unknown`。
7. 搜索：只查正式Project标题/目标；搜索结果保留stable ID，打开准确Project而不是回到泛化列表。

### 4.3 API

```text
GET /api/projections/workspace?domain=all|life|work|learning|research
```

当前一次最多组合100个非归档Project与100个独立Work/Action；查询第101项作为截断哨兵，达到上限时
`sections.projects/independent_work=partial`，`data.limits.*_truncated=true`，Web显示非全量提示。未来分页必须新增稳定Cursor，
不能静默截断或把当前100项冒充全量。

## 5. Project Dossier v1

Project Dossier是“脱离聊天仍能掌握项目”的用户交付面，不是内部总账。固定区块：

| 区块 | 内容 | 来源Owner |
|---|---|---|
| 身份与目标 | Project ID、kind、title、goal、status、row_version、更新时间 | MOD-WORK |
| 当前阶段 | current milestone及引用有效性 | MOD-WORK |
| Work与Plan | Work、当前已接受Plan revision、节点依赖与状态 | MOD-WORK |
| 责任泳道 | Action优先；未转Action的已接受PlanNode补充显示 | MOD-WORK |
| 下一行动/关注 | 开放Action、阻塞、活跃但无下一行动 | MOD-WORK派生 |
| 知识 | Note/Revision、Accepted Memory（边界分开） | MOD-KNOWLEDGE/MOD-MEMORY |
| 方法 | 当前有效Protocol与Binding revision | MOD-PROTOCOL |
| 资源 | Repository Binding与快照摘要 | MOD-WORK公开资源Query |
| Evidence | 当前Work/Action中的Evidence引用 | MOD-EVIDENCE（当前仅partial） |
| Activity | 产品领域事件摘要，不含隐藏推理 | 源Owner公开Trace |
| Schedule | 下一触发、时区、misfire状态 | MOD-SCHEDULE（当前unknown） |
| Delivery | 交付与回执 | MOD-DELIVERY（当前unknown） |

责任去重规则：如果Action已经引用某PlanNode，只显示Action，因为它表示更具体的正式承诺；不能在Agent泳道把同一步骤计数2次。

API：

```text
GET /api/projections/projects/{project_id}/dossier
```

路径ID做URL编码、Scope过滤和防枚举处理；响应不接受客户端Principal/Scope参数。

## 6. 不同角色的信息显示

### 6.1 责任角色（Project内部）

| 角色 | 显示内容 | 用户动作 | 不应显示成什么 |
|---|---|---|---|
| `user` | 用户已承诺Action、未转Action的已接受Plan步骤、due、状态、Evidence数 | 继续、完成申请、阻塞说明 | 把Agent建议当用户承诺 |
| `agent` | 已授权或可授权给Chat/AI的正式行动、运行状态入口 | 审核、启动、停止、查看公开结果 | 隐藏推理、未批准Tool动作 |
| `external` | 老师、同事、客户等外部依赖及状态 | 记录反馈、标阻塞、发起Delivery | 假装外部人员已完成 |

### 6.2 产品读者角色

| 读者 | Workspace/Dossier | Obsidian | 额外信息 |
|---|---|---|---|
| 未认证 | 不可见 | 不可导出 | 只见认证入口 |
| 普通用户 | 自己Scope完整允许区块 | 可导出自己Project | 自己的下一行动和个人设置 |
| Collaborator | Grant范围内字段；私人Memory可隐藏 | 只导出获准区块 | 外部责任和协作状态 |
| Agent/Worker | 不使用人类Dossier作Prompt；读取RunSpec最小包 | 无任意Vault访问 | 仅公开执行合同和能力 |
| Super Admin | 默认看运营摘要/异常，不默认看内容 | 导出敏感内容需额外能力与审计 | 新鲜度、失败、用户活动口径 |
| 第三方Adapter | 仅支持声明的Projection schema与字段 | 自管缓存，可重建 | 不得到Credential/隐藏推理 |

角色过滤发生在服务端Composition之前；Adapter不能收到敏感字段后再用CSS隐藏。

## 7. Obsidian只读文件协议 v1

### 7.1 导出方式

```text
GET /api/projections/projects/{id}/obsidian/tree
GET /api/projections/projects/{id}/obsidian.zip
```

`tree`用于Web预览/第三方Adapter，返回文件路径、媒体类型、SHA-256、大小和文本内容。`zip`用于下载后解压为Vault或并入现有Vault。服务器端不接收输出目录、不解析用户机器路径，也不修改仓库内`项目掌握/.obsidian`。

### 7.2 稳定目录

文件路径只使用服务端验证过的稳定ID，不使用标题；标题只出现在正文：

```text
README.md
Projects/{project-id}/
  README.md
  Work/
    {work-id}.md
  Responsibilities/
    user.md
    agent.md
    external.md
  Knowledge/
    {note-id}.md
  Evidence/
    README.md
  Resources/
    repositories.md
  Methods/
    protocol.md
  Reviews/
    current.md
  Learning/                 # 仅learning Project
    review-queue.md
  .chat-projection/
    manifest.json
```

这样即使标题是`../../儿童:AI\\计划`也不会产生路径穿越、跨平台非法文件名或重命名身份漂移。

### 7.3 Frontmatter

每个Markdown至少包含：

```yaml
chat_schema: "obsidian-project-file.v1"
chat_kind: "project"
chat_id: "<stable-id>"
source_revision: "3"
projection_schema: "project-dossier.v1"
projection_revision: "<sha256>"
source_snapshot_at: "<utc-or-null>"
read_only: true
```

不同文件可增加`project_kind/status/assignee_kind/note_kind`等只读字段。正文使用稳定相对Wiki Link，显示标题可以变化而链接身份不变。

### 7.4 Manifest与确定性

Manifest记录Adapter、Project、Projection schema/revision、source revision vector、按路径排序的文件元数据和`payload_tree_hash`。顶层`tree_hash`计算包含Manifest在内的最终文件树；两个Hash含义不得混名。

同一Dossier必须产生字节一致ZIP：

1. POSIX路径排序；
2. 固定ZIP时间戳、权限和UTF-8标志；
3. 当前使用`ZIP_STORED`避免压缩库差异；
4. 每文件2 MiB、总计20 MiB、最多500文件；
5. 禁止绝对路径、`..`、反斜线、控制字符和大小写冲突；
6. 文件SHA-256与tree hash可复核。

### 7.5 当前只读语义

1. 用户在Obsidian勾选、改Frontmatter或改正文不会写回Chat。
2. 再次下载是一个新快照；覆盖/合并由用户本地工具负责，当前不承诺增量同步。
3. 文件明确写`read_only: true`和未知能力；不得让用户误以为修改已经生效。

## 8. 常用场景穿透与呈现

### 8.1 新建工作交付Project

用户说：“新建一个客户官网改版项目，9月交付。”

1. Conversation保存原Message。
2. Intent/Proposal形成`Project(kind=delivery)`，可同时形成Milestone、Work和外部客户Action；未批准前只在候选卡。
3. 批准后MOD-WORK创建稳定Project ID与revision。
4. Web“工作”筛选出现Project卡：目标、开放Work、下一行动、用户/Agent/外部责任。
5. Dossier显示Plan、客户反馈依赖、Repository和Evidence覆盖。
6. Obsidian生成`Projects/{id}/README.md`、Work与3类责任文件；9月的正式触发/提醒仍需Schedule，不能从一句日期假装已排程。

### 8.2 学习英语

用户说：“我要提高英语口语，每天学单词、看一篇短文和一个视频。”

1. 建立`Project(kind=learning)`；词汇、短文、视频/复述可成为`WorkItem(kind=learning_unit)`。
2. Note积累生词、错误与来源；掌握需要测验/作品Evidence，不以完成数量代替。
3. 用户泳道显示练习，Agent泳道显示生成材料/反馈，external显示老师反馈。
4. Web Learning Queue显示完成单元与下一行动；Schedule未实现时“下一复习”明确unknown。
5. Obsidian额外生成`Learning/review-queue.md`和每个学习Note文件。

### 8.3 为小朋友学习AI

用户说：“给孩子做一个AI学习项目。”

1. 系统需澄清年龄、目标、安全边界和参与人，不能从“孩子”自动收集或公开敏感数据。
2. Project为learning；体验活动、共同创作、反思分别建Work/Note/Evidence。
3. 家长是user责任；Chat生成解释/素材属于agent责任；老师/另一位监护人属于external责任。
4. Dossier让用户看到目标、当前模块、谁陪同、作品证据和未知Schedule。
5. 文件结构与普通学习Project同一协议，不另建“儿童AI”孤岛数据库。

### 8.4 个人生活Project

“安排暑假旅行”创建`Project(kind=personal)`；路线选择、预算、订票可作为Work，家庭成员确认作为external Action。Web在“生活”筛选显示；Obsidian仍使用相同Dossier目录。支付/订票属于高影响Tool副作用，必须审批与对账，不能因出现在生活工作台就降低治理。

### 8.5 研究Project

“研究家庭AI设备”创建`Project(kind=research)`与`research_question` Work；Knowledge显示来源Note，Evidence区分事实、冲突和未知。Agent可负责搜集/归纳，用户负责取舍，专家评审是external。当前外部来源抓取失败显示unknown，不能让模型补造来源。

### 8.6 软件开发Project

Project绑定Repository；Work/Plan/Action承载需求与步骤，Agent责任链接受治理pi/Workspace Run，Evidence显示测试/Artifact引用。Web Dossier和Obsidian `Resources/repositories.md`只显示允许的相对资源与快照摘要，不泄漏服务器绝对路径或密钥。

### 8.7 内容创作与交付

选题、提纲、草稿、审校和发布使用Work；文章/图片属于Artifact，来源与质量属于Evidence，发布回执属于Delivery。当前Dossier可显示Work和部分Evidence引用，但Artifact Gallery与Delivery为unknown；不得用“文件已生成”冒充“已发布”。

### 8.8 Idea捕获后升级

“以后想做家庭知识库”先是Knowledge Idea或独立Note，不自动变Project。用户决定升级后才创建Project，原Idea保留升级链接。工作台只列正式Project；Idea Garden属于另一Projection View，避免列表被未承诺想法淹没。

### 8.9 独立事项

“本周缴水费”可以是无Project Work。工作台“全部”显示在未归类区，并说明Projection不会猜生活/工作。用户以后可通过正式命令归入Project；搜索和文件导出不按标题自动归档。

### 8.10 周期复盘

“每周五复盘项目”目标链是Schedule定义→Trigger→Run→Review/Evidence→Projection。当前只生成`Reviews/current.md`的已有活动摘要，不创建真正下次触发；Dossier Schedule区显示`unknown(schedule_not_implemented)`。

### 8.11 外部协作阻塞

客户/老师/同事未反馈时，external泳道显示开放Action，关联Work可标blocked，关注区解释原因。系统不能把“已发消息”推断成“对方已确认”；未来Delivery Receipt与外部Action状态通过显式合同关联。

### 8.12 超级管理员看护

管理员默认看跨用户数量、新鲜度、异常和阻塞运营Projection，不复用个人Workspace，也不直接下载用户Obsidian内容。查看敏感Dossier需要明确能力、理由与审计；当前Identity/Admin Ops未实现，因此本轮没有伪造管理员视图。

## 9. 前端交互与无障碍

1. 一级导航区分“主页”“我的工作台”“对话”；右侧Harness Workbench仍服务当前Interaction，不冒充长期Project工作台。
2. Project Dossier使用全宽页面；浏览器返回操作恢复到原Project卡焦点。
3. 搜索和卡片跳转始终携稳定ID；“继续推进”把Project ID写入输入草稿，避免只靠同名标题。
4. 加载、空、错误、部分和未知状态分别呈现；旧数据可继续显示时，刷新错误不清空已有Dossier。
5. 所有按钮有语义类型、键盘焦点和可见focus；角色不仅依赖颜色；尊重`prefers-reduced-motion`。
6. 移动端保留工作台一级入口和完整Dossier，不以隐藏区块冒充响应式。
7. 重型工作台通过真实lazy import加载；根`App.tsx`保持在800行审查线内。

## 10. 后端实现边界

当前文件落点：

```text
backend/app/harness/projection_queries.py   # Work/Knowledge公开只读快照边界
backend/app/projections/contracts.py        # Envelope、状态、revision
backend/app/projections/service.py          # Read Model Composer
backend/app/projections/workspace.py        # Personal Workspace纯投影规则
backend/app/projections/obsidian.py         # 纯确定性File Adapter
backend/app/projections/api.py              # REST DTO、ETag、ZIP
```

不变量：

1. Projection Service无写事务、模型调用或外部副作用。
2. Router不读数据库；Composition Root注入Query Port。
3. Obsidian Renderer只接受`project-dossier.v1`并执行路径/大小验证。
4. 可选Protocol/Repository查询失败独立降级并记录不含秘密的结构化日志。
5. 无新Projection领域Schema或迁移；响应可由源事实重建。

未来数据量超过即时组合能力时，可增加Read Model Cache、Projection Cursor和Sync Attempt，但它们只保存派生状态与处理进度，永远不拥有Project/Work事实。

## 11. 双向写回目标协议（未实现）

后续Adapter编辑链固定为：

```text
edited file/page
 -> parse stable chat_id + source_revision
 -> supported-field diff
 -> ProposeProjectionChange
 -> ChangeProposal/ChangeSet
 -> Identity/Scope authorization
 -> current source read + three-way diff
 -> CAS + required HITL/Validation
 -> owner Command
 -> new source revision
 -> regenerate Projection
```

必须处理：本地新文件、删除、重命名、旧revision、两端并发、部分成功、未知字段、附件、冲突保留和幂等Sync Attempt。任何一项未定义前，不能把`read_only`改为false。

## 12. 测试矩阵

### 12.1 已实现自动测试

1. 4种Project kind映射到工作/学习/研究/生活，独立Work/Action保持未分类且领域筛选不误计数。
2. user/agent/external 3条责任泳道与Action/PlanNode去重。
3. Note进入Dossier；Evidence为partial，Artifact/Schedule/Delivery为unknown。
4. source revision去重、语义revision不受生成时钟影响。
5. 恶意标题不进入路径；文件树和ZIP字节确定；目录按stable ID生成。
6. Workspace、Dossier、Tree、ZIP、ETag、404和前端API ID编码。
7. 101个Project时只返回100项并显式报告`partial/*_truncated`，相同revision重复生成稳定。
8. 前端401与403恢复动作分开、类型检查、Node合同、桌面/Pixel 5工作台与旧资源管理链。

### 12.2 仍需补齐

| 风险 | 必测 |
|---|---|
| Identity | 两用户同名Project、字段级过滤、防枚举、Grant撤销 |
| 大数据 | 稳定分页cursor、性能预算、并发source变化；100项截断状态已有回归测试 |
| Cache | rebuild、stale、失效、重复Event、游标断裂 |
| Obsidian写回 | 三方Diff、CAS、删除/重命名、冲突文件、幂等重试 |
| 完整Evidence | Artifact/Claim/Validity/失效传播和项目归属 |
| Schedule/Delivery | Trigger freshness、misfire、Receipt与unknown结果 |
| 浏览器 | Desktop/390px、键盘、axe、下载/解压/Obsidian真实打开 |

## 13. 完成定义与诚实边界

### 13.1 本轮已经满足

1. 用户可在Web一级“我的工作台”查看生活、工作、学习、研究Project。
2. 可打开Project Dossier，看目标、状态、Work/Plan、3类责任、下一行动、知识、部分Evidence及缺口。
3. 可预览并下载稳定ID目录的只读Obsidian ZIP；相同事实得到相同revision/tree/ZIP。
4. Web与Obsidian都来自Product Store同一份事实，没有新增第二事实源。

### 13.2 本轮仍不保证

1. 真实多Principal/Role/Grant、跨用户或管理员信息过滤。
2. Obsidian编辑写回、自动同步、增量cursor、离线合并或服务器直接写Vault。
3. 复习日程、周期触发、Calendar、Delivery和外部回执。
4. 完整Artifact/Evidence/Provenance及其失效传播。
5. 大规模Project稳定分页Cursor、持久Read Model缓存和跨实例Projection Worker；当前只保证达到100项时诚实标记partial。

因此W4-03从`planned`进入`in_progress`，CAP-18从`missing`进入`partial`；只有第13.2项按各自工作包完成后才能标记完整。
