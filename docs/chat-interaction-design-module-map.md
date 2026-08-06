# Chat 90%交互设计模块总表

> 状态：**28个设计确认模块已获用户批准；MD-01模块内4项决定已获批准，当前1/28完成、27个待完成；下一模块MD-02尚未启动**（2026-08-01）
> 目标：把86个后台Interaction Unit压缩成用户可以一次看懂、一次展示、一次拍板的小工作包。
> 载体：先完成Web；同一套响应式界面和合同随后补齐PWA，不建设独立桌面App。

## 1. 已批准结论

2026-08-01用户批准把“确认Chat目标系统90%交互设计”拆成 **28个设计确认模块**，并把每批做1个还是2—3个的判断权交给设计执行者。

这里的“模块”不是一个页面、一个后端服务或一个按钮，而是一个能够独立回答的用户目标。每个模块必须能用：

1. 1个主参考；只有主参考确实缺关键状态时才增加1个辅助参考。
2. 1条正常主路径和1个最重要的失败、阻塞、冲突或恢复状态。
3. 1个轻量HTML，或1—3个关键画面。
4. 2—4个会影响后续组合的决定。

28个模块把当前86个Interaction Unit候选逐一且只分配1次。86项仍是后台防漏和最终覆盖率分母候选；用户当前只需审核
28个可理解的模块，不需要逐项阅读86条原子交互。

响应式重排、键盘与焦点、可访问性、loading/empty/error/partial/stale/forbidden、保存与返回反馈、视觉Token和动效原则
是每个模块的共同验收维度，不另外刷成模块。PWA安装、更新和认证恢复本身是用户目标，因此保留在MD-25中。

## 2. 调研是否已经足够

结论是：**足以停止泛调研并开始吸收，但不足以宣称外部产品的完整交互都已经实测。**

1. 广度已经足够：现有材料覆盖24个活动候选、28条参考流程、6个UX场景组和15条Chat自主设计链；继续扩竞品池的边际收益很低。
2. 严格事实仍有限：28条活动流程当前为0条O完整、1条O局部、27条无O证据。截图、文档和相邻模式不能冒充完整走查。
3. 因此停止全局扩表。进入每个模块时，只补该模块主参考所必需的入口、动作、反馈、保存/恢复与风险态事实。
4. Chat独有的版本、Hash、CAS、`outcome_unknown`、Evidence提交、Memory治理和管理员敏感访问不再强找“看起来相似”的竞品，直接自主设计并明确依据。

## 3. 28个设计确认模块

### A. 回来、捕获与按时间找回（3个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-01 | 快速捕获与Idea去向 | 先可靠保存一句未分类原话，之后可保持、归类或升级且不丢来源 | Routine | 捕获入口、保存反馈、撤销/重新找到和1个离线失败态 | 104、105 |
| MD-02 | Personal Home、注意力与继续工作 | 用户回来后知道今天继续什么、哪里异常，并能搜索或切换Session后回到正确Work/Project | Routine | Home首屏、Attention入口、搜索/Session继续与返回锚点 | 101、102、106、108、109、111 |
| MD-03 | Activity Calendar、Conversation Day与日/周复盘 | 按日期回看真实协作、修订Journal，并逐项完成、结转或放弃 | Routine | Calendar→某日记录→Review/Journal，补空白日或保存失败 | 103、107、110、510 |

### B. 自己管理工作、学习与周期事项（7个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-04 | Personal Workspace／我的工作台 | 跨生活、工作、学习、研究和未分类事项看清全局，并用多视图定位同一Work | Linear | Workspace总览、筛选/未分类、List/Board/责任视图一致性 | 201、207、214 |
| MD-05 | Today计划、时间容量与专注 | 把跨Project行动排成可开始序列，与日历容量协商并专注推进 | Super Productivity | Today排序、Timeblock冲突、当前行动计时；日期语义分开 | 202、203、211 |
| MD-06 | 单个Project档案、生命周期与资源 | 不看聊天也能判断Project目标、阶段、责任、缺口，并安全管理设置和资源 | Linear | 全宽Dossier、unknown/partial区块、Project/Repository设置 | 204、212、213 |
| MD-07 | Work Detail、Plan/Action与责任推进 | 从Project进入Work，修改计划和三类责任，再返回原筛选和位置 | Plane | Board/Dossier→Work Detail→责任与阻塞→原位返回 | 205、206 |
| MD-08 | 学习队列、练习与复习 | 从到期或薄弱点开始学习，完成反馈后得到可信下一复习状态 | RemNote | Queue、作答/评价、下一状态，补空队列或Evidence过期 | 208 |
| MD-09 | 研究、Knowledge与Memory治理 | 从来源化研究形成知识和下一Work；来源失效后纠正、降级或删除Memory | Capacities | 研究档案、来源关系、Knowledge对象与Memory Review | 209、215、506、507 |
| MD-10 | Schedule、Occurrence与Delivery | 建立周期规则，并分清每次Occurrence、独立Run、Artifact和最终送达 | Routine | Schedule Editor、Occurrence历史、Delivery失败与Receipt | 210、508、509 |

