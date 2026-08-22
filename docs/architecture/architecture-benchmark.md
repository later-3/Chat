# 架构基准：pi / NanoClaw 对照与 Chat 的差距

> 日期：2026-08-19（2026-08-20 修订基准组合）。性质：只读源码审计结论，不授权任何实现。
> 证据来源：本机固定源码 `~/Code/opc-os/pi`（pi-agent-core / pi-coding-agent）、
> `~/Code/reference-agent-sources/nanoclaw`（nanocoai/nanoclaw，HEAD 0c0f4c2）与
> `~/Code/reference-agent-sources/hermes-agent`（NousResearch/hermes-agent，HEAD af250d8）。

> **基准组合修订（§6.5）**：Hermes 实测代码工程不合格（`gateway/run.py` 21192 行、
> 139 万行零架构门），不再是架构基准，降级为能力参考（skills 自改进 / cron / 会话搜索）。
> 架构基准替换为 pi（代码组织）+ NanoClaw（产品架构与安全结构）。

## 1. 什么是好的架构（判定标准）

1. **单一所有权**：每个事实和能力有且只有一个所有者，任意边界能一句话回答"谁拥有什么"。
2. **核心小而可读**：系统最重要的循环（agent loop、用例事务主链）应该小到一个人一天能读完，
   核心不被辅助代码稀释。
3. **依赖方向单向且可机械检查**：分层无环，且包边界就是发布/合同边界，违规靠工具挡住，
   不靠 reviewer 记忆。
4. **扩展缝是公开合同**：插件、Extension、Adapter 通过稳定公开接口接入；
   import 对方整包 = 接缝缺失的症状。
5. **进程拓扑最简**：能一个进程承载就不拆两个；每多一个进程必须有多一份明确收益
   （隔离、独立伸缩、崩溃域），并计入运维成本。
6. **存储格式简单可演进**：优先 append-only / JSONL / SQLite 这类可被简单工具读写的格式；
   迁移机制轻，版本演进次数少。
7. **明确不做什么**：有勇气把非核心责任划出边界并写下来。
8. **可调试**：一条请求能从入口追到落盘，不依赖散落日志和人工记忆。

## 2. pi 是怎么做的

实测结构：`packages/ai` → `packages/agent` → `packages/coding-agent` 三层独立发布的 npm 包。

- **核心循环极小**：`pi-agent-core/src/agent-loop.ts` 共 796 行，函数式 `EventStream<AgentEvent>`，
  状态由 reducer 管理，消息只在 LLM 调用边界转换格式。整个 harness（compaction、session、
  skills、tools、prompt-templates）都在 `agent/src/harness/` 下按职责分目录。
- **包边界 = 发布边界**：每层是可独立安装、独立替换的 npm 包（`pi-ai` 换 provider 不动 agent，
  `pi-agent-core` 可被任何产品嵌用）。接缝稳定性被发布行为机械强制。
- **存储简单**：Session 是 append-only JSONL 树（`session-manager.ts`："Manages conversation
  sessions as append-only trees stored in JSONL files"），branch、compaction、恢复都从同一格式推出。
- **Extension 是一等公开缝**：coding-agent 的工具、skills、prompt templates、keybindings 全部
  走公开 Extension 合同，文档化。
- **明确不做什么**：README 直接声明"Pi does not include a built-in permission system"，
  并给出三种容器化模式（Gondolin micro-VM / Docker / OpenShell）作为边界外答案。
- **单进程**：CLI、SDK、server 模式共用同一核心对象 `AgentSession`，默认一个进程。

## 3. Hermes 是怎么做的

实测结构：Python 单仓，`agent/`（约 8.1 万行）、`gateway/`（约 4.8 万行）、`tools/`、`skills/`、
`providers/`、`cron/`。

- **单 gateway 进程承载所有平台**：Telegram / Discord / Slack / WhatsApp / Signal / CLI 共用
  一个 gateway 进程，`platform_registry` + 归一化流（`stream_consumer` / `stream_dispatch`），
  所有平台共享会话连续性。进程拓扑是一个进程，不是一张服务图。
- **能力自闭环是产品核心**：skills 由 agent 在使用中自行创建和改进、memory curator 周期性
  自我提醒沉淀、内建 cron 调度器无人值守交付、FTS5 全量会话搜索支持跨会话回忆。
  学习循环不是外挂组件，而是 agent 的日常工具。
- **一个接口六个执行后端**：terminal backend 抽象覆盖 local / Docker / SSH / Singularity /
  Modal / Daytona，serverless 后端空闲休眠近乎零成本。可移植性由单一抽象兑现。
- **诚实评价**：Hermes 的"好"不在代码纯度——`slash_commands.py` 单文件 4656 行、`agent/` 平铺
  上百模块，本身接近 Big Ball of Mud。它的架构优点是：**单进程拓扑、能力闭环、执行后端可移植、
  研究友好（trajectory 导出/压缩）**。

