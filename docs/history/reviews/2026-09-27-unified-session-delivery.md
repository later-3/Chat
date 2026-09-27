# 统一 Session 后端与导航性能交付

状态：实现与全门禁完成；未提交、未推送、未部署。隔离工作区 `codex/unified-session-performance`，父基线 `fe296a63a`、Frontend `850ecf6b`。43110 未停止、未重建、未改正式数据。

## 实现结果

Project、Friend 日常/后台工作、Topic 节点的**新轮次**均使用 `startChatWorkflow` → 真实 Workflow SDK → 公共装配 → Pi Session。Friend/节点发送入口保留业务授权和顺序；它们不是独立 Agent Loop。旧无 workflow 字段的接受记录保留兼容执行，不搬动原生历史；群聊参与者的专用调度不在本次单聊改造范围。

- Friend/Topic 输入区可选择下一轮 Workflow；默认直接聊天仍是 Friend 原有冻结工作能力，规划等流程保持自己的阶段角色并带可信 owner/协作项目上下文。切换不换 Session，不启动额外 Run。
- 受理记录冻结 Workflow/id/invocation，Run 绑定先于队列派发。派发日志只保存 SDK 的原样公开队列参数，恢复复用相同 runId。
- 审核、事件、停止、子调用、remember 都归同一个 Run；主题锚点在整轮结束且标记落盘后才开放。relay 的原生消息唯一性、来源和冻结项目沿用既有合同。
- API 与 Step bundle 共用同进程写锁/取消句柄，SDK 与领域文件仍是耐久事实源。
- 默认聊天完整保留 Friend 定义；业务 Workflow 的角色配置继续由其公共 Resolver 解析。本次没有把所有阶段都改成 Friend，也没有新增一套 Agent 设置。

## 功能证据

| 用户链 | 验证 |
|---|---|
| 同一 Friend Session 默认 → 规划审核 → 默认 | 真实 Nitro/SDK/Pi；历史、SessionId 不变，工作请求含 Friend 身份 |
| 审核时进程被终止后批准 | 新 Backend 复用同一 runId/invocation/审核 Hook |
| 节点选择 problem-diagnosis | 真实 SDK 业务 Workflow 完成，节点得到一个 settled 锚点 |
| 工作/记忆阶段进程中断 | 两阶段分别真实 kill；interrupted，可读历史，无未知工具自动重放 |
| remember 停止、重复停止终态 | 真实控制 API；cancelled，不改写成功；remember 不吃工作引导 |
| 创建/修改/批准、聊天、记忆、补充、fork、刷新 | topics-browser 与 topic-create-workflow 真实 Runtime/浏览器门禁 |
| Channel、后台工作、每日边界、群聊 | 原有领域门禁及 LA6/Nano 联合、群聊 HTTP/浏览器保持通过 |
| 缓存正确性 | 原生追加/重命名/删除可见，项目隔离、取消、并发合并、下一次导航重读 |

领域单测用 transport fixture 执行相同 Workflow body 与 Pi；它们不冒充 SDK 证据。`scripts/unified-session-runtime.test.mjs` 已纳入 `pnpm test:dev`。主题创建脚本的来源数据预置已适配 transport fixture，真正创建流程仍在独立 Nitro 进程使用真实 Runtime。

## 性能路径与结果

慢的主因是会话列表轮询反复解析所有历史，而非 Pi 模型本身：多项目 fan-out 与详情读取争用同一 Backend；详情又重复携带完整分支树。

现在的点击路径：

1. 仍由后端解析今天的 Friend Session（最终暖测请求 p50 11ms / p95 21ms）；不复用失效的每日归属。
2. 已访问会话先绘制有界最近视图，后台重新 GET 权威详情；冷会话等待一次合并 GET。页面切换只取消观察，不取消工作。
3. 详情保留完整当前消息，分支导航只传 ID、标签、预览，工具图片/思考按需读取。
4. 列表改为一个 overview 请求，共用归属快照；文件未变时只 stat、不 parse 正文；ETag 未变 304，不触发列表重绘。侧栏搜索保留完整首条发言，没有以截断搜索范围换速度。

实验：同一台 Mac，Chrome/CDP，1440×1000，生产构建，隔离复制 **187 个原生会话、约 50MB**。没有响应拦截，没有真实模型参与导航；会话内容未入证据。采样的三个日常目标为 23/0/0 条上下文消息；最终复测跨过午夜，仅把隔离副本的每日绑定日期从 26 日平移至 27 日，原生消息文件和消息数不变，大会话另做 API 读测试。浏览器断言目标 Session ID、消息数、可见可输入的 composer，再等两帧。