### C. 从输入变成可授权执行（6个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-11 | 权威查询与轻问答 | 区分0模型产品查询和普通问答，明确是否采用Context且不误建事项 | Chat自主设计 | 目录查询、查询空/失败、带Context提示的普通回答 | 301、302 |
| MD-12 | 澄清、目标关联与对象候选 | 模糊或同名输入时可补充、选目标或停在Idea/候选对象，不自动执行 | Replit Agent | Clarification、目标候选/都不是、Idea/Work/Project候选结果 | 303、304 |
| MD-13 | 多Intent分流 | 一句话含多个目标时分开Context和Plan，允许排序、取消与部分成功 | Chat自主设计 | Intent Set编辑、分支状态和partial结果聚合 | 305 |
| MD-14 | Context、Protocol、Workflow选择与Plan | 执行前看见采用依据、方法和Workflow版本，并修正计划、责任与验收 | Replit Agent | Context Inspector、方法/Workflow选择、Plan Review | 306、307、308、309 |
| MD-15 | ExecutionDraft与逐次Model Call审批 | 编辑系统执行草稿和真实Provider请求；任何变化都使旧授权失效 | Chat自主设计 | Draft、可读/JSON同源请求、revision/Hash失效和零发送放弃 | 310、311 |
| MD-16 | 跨Session冲突、Diff与重基 | 其他Session改了同一事实时比较影响并选择rebase、合并、保留产物或停止 | Chat自主设计 | 冲突Banner、Diff和4种处置结果 | 312、411 |

### D. Workflow Run看护、介入与恢复（4个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-17 | Workflow Run View、Human Decision与报告 | 打开Run就看懂真实路径、当前步骤和阻塞，并能回答决定、回跳报告证据 | Manus | Run View、Decision Sheet、Human Report/节点回跳；明确不用GitHub Actions式流水线 | 401、402、512 |
| MD-18 | Pause、Steer、Cancel、Reconnect与Checkpoint Resume | 用户介入或中断后选择正确动作，并理解暂停、转向、取消、接流和续跑后果 | Replit Agent | 控制栏、Amendment、Reconnect Banner/Checkpoint恢复 | 403、404、405、406、407 |
| MD-19 | Retry、Restart与Attempt历史 | 失败后判断重试步骤还是新Run重启，保留并比较旧Attempt | Vercel | 失败摘要、Retry/Restart选择、Attempt Compare | 408、409、414 |
| MD-20 | Tool授权、Operation Ledger与结果未知 | 调用前审参数/权限/副作用，调用后对账`outcome_unknown`而不盲目重发 | Chat自主设计 | Tool Request、权限影响、Operation Diff/Ledger与查询/补偿/人工判定 | 410、412、413、415 |

### E. 作品、证据与完成决定（2个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-21 | Artifact版本、评审与Canvas | 查看明确版本、锚定反馈、比较下一版；Canvas仍是独立Artifact类型 | Dropbox Replay | Gallery/Preview、Review/Version Compare和Canvas版态 | 501、502、511 |
| MD-22 | Evidence、Validation与Result Commit | 沿Requirement核验证据和验证结果，再接受、部分接受、修复或拒绝 | Chat自主设计 | Evidence/Provenance链、Validation逐项结果、Result Commit Sheet | 503、504、505 |

### F. 配置、身份、跨入口与运营（6个）