## 4. 对照：Chat 做得不好的地方

前提：Chat 是有治理责任的产品（HITL Decision、幂等、Product Commit 证据链），pi/Hermes 是
agent harness，类别不同；pi 明确无权限系统，Hermes 无耐久审批门——Chat 的治理面是差异化资产。
问题不在"有治理"，而在治理的代价不该淹没主链。

1. **进程拓扑过重**。本地开发要启动 5 个进程（API、Workflow runtime、Pi Executor、DSH Web、
   可选 code-server），加两套端口族（431xx/441xx）、LaunchAgent、PID 登记与四重一致性清理
   （PROJECT_LESSONS #35 整课都是进程清理事故）。pi/Hermes 证明同类能力单进程可承载。
   Chat 的多进程部分被 Vercel Workflow 强制，但 Pi Executor 独立进程的隔离收益与运维成本
   需要重新称重；至少它不该为两个符号 import 整个 workflows 包（见 5）。
2. **核心被稀释**。pi 的核心 loop 796 行；Chat 产品内核 `packages/application` 已 2.5 万行、
   69 个文件平铺，产品状态机（domain 6.2k 行）与 workflow designer、投影、RunSpec 编译器
   混在同一包同一层目录。用户最在意的主链"发消息 → 计划 → 批准 → 执行 → 正式提交"
   没有一个可独立阅读的核心。这一点上 Chat 犯了和 Hermes 相同的平铺病，但 Chat 没有
   Hermes 单进程拓扑这个补偿优点。
3. **内部接缝不公开**。`apps/pi-executor` 为 `createRuntimeApiClient` + `loadRuntimeCredential`
   两个符号依赖 87 文件的 `@chat/workflows` 整包。pi 的包边界是 npm 发布边界，机械强迫接缝
   稳定；Chat 全部 `workspace:*`，没有任何机制阻止"抄近路 import 整包"，于是接缝退化为
   全包耦合。进程间稳定协议（Operation 协议、credential 加载）应下沉 contracts。
4. **存储演进成本高**。pi 用 append-only JSONL，Hermes 用 SQLite + FTS5；Chat 的 JSON
   Product Store 已演进到 v13。13 次版本迁移说明 Schema 不稳定且迁移机制重，
   每次迁移都是 Lessons #23 边界的一次考验。
5. **能力闭环缺位（产品层差距）**。Hermes 证明过用户价值的三件事——agent 自建/自改进 skills、
   cron 无人值守交付、跨会话全文搜索——Chat 都没有：Memory 是显式 opt-in 的 Workflow 节点，
   没有学习循环，没有调度自动化，没有会话搜索。这不是代码问题，是产品方向差距。
6. **面铺得广、WIP 多**。pi 把权限系统明确划出边界；Chat 当前同时维护 DSH 派生、mobile shell、
   PWA、Workbench（Beta 暂停）、远程网关。每条纵向都做得很深，但并行面多，
   与 Lessons #10/#16（先做一条完整纵向）存在张力。

## 5. 对当前架构修整任务的启示

按"先无争议、后需拍板"排序：

| 步骤 | 内容 | 依据 |
|---|---|---|
| 1 | 仓库卫生：删除 `apps/web` 空壳；处置 `backend/`(1.1GB) 与 `workflow-examples/`(8.3GB)；根目录截图归置 | 标准 7；AGENTS.md 已明文禁止引用 `apps/web` |
| 2 | pi-executor 的 runtime client/credential 下沉 `contracts`，断开对 workflows 整包依赖 | 标准 3、4；pi 的包=发布边界 |
| 3 | Workflow runtime 进程入口从 `packages/workflows` 提升为薄 `apps/` 入口，库包只留 Definition/Step | 标准 2、5 |
| 4 | `application`/`workflows` 按子域分目录，把产品主链凝成可读核心 | 标准 2 |
| 5 | （产品决策，需拍板）能力闭环方向：skills 自改进、cron、会话搜索 | 标准来自 Hermes 已验证的用户价值 |

步骤 1–3 是机械修整，不改变任何产品行为；步骤 4 是结构性整理；步骤 5 超出架构修整范围，
需要单独授权。

## 6. 第二轮深度对照（2026-08-20，含对第一轮基准理想化的修正）

### 6.1 基准自身的实测缺点（修正理想化）

- pi 并非处处小：`coding-agent/src/modes/interactive/interactive-mode.ts` 6448 行、
  `core/agent-session.ts` 3344 行；pi 的 `scripts/` 7377 行，与 Chat 运维面 7450 行相当。
  pi 的好在于核心 loop 小（796 行）与包=发布边界，不在于没有大文件。