| 场景 | 次数 | 消息与输入可用 p50 / p95 | 稳定绘制 p50 / p95 |
|---|---:|---:|---:|
| 页面内首访（服务端已热） | 3 | 64 / 82ms | 97 / 101ms |
| 暖切换 | 50 | 32 / 33ms | 65 / 66ms |
| 与后台轮询重叠 | 10 | 35 / 38ms | 69 / 71ms |

页面内首访只有 3 次，是观察值，不是进程冷启动测试；暖态与轮询是分别采样，不是所有设备/所有会话的 SLA。新实现仅完成缓存/树优化、尚未合并列表时，轮询重叠 p95 289ms；最终构建合并后为 38ms。更早的真实副本基线轮询碰撞约 2 秒来自先前诊断，测法/样本量不同，不当作严格 A/B 百分比。

18,049,034 字节原生大会话，**202 条当前消息保持不变**：详情 19,484,665 → 1,445,347 字节（减少约 92.6%）；5 次读取中位数约 168 → 97ms。这是 API 数字，未冒充该大会话的浏览器绘制耗时。

较早一轮同规模暖测为消息/输入 p95 50ms、绘制 83ms；最终复测为 33/66ms。环境波动确实存在，不选择性隐藏前一轮。

私有原始数字在 `.data/verification/unified-session/{navigation,before-overview,large-session}.json`，不入 Git。复跑：`node scripts/unified-session-perf.mjs http://127.0.0.1:<隔离端口> 50`；跨日需先准备该日期的等量目标会话，不用空会话替代有历史目标。

## 验证与交付边界

最终 `pnpm verify` **exit=0：56 tooling / 655 Backend / 199 Frontend / 30 built / 12 dev**，含类型检查、Builder、Nitro 开发 Step、生产构建和真实 Runtime。父仓库与 Frontend `git diff --check` 干净；架构导航通过（154 entrypoints）。新实现位于隔离 worktree，原仓库仅保留任务前已有的未跟踪评估文档。

导航数据没有改 Session 权限、编辑 CAS、轮次结果或执行重试语义。大历史首屏仍需读取当前分支，冷磁盘与 Markdown 渲染有成本；没有宣称任意 18MB 会话冷打开都在 100ms 内。本批不包含多实例共享 Chat Home、动态热装 Workflow 或重写 Pi。

隔离预览：`http://127.0.0.1:63291/`，使用数据副本供界面和切换验收，没有装入正式模型凭据。生产 43110 健康为 200，未发布新构建。

## 同日补充：切换刷新感

用户在隔离预览反馈“已更快，但点击 Friend 仍像刷新”。原因是三处 UI 中间状态：所有联系人短暂禁用并降透明度；ChatWindow 隔离挂载后先渲染 loading，再异步应用已有响应；首屏滚动延后一帧。

修正保留 keyed Session 隔离、后台权威读取与原 Run：已交接数据在 layout effect 同步解析进入首帧，首次滚动在绘制前定位；导航禁用不降低整列透明度，超过 300ms 才显示打开文字。没有通过更长 TTL、丢消息或取消后台执行掩盖问题。

定向浏览器门禁 `session-memory-switch-browser.test.mjs` 已通过：跨两个 Friend 再切回原会话，MutationObserver 与逐帧采样均无聊天输入消失、无联系人灰闪，原答案保留，记忆开关/失败通知原链通过。`chat-auto-scroll.test.mjs` 7/7，新增首屏不等待动画帧的断言。速度基线与视觉连续性是分别的证据，未将旧毫秒采样冒充本次新测量。

[当前架构](../../architecture/chat-current-architecture.md)的组件图、入口链、目录与 Workflow 清单已更新；[导航性能](../../development/session-navigation-performance.md)维护全流程、失效规则、预算、基线与连续性验收。隔离 63291 已重建并刷新验证，正式 43110 未动。

本次补充完整验证：`pnpm verify` exit=0，56 tooling / 655 Backend / 200 Frontend / 30 built / 12 dev。架构导航 155 entrypoints；父/前端 diff 检查通过。63291 与 43110 健康检查均为 200；未提交、未推送、未部署正式服务。

## 同日补充：Chat 项目会话在预览中 404

用户指定的 `test · nexus` 群参与 Session 在正式 43110 可读，63291 先报 cwd 不匹配；修正副本路径后暴露缺少群登记。原因是预览夹具只准备了部分领域依赖，不是模型轮次失败，也未发现本次执行链回归。隔离副本 33 个 header 与实际 Registry 对齐（消息 Entry 字节逐文件保持不变），补齐 3 个引用群定义；没有放宽任何产品权限检查、没有修改正式数据、没有复制工作队列/渠道/投递。

新增 `unified-session-perf.mjs ... --audit-sessions` 作为分享预览前门禁。实际 187 个列出会话修复前 181 可读、6 个 404（exit=1）；修复后 187/187（exit=0）。目标会话 12 条消息可读，无历史 assistant error 和 failed Run。私有修复记录为 `.data/verification/unified-session/preview-path-repair.json`，批量结果为 `session-audit.json`；不入 Git。本次不改 Backend/Frontend 产品代码，也不以过去的完整 verify 冒充新执行。