| ID | 模块 | 本模块只解决的用户目标 | 主参考 | 一次展示什么 | 覆盖IU |
|---|---|---|---|---|---|
| MD-23 | Agent、Workflow与HITL配置 | 看懂运行方法的实际来源，安全修改Agent、Workflow版本和HITL继承策略 | Chat自主设计 | Config Center有效来源、Revision预览、Workflow/HITL矩阵 | 601、614、615、618 |
| MD-24 | Provider、模型与Tool配置 | 配置真实Provider、模型和Tool能力时看清兼容、限制、密钥与生效边界 | Chat自主设计 | Provider→模型联动、Tool Profile、不可用/重启提示 | 616、617 |
| MD-25 | 身份、Scope、设备与PWA连续性 | 安全登录和撤权；从Web/手机/Channel/PWA恢复原目标而不重复动作 | Chat自主设计 | Login/Forbidden、设备Session、跨入口与PWA离线/更新恢复 | 602、603、604、619、620 |
| MD-26 | Obsidian／第三方投影与受治理写回 | 外部载体显示同一ID/revision/新鲜度，外部编辑只形成ChangeSet而不双写 | Obsidian LifeOS | Projection预览、stale/partial、ChangeSet Diff/冲突/提交 | 605、606 |
| MD-27 | Super Admin运营总览与使用下钻 | 管理员可信发现用户、使用、Work、Artifact/Evidence异常并返回原筛选 | Chat自主设计 | Admin Home、不同时间口径、用户/Project/Artifact元数据下钻 | 607、608、609 |
| MD-28 | 敏感访问、管理员审计与Runtime Diagnostics | 以最小披露处理高权限访问、Grant和技术故障，并留下可复核审计 | Sentry（只辅助诊断下钻） | Sensitive Access Gate、Role/Grant影响、Audit与脱敏Diagnostics | 416、610、611、612、613 |

## 4. 已确认不会漏掉的关键边界

1. Personal Home、Personal Workspace和当前Run的Workbench不是同一页面责任。
2. Project Dossier、Work Detail和Continuous Chat不是同一个档案层级。
3. Workflow Selection、Workflow Run View和Canvas不是同一个界面。
4. Activity Calendar记录过去协作；Schedule安排未来触发；Today表达用户选定的行动序列。
5. ExecutionDraft、Model Call、Tool Request和Result Commit是4种不同审批对象。
6. Pause、Cancel、Reconnect、Resume、Retry和Restart不会压成一个“重试”按钮。
7. Artifact存在、Evidence有效、Validation通过、Result Commit成功、Work完成和Delivery送达不会互相冒充。
8. 普通用户身份、Super Admin运营看护、管理员敏感访问审计和Runtime Diagnostics不会互相替代。
9. GitHub Actions已明确退出参考；Workflow Run View使用Manus/Replit的用户节奏作邻近参考，核心状态仍由Chat自主设计。
10. Super Productivity保留，并只在Today行动序列、原位层级和专注反馈等已确认范围内使用。

## 5. 已批准的推进与合批规则

1. 默认一次只处理1个模块；MD-01已用来校准事实颗粒度、效果规模和拍板节奏，后续继续遵守同一边界。
2. 两个新模块只有同时满足以下条件才可合批：前一终点就是后一入口；同一角色、主要呈现面和权威对象链；复用同一主参考与事实走查；不包含高影响审批、结果未知、并发、Evidence、Delivery、Identity/Admin或恢复语义；合并后不超过1条主路径、4个关键画面、1个风险态和6个决定。
3. 三个模块只用于已经分别获批后的组合一致性走查，不用于3个新模块的首次设计或首次拍板。
4. 合批前必须公开本批模块、合批原因、各自边界和明确不做项；用户仍可单独批准、退回其中任一模块。
5. 每个模块先补主参考的必要事实；无直接参考时写清Chat合同和自主设计依据。
6. 每个模块分别给出采用、改造、拒绝和未验证项，并提交小效果与2—4个决定。
7. 批准后只更新已获批模块对应的Interaction Unit，再选择下一批。
8. 在约30%、60%和90%处做3次跨模块一致性走查，不提前制作巨型整合原型。

当前没有活动批次。[MD-01参考事实、交互合同和可操作原型](./ui-ux-modules/md-01-quick-capture-and-idea-destination.md)
已获用户批准，对应`IU-104`、`IU-105`进入设计批准记录；后端实现仍待完成。下一次从`MD-02 Personal Home、
注意力与继续工作`开始，但本次归档不启动。跨Session恢复统一进入
[交互设计续接入口](./chat-interaction-design-handoff.md)。