- Hermes 代码纯度远低于 Chat：`gateway/run.py` 21192 行单文件、`cli.py` 16304 行，
  全仓约 139 万行 Python，无任何分层架构门；`hermes_state.py` 7138 行单文件，
  其“简单存储”并不比 Chat Product Store 优雅。Hermes 的架构优点只成立在三点：
  单 gateway 进程拓扑、能力自闭环、六后端一抽象。

### 6.2 Chat 实测落后点（按证据排序）

1. **进程拓扑**：本地 dev 8 个端口（43110–43120）、5+ 进程、双端口族与 PID 四重清理，
   对比 pi 单进程、Hermes 单 gateway。但需承认 pi 无耐久性/无权限隔离、Hermes 耐久性
   只是 SQLite state——Chat 多进程买到了真实保证。可收敛空间：Vercel Workflow 本可嵌入
   Web 服务器运行，独立 runtime 进程是 Chat 自己的选择；本地 dev 可评估 API+Workflow
   同进程、仅按需拆 Executor，生产隔离不变。
2. **`packages/product-store-json/src/snapshot-integrity.ts` 4705 行单文件**，全仓最大，
   超过 pi 任何非 UI 文件；完整性审计应按对象族拆分。
3. **Schema 演进史**：13 个 `migrate-v*-to-v*` + 8 个 `legacy-v*` 投影文件；pi 全部迁移
   逻辑 315 行。legacy 保留是 PROJECT_STATE 的有意决策（历史 Run 证据），属于有意负债，
   但 13 个版本说明早期 Schema 不稳。
4. **Router 层偏重**：`apps/api/src/product-routes.ts` 2089 行、`internal-runtime-router.ts`
   1013 行、`outbox-dispatcher.ts` 1071 行，与“Hono 只终止协议”的冻结边界存在张力。
5. **测试纪律**：`definition-kernel-lab-runtime.test.ts`、`m1-workflow-recovery.test.ts`
   在本机 main 基线与 worktree 上均不稳定（超时型 flake，失败数随运行波动），违反
   Lessons #27 确定性隔离纪律。

### 6.3 Chat 实测优于基准点

- 机械架构门（依赖矩阵+边界测试进 CI）；pi 靠发布边界天然强制，Hermes 完全没有。
- 治理链：HITL Decision、幂等、outcome_unknown、Product Commit 证据；pi 明言无权限系统，
  Hermes 无审批门。
- 测试比例：约 93k 行生产代码配 260+ 测试文件；Hermes 139 万行测试覆盖远低于此。
- 凭据纪律：不打印、不进 Trace、0600 凭据文件；Hermes 明文 `.env` 直接位于用户家目录。

### 6.4 修订后优先级

| 优先级 | 项 | 状态 |
|---|---|---|
| 已完成 | 仓库卫生；pi-executor 断开 workflows 整包依赖 | codex/arch-review |
| P1 | 拆分 `snapshot-integrity.ts`（4705 行） | 待授权 |
| P2 | lab 测试 flake 确定性化或隔离标记 | 待授权 |
| P3 | 评估本地 dev API+Workflow 同进程（生产隔离不变） | 待授权，需先出方案 |
| P4 | application 子域分目录、Router 减重 | 长期 |
| 明确不做 | 模仿 Hermes 单文件巨石或 pi 的无治理简单 | — |

## 7. 基准替换评估（2026-08-20）

### 7.1 pi 的基准资格与边界

pi 够格当“代码组织”基准：核心 loop 796 行 + reducer + EventStream；三层包=发布边界；
工程规则严格（禁动态 import、禁 `any`、依赖按 reviewed code 管理、只允许 erasable
TypeScript、多 agent 并发 git 纪律）。边界：巨石在外壳层（`interactive-mode.ts` 6448 行）
未污染核心；它是单 harness，无多平台、无耐久审批、明言无权限系统，不能当产品架构的
全部基准。

### 7.2 候选替换评估（本机三候选，源码实测）

| 候选 | 实测 | 结论 |
|---|---|---|
| OpenOPC (HKUDS) | “AI 员工公司”研究项目 | 排除：概念项目 |
| zeroclaw (Rust) | 22k 行，`main.rs` 单文件 9362 行（44%） | 排除：巨石主文件 |
| **nanoclaw (nanocoai)** | TS，41k 行 / 252 文件，src 最大 784 行，103 个测试文件，CI+typecheck+lint | **当选** |

### 7.3 NanoClaw 的基准证据（docs/architecture.md 与 src 实测）

1. **每个决策带“为什么”**：host↔container 用一对 SQLite（inbound/outbound）做唯一 IO，
   一文件一写者消除跨进程锁争用；明确记录为何用 `journal_mode=DELETE` 而非 WAL
   （WAL `-shm` 一致性过不了 VirtioFS）。