## 同日补充：历史日历与记忆目录

Friend 列表增加日历入口：年度格子展示哪些日期有每日 Session，月份视图以绿点标识，点击读取已有会话。按 Agent 时区显示日期，沿用日常 Session 索引和公共 ChatWindow；查看历史不创建会话，也不开放历史写入。年度接口可返回超过 60 天的记录，默认状态接口仍保留最近 60 天合同。绿色只代表有 Session，不代表工作量、消息数或任务成功。

记忆页出现两个 Nexus 的根因是 Project 过滤只认迁移前的 `daily-` ID，遗漏 Registry 的 `kind=agent`。后端目录与前端新建目标均按 kind 过滤；Agent Memory 不再并发请求 Personal/Project Catalog。误传 Agent home 到 Project Memory 的 list/health 接口返回可解释的 400。不可读取的 Agent Memory 显示未知数量与暂时不可用，不显示为零或空库。

真实数据核对：正式 43110 有 129 条 Personal 记忆和 9 个 Nexus Agent Memory 文件。63291 使用独立 CHAT_HOME，原副本没有 Personal Catalog，NanoClaw 网关也有意离线。本次将 Personal Catalog 与两个向量 SQLite 库备份成独立副本用于预览；没有写正式库，没有把预览接到正式 NanoClaw。预览记忆页面实测显示 129 条、目录仅一个 Nexus。500 日志实际来自错误 Project Memory 请求，主题列表/详情/锚点本次读取正常。

为避免历史日历显示性能实验的人工日期，隔离 daily 绑定恢复为与源记录相同的原日期（6 处），未改变原生消息。预览 Nexus 日历现有 9 月 20—26 日共 7 天记录；27 日没有预置 Session。复制及日期校正记录在 gitignored `.data/verification/unified-session/memory-calendar-preview-repair.json`。

回归覆盖：年度超过 60 条、闰年和非法日期；Agent home 不进入 Project 目录且错误目标返回 400；真实浏览器点击历史日期、刷新恢复、没有生成新 Session、Personal 记忆仍可见、Agent 网关失败与空记忆区分。年度格子另断言长宽相等，防止共享表单按钮最小高度把格子拉成长条。

窄屏日历沿用现有弹层的 body portal 模式，避免侧栏在布局切换时隐藏仍打开的模态窗口。浏览器回归在日历打开期间依次切换 390/768/1440 CSS 像素，检查弹层可见且不越过视口，再实际进入历史会话。

最终 `pnpm verify` exit=0：56 tooling / 657 Backend / 201 Frontend / 30 built / 12 dev，包含上述浏览器回归。父/前端 diff 检查通过；63291 已使用最终构建。首次门禁群聊页面加载曾超时（期间有并行前端重建），停止并行重建后的完整门禁通过；没有降低超时门槛或跳过该用例。未提交、未推送、未部署正式服务。

## 同日纠正：绿点指向空壳、漏掉同日工作

用户反馈 27 日绿点打开为空。真实 HTTP 核实：新分配的 Nexus 27 日 Session 返回 200、0 条消息；23—25 日的日常 Session 也为空，同日期的工作 Session 却有消息。原日历把 dailySessions 生命周期绑定当成活动，未覆盖后台工作与主题，这是显示数据源选择错误，不是丢失会话或需要新建 Session 系统。

修复直接使用 Agent Home（`<CHAT_HOME>/long-agents/<id>/sessions`）的公共原生发现/摘要入口。消息时间来自同一次 stat 校验的 Pi 当前分支，日期按 Agent 时区生成；无消息不点亮，同日多个 Session 显示选择列表，单个直接复用公共导航。跨日会话显示在实际有消息的日期，期间空闲日不补点。`days` 仍表达旧生命周期合同，年度响应的 `sessions` 是只读投影，不新增持久文件或执行路径。未递归汇总其他 Project 中的委派子会话。

Token 深浅只增加后续实现注释：真实 assistant usage 按日/Agent 汇总，明确缓存 Token 和 fork 继承去重后再启用；不以文件大小、轮次或会话数量冒充用量。

定向 Backend 19/19；新增浏览器场景实测空日禁用、同日两条不同 Session 分别选择后消息可见，原日历只读/刷新/视口/记忆场景保持通过。没有修改用户消息或正式服务数据。

本次最终 `pnpm verify` exit=0：56 tooling / 658 Backend / 203 Frontend / 30 built / 12 dev；架构检查与父/前端 diff 检查通过。63291 已更新为本次构建。真实数据副本逐目标审计：6 个 Long Agent 共 106 条日历 Session，106/106 公共会话读取成功且消息非空；记录为 gitignored `.data/verification/unified-session/calendar-history-audit.json`。浏览器实际确认 Nexus 27 日禁用、25 日展示 4 条会话，并从列表打开「整合：chat 开发」的现有消息。未提交、未推送、未部署正式 43110。