2. **Channel adapter 职责切割干净**：adapter 只做平台事件过滤与两级 ID（channel+thread）
   标准化，不知 agent group/session 存在，host 负责映射。
3. **安全是一等结构**：`modules/` 下 permissions、approvals、mount-security、
   egress-lockdown——与 Chat 的 Executor 隔离、HITL 同构，可直接对照。
4. **文档诚实**：architecture.md 自述“Draft，与代码冲突时以代码为准”；另有
   `BRANCH-FORK-MAINTENANCE.md`，与 Chat 维护 DSH 派生处境同构。
5. 小文件 + 测试 colocated + SQLite 状态 + 会话容器隔离，整体与 Chat 技术栈同族。

### 7.4 修订后基准分工

| 维度 | 基准 |
|---|---|
| 代码组织、核心凝练、接缝稳定 | pi |
| 产品架构、消息驱动、安全结构、渠道接入 | NanoClaw |
| 能力方向（skills 自改进 / cron / 会话搜索） | Hermes（仅能力参考，非架构基准） |
| 治理、审批、证据、架构门 | Chat 自身为标杆，无外部基准 |

## 8. 第三轮对照（2026-08-20，pi + NanoClaw 双基准实测）

### 8.1 pi 维度（代码组织）：基本达标，两个例外

| 检查项 | Chat 实测 | 判定 |
|---|---|---|
| `any` / `enum` | 0 / 0 | ✅ |
| 动态 import | 3 处，均为类型位（pwa.ts×2、workflow-result-steps.ts×1） | ⚠️ 轻微，可改顶层 type import |
| 机械依赖门 | 架构测试矩阵等效 pi 发布边界 | ✅ |
| >1000 行文件 | 12/298（4.0%）vs pi 27/672（4.0%） | ⚠️ 比例相同、位置不同 |

关键差别：pi 巨石在外壳层（interactive-mode、provider API、TUI），核心干净；Chat 巨石在
核心产品层——snapshot-integrity 4705（Store）、project-use-cases 2457（Application）、
product-routes 2089（API）、trace.ts 1817 与 internal-runtime.ts 1747（Contracts）。
修正第二轮判断：产品主链 5 文件（session-message 805 / plan-decision 877 / execution 648 /
commit 666 / settlement 178）合计仅 3174 行，本身可读；问题是平铺目录稀释 + 核心层巨石。

### 8.2 NanoClaw 维度（产品架构）：三项差距

1. **机制族 vs 单一消息 IO**：NanoClaw 一切交互为一对 SQLite 消息表；Chat 有 5 个机制族
   （Outbox / Binding / Trace / SnapshotIntegrity / Credential + Dispatcher）。判定：
   **不列为问题**——Chat 购买的保证（耐久 / HITL / 对账）大于 NanoClaw，且各族 owner 清晰；
   唯一问题是 snapshot-integrity 族长成 4705 行巨石。
2. **安全结构无一页地图**：NanoClaw `modules/{permissions, approvals, mount-security,
   egress-lockdown}` 集中可见；Chat 安全分散在 pi-runtime（Executor 门）、application
   （plan-decision / prompt-review）、workflows（network-policy）、contracts（credential）
   4+ 包。分层防御合理，但缺一篇“安全边界一页图”as-built。
3. **小文件纪律**：NanoClaw 163 个生产文件 0 个超 1000 行；Chat 12 个。

### 8.3 文档诚实度抽查

as-built 文件引用全部与代码对得上，无漂移（唯一一处 api-client 引用已在接缝任务中顺手修正）。
可借鉴 NanoClaw 的“Draft，与代码冲突以代码为准”声明，用于任务书类文档。

### 8.4 第三轮修订后问题清单

| 优先级 | 项 | 依据基准 |
|---|---|---|
| ~~P1~~ 已完成 | 拆 `snapshot-integrity.ts`（5557 行）→ `snapshot-integrity/` 目录 10 个族模块（最大 975 行）+ 共享 Fail 类型 + 薄编排入口 | NanoClaw 零巨石 |
| ~~P2~~ 已完成 | lab 测试按 unit/serial 两个 Vitest Project 隔离；真实 Local World 串行，测试文件集合保持 26 个不变 | pi 确定性纪律 |
| ~~P3~~ 已完成 | 拆核心层其余巨石：project-use-cases 2457→7模块（最大684）、product-routes 2636→9路由族+shared（最大513）、trace.ts 1849→10模块（最大402）、internal-runtime.ts 1766→9模块（最大487） | 巨石不长在核心层（pi） |
| ~~P4~~ 已完成 | 《安全边界一页图》→ [security-boundaries.md](./security-boundaries.md) | NanoClaw 安全模块集中可见 |
| P5 | 3 处类型位动态 import 改顶层；application 子域分目录 | pi 严格标准 |
| 不列为问题 | 机制族数量（5 族） | 治理规模的合理成本 |