## 同日补充：历史续聊、空日期创建与任务说明

用户明确修正旧的历史只读产品规则。Home 每日 Session 可以在原上下文继续，默认点联系人仍进入今天；显式 date 复用已有 start 服务和 Pi Session，不增加日历持久文件、任务引擎或另一条聊天链。旧日总结完成后收到新消息会重新置待总结，时间戳与装配今天不回拨。空日期重复打开幂等，只创建不会调用模型。旧版已迁入 Home 的历史通过精确迁移回执和源 Registry cwd 兼容，原消息/header 不改；旧业务项目档案不自动接管。

公共会话响应投影可信 topicNode，日历/普通链接进入主题仍走节点授权发送；不是只在主题页面能聊天。后台工作列表补齐已有可选 topicIntegration 的严格解析，修复整张列表“后台工作绑定不匹配”。

朋友圈核实为正式服务 8 条、隔离预览 0 条：预览遗漏 social/posts.jsonl。按独立副本补齐 8 条，未发帖、未连接正式 NanoClaw、未修改正式文件；复制记录和原文件哈希留 gitignored `.data/verification/unified-session/social-preview-copy.json`。后台工作是一次独立执行，Task 决定触发时间，Duty 保存长期目标与进度并复用 Task；日历当前展示已产生会话的活动，未增加计划/跳过事件展示。使用入口与关系已补进 Long Agent 使用文档。

定向日常/迁移测试 29/29，真实浏览器两条场景通过：旧日发送读取旧上下文、空日期重复打开与发送/刷新、普通 Session 入口进入主题仍走节点授权路由。全量门禁首轮发现共享归属读取丢失 SessionOwnerResolutionError 包装，已修复并通过既有错误回归；最终 `pnpm verify` exit=0：56 tooling / 659 Backend / 205 Frontend / 30 built / 12 dev，含 Builder、Nitro 开发/生产构建和真实 Runtime。架构导航与父/Frontend diff 检查通过。63291 已使用最终构建；未提交、未推送、未部署正式 43110。

63291 预览真实 HTTP 审计：6 个 Agent、106 条活动 Session 全部可读且非只读；其中 1 条主题返回可信 topicNode。实际浏览器确认 Nexus 26 日原消息下方有公共输入框，27 日空日期能打开可输入会话，9 条后台工作正常显示，朋友圈显示 8 条。原生历史未改写。预览仍不带正式模型凭据、NanoClaw 调度离线；发送完成与上下文连续性由独立浏览器夹具和本地假模型证明，没有在用户历史里发测试消息。

## 同日收敛：进入日期、工作列表与输入区

日期预览和全量后台工作列表曾各自运行，用户切日期仍看到相同列表；同名周期任务的不同执行没有开始时间，造成重复感。现在日期点击直接进入该日的日常 Session，侧栏同步列出当天会话和工作；同日条目、刷新、浏览器返回保留 URL 的 friendDate，点击 Friend 回到今天。再次打开日历定位当前年月。历史工作没有当前执行引用也能打开。交互唯一入口见 [Chat Web 日期工作区](../../modules/web/chat-web.md#friend-的日期工作区2026-09-27)。

会话记忆移入输入工具栏笔记入口，开关与记忆条目共用 Dialog。聊天区与协作项目栏分配剩余高度，输入区不压缩，移除独立“返回日常交流”。没有改写历史、按标题合并不同 work，或增加另一条执行链。

最终完整 `pnpm verify` exit=0：56 tooling / 659 Backend / 206 Frontend / 30 built / 12 dev，共 963 项，包含类型检查、开发/生产构建与真实 Workflow Runtime。定向浏览器覆盖日期切换、历史任务、返回/刷新、继续聊天、空日幂等创建、记忆开关；布局覆盖 390×844、768×1024、1440×900、720×450、390×420。明暗截图保存在 gitignored `.data/verification/unified-session/date-ui`；小高度不冒充真机键盘验收，用户提供的旧截图仅作为原始缺陷参考。

63291 用最终构建恢复。实际 Nexus 副本审计：25 日 3 项工作、26 日 1 项；同名周期任务分别为当天 08:00:10 和 08:00:53 的不同工作，工具栏完整可见。只打开现有会话，无测试消息。预览认证条目为 0、无非终态待执行请求；未连接正式 NanoClaw。43110 健康为 200，未提交、未推送、未部署正式服务。复盘与可显式导入的 Experience 见 [日期导航与输入区遮挡](../../development/experiences/friend-date-navigation-and-composer.md)。
