# 2026-09-30 全仓代码与文档审查

本记录侧重具体缺陷与文档一致性。Frontend、Backend、NanoClaw 的职责、依赖和状态边界另见[同日架构复核](./2026-09-30-frontend-backend-nanoclaw-architecture-review.md)。

本次确认 **8 项问题：4 项 P1、4 项 P2**。1,032 项基础测试通过；排除真实付费模型测试后，开发运行链 11 项中 9 项通过、2 项失败。因此当前审查快照不能判定为通过完整门禁。

本次只审查并保存证据，没有修复业务代码，没有提交、推送或部署。P1 表示应优先修复、阻止当前变更作为完整可验收版本交付；P2 表示有明确触发条件的功能、并发或规范缺陷。

## 范围与基线

- 审查对象是开始时的 **HEAD + 未提交/未跟踪改动快照**，包含正在开发的 Prompt 请求记录、历史展示和相关门禁。结论不等于生产版本状态；审查期间继续产生的工作区改动未自动纳入快照。
- Root：`3b3343850e5f4ad2258acc43fd894bfb96c0136e`。
- Frontend：`37a5f714a90366d836f00e28dd911b4a7f9b3860`，另含已有工作区改动。
- Pi：`5b580155bc45123eb48f9b1e8bf46357f1239dd4`；NanoClaw：`c14d98d096b962dc80ffadb7de0c2fd2f8215a04`。
- 阅读项目规则、架构入口、配置和开发规范、Frontend 规范；横向检查 Project/Session/Workflow/公共 Pi 装配、Long Agent/Channel 接缝、Memory、HTTP 合同、Frontend 和 CLI。深读与复现聚焦共享入口和跨模块边界，不声称逐行审计所有上游代码。
- 构建和测试使用独立源码快照、测试夹具和临时数据；未覆盖原仓库常驻服务的构建目录。

原始日志、复现脚本、被定位文件的 SHA-256 与版本清单位于本机 `.data/verification/project-review-2026-09-30/`（Git 忽略）。该目录的 README 说明如何在隔离 checkout 重放复现。报告只保留合成数据，不记录正式会话或认证。

## 已确认问题

### 1. [P1] 打开同 ID 外部项目可覆盖 Agent Home 的注册身份

**位置：** [Project Registry](../../../src/projects/registry.ts) 的 `upsertRegistry()`，约 147–161 行；`registerProject()` 与 `openProject()`。

Registry 对“相同路径、不同 ID”做了校验，但遇到“相同 ID、不同路径/类型”直接替换。`openProject()` 拦截系统目录本身，却没有拦截外部 `.chat/project.json` 使用已注册 Agent 的稳定 ID。只有共享空间 ID 被额外保留。

**复现：** 在临时 Home 中创建 `nexus` Agent Home，再打开一个 Manifest 中同样写着 `id: nexus` 的外部业务目录。通过正常 `openProject({path, chatHome})` 成功注册，结果为：

```text
before: kind=agent,   sessionDir=<home>/long-agents/nexus/sessions
after:  kind=project, sessionDir=<home>/projects/nexus/sessions
registryCount=1
```

**影响：** 稳定身份被重新解释，后续 Project 解析、工作目录、资源和 Session 存储定位发生变化，已有历史可能在原入口不可见。没有证据表明物理历史文件被删除。

**建议：** 在 Registry 统一入口保护系统身份的类型与受管根；普通项目移动目录保留既有合同，但不得覆盖 `agent`/`share` 身份。增加“先建 Agent，再打开同 ID 外部项目”的回归，断言拒绝且 Registry/Session 路径不变。

证据：`project-identity-repro.mjs`、`project-identity-repro.log`。此问题存在于已提交实现，不依赖本轮 Prompt 功能改动。

### 2. [P1] 默认 verify 链会自动使用正式模型配置，可能产生费用

**位置：** [package.json](../../../package.json) 第 30–31 行；[group-real-model.test.mjs](../../../scripts/group-real-model.test.mjs) 第 15、44–57 行。

`verify → test:dev` 包含真实模型测试。该测试固定查看 `os.homedir()/.chat/agent`，只要 `models.json` 存在就执行；随后把 `models.json`、`settings.json`、`auth.json` 符号链接进临时 Home。没有显式付费调用授权开关，也没有要求指定授权配置来源。临时 Home 和符号链接不能阻止运行时读取真实认证。

**影响：** 日常验证、自动化代理或开发者运行 `pnpm verify` 时，可能产生真实模型请求、费用及环境依赖；行为与[默认测试规范](../../development/testing.md)第 108–115 行冲突。规范已经提供单独授权的真实模型验收方式。

**建议：** 从默认门禁移出，使用明确的独立命令、授权标志与指定配置来源；按现有真实模型验收合同记录结果。默认测试用本地假模型，并增加门禁清单检查以防再次接入付费测试。

证据来自静态调用链；**本次没有运行此真实模型测试，没有以真实账户验证费用或认证刷新行为**。

### 3. [P1] 完整历史首次打开会一直加载

**位置：** [FullHistoryDialog.tsx](../../../frontend/components/FullHistoryDialog.tsx) 第 31–58 行，尤其第 37 行。

成功读取 HTML 后只写入 `rawHtmlRef.current`，没有状态更新来触发生成 Blob URL 的 effect。首次 effect 执行时 ref 为空，网络成功返回后依赖也没有变化，因此 iframe 不出现。成功分支还会清除超时定时器，界面停在加载状态。

**复现：** 真实 Chrome 加载实际组件，导出响应为合成 HTML：

```text
HTTP 成功后：fetched=1, frames=0, status="Loading full history…"
切到 Prompt 页签再切回：fetched=1, frames=1, status=null
```

现有完整 Backend 浏览器门禁 `group-browser.test.mjs:246` 也在等待 `iframe.full-history-frame` 时超时，形成第二条独立证据。

**影响：** 使用该公共组件的完整历史入口首次打开不可用。此问题位于未提交的 Frontend 改动。

**建议：** 用显式加载完成状态/版本驱动文档生成，并核对切换 Session 时的缓存失效；回归覆盖“打开后不操作页签，直接出现历史”及重试。

证据：`history-repro.mjs`、`history-repro.log`、两个 `.review-history` 夹具文件、`dev.log`。

### 4. [P1] 新增 Prompt 浏览器门禁在模块导入时崩溃

**位置：** [prompt-capture-browser.test.mjs](../../../scripts/prompt-capture-browser.test.mjs) 第 197 行。

文件使用 `test(...)` 注册测试，却以 `})();` 收尾，把其返回值再次当函数调用，产生 `TypeError: test(...) is not a function`。该文件已加入默认 `test:dev`。

**影响：** 当前快照的开发门禁必然失败，不能取得该脚本预期的完整浏览器验收结果。此文件在审查开始时为未跟踪的新文件。

**建议：** 修正注册表达式，再完整运行该测试；修正导入错误并不等于其余交互断言已经通过。

证据：`dev.log`，Node `v24.8.0`，失败定位 `scripts/prompt-capture-browser.test.mjs:197:3`。

### 5. [P2] 开启 Prompt 记录后，Topic 节点发消息被后端拒绝

**位置：** [useAgentSession.ts](../../../frontend/hooks/useAgentSession.ts) 第 1063–1067 行；[Topic 消息路由](../../../src/routes/api/long-agents/[longAgentId]/topics/[topicId]/nodes/[nodeId]/messages.post.ts) 第 24–28、40–46 行。

Frontend 开关开启时发送 `promptCapture: "on"`。Topic 路由严格校验字段白名单，但没有包含该字段，也没有向 `acceptLongAgentTurn()` 转交它。对象 spread 将字段带入请求，类型检查没有发现跨层合同不一致。

**复现：** 临时 Home、有效 Topic/Node 图，通过实际 Nitro/h3 路由提交带开关的合成消息，返回：

```json
{"status":400,"body":{"status":400,"message":"无效节点消息合同"},"acceptedTurns":0}
```

**影响：** 开启功能后消息根本不被受理，并非仅缺少请求记录。此问题由 Frontend 新增字段与现有 Topic 路由组合触发。

**建议：** 对齐前端请求类型、运行时校验、耐久 turn 字段与公共装配；增加 Topic 节点开关开/关的真实发送回归，断言受理和执行完成，再检查记录数量。

证据：`topic-capture-repro.mjs`、`topic-capture-repro.log`。复现使用实际路由处理器，不声称已经在完整 Topic 页面操作该开关。

### 6. [P2] Memory 的 expectedVersion 校验不能阻止并发覆盖

**位置：** [Memory 管理工具](../../../src/workflows/memory/agents/memory-agent/tools/index.ts) 第 112–124、143–147 行；[Memory Repository](../../../src/memory/repository.ts) 的 `update()`。

工具先 `await get()`、比较版本，再独立执行 `update()`/`delete()`。期望版本没有下传到原子持久化操作；Repository 更新只按 ID 匹配。两个不同 Session 的工具调用可以都读到版本 1、都通过检查，然后依次覆盖。工具的 `executionMode: sequential` 不构成跨 Session 锁。

**复现：** 使用实际工具、MemoryStoreManager、MemoryService 和 SQLite Catalog；两个工具实例分别代表两个 Session，同时用 `expectedVersion=1` 更新同一记录。结果为：

```text
outcomes=[fulfilled, fulfilled]
final={text:writer-B, version:3}
```

**影响：** 第二个调用静默覆盖第一个调用已写入的内容，违背[Memory 合同](../../modules/memory/README.md)第 142 行声明的并发保护。删除路径有同样的先检查再执行结构；本次动态复现针对更新路径。

**建议：** 将期望版本传到存储层，以事务/带版本条件的 SQL 完成更新和删除，冲突必须明确失败。增加两个 Session 同版本并发更新，以及更新与删除竞争的回归。

证据：`memory-concurrency-repro.mjs` 的 `expectedVersion race`；这是既有实现问题。

### 7. [P2] Memory 索引可能回退到旧版本，健康状态仍显示正常

**位置：** [MemoryService](../../../src/memory/service.ts) 第 296–302 行；[MemoryRepository](../../../src/memory/repository.ts) 第 417–424 行。

同一记录的索引同步没有按记录串行化，也没有把索引版本与 Catalog 版本绑定。较早更新的 embedding/索引写入晚完成，就能覆盖较新索引；`markIndexed()` 又只按 ID 标记，错误不会进入待修复队列。

**复现：** 实际 Service + SQLite，使用可控假索引制造合理的完成次序：A 写入等待，B 写入完成，再释放 A。结果：

```text
Catalog: text=update-B, version=3, indexStatus=indexed
Index:   text=update-A, version=2
Health:  records=1, indexed=1, pending=0, failed=0
search("update-B"): 0 条
```

**影响：** 最新记忆虽在 Catalog，却不能可靠按最新内容召回；状态页不会提示修复。假索引用于确定性暴露顺序问题，没有以真实 embedding 服务测量命中率。

**建议：** 按记录协调索引更新，完成后核对版本；旧任务不能把新 Catalog 标成已同步。CAS 标记本身不足以阻止远端旧写覆盖，还应保证索引写顺序或重新同步最新版本，并覆盖更新/重建/删除竞争。

证据：`memory-concurrency-repro.mjs` 的 `out-of-order index`；这是既有实现问题。

### 8. [P2] 权威文档对当前实现状态给出互相冲突的指引

**位置：** [Project 框架](../../modules/projects/chat-project-framework.md) 第 75–94 行；[Long Agent 路线图](../../modules/long-agents/chat-long-agent-roadmap.md) 第 17、24、42、55 行。

具体冲突：

- Project 框架仍写“当前实现只提供共享 daily，独立 Agent Daily 仍待迁移”；当前 Registry 已提供独立 `long-agents/<id>/` Home，现行合同要求切项目不迁移 Friend Session。
- 路线图写“当前完成范围为 LA0”，同页却记录 LA1、LA2 已实现；其他验收文档还记录 LA3–LA5。该页又写群聊尚未交付，而仓库已有群聊模块，本次实际 HTTP、进程恢复和联合夹具验收已通过。

**影响：** Agent 按强制文档入口恢复上下文时，容易重复开发已存在机制，或采用已被取代的 Session/Project 归属。链接检查只能证明路径存在，无法发现这些语义冲突。

**建议：** 以一个实现状态入口区分“设计已确认 / 工作区实现 / 已提交 / 已部署 / 已验收”，附版本和证据；其他文档链接该入口，旧描述标为历史或删除。不能因为本次测试通过就将全部阶段或真实渠道标为已上线。

## 验证结果

| 验证 | 结果 | 边界 |
|---|---:|---|
| `pnpm check:architecture` | 通过 | 快照：186 个入口、1,666 个本地链接；加入本报告后：187 / 1,681；不代表语义一致 |
| `pnpm test:tooling` | 58/58 | 隔离快照补齐 Git 元数据后通过 |
| Backend 测试 | 681/681 | `pnpm test` 的后端部分 |
| Frontend 测试 | 263/263 | `pnpm test` 的前端部分 |
| `pnpm typecheck` | 通过 | Backend、CLI、Frontend |
| `pnpm build` | 通过 | Frontend、Nitro、CLI，均在快照构建 |
| `pnpm test:built` | 30/30 | 生产构建入口的合成场景 |
| 开发运行链（排除真实模型脚本） | 9/11 | 历史浏览器超时、Prompt 测试导入错误 |
| `git diff --check`、Frontend diff check | 通过 | 原工作区格式检查 |

开发链通过范围包含真实 Frontend Run 合同到 Nitro/Workflow/Pi/本地假模型、真实 HTTP 流、群聊 HTTP/进程恢复、Chat+Nano 联合夹具、Topic Workflow 与浏览器、Session Memory 开关、Friend Workflow 切换。联合夹具通过不等于真实外部渠道收发通过。

没有执行原样 `pnpm verify`：其付费模型分支存在问题 2；其他阶段已分项执行，开发测试明确排除了该文件。没有运行 Pi、NanoClaw 上游各自的全部原生测试，没有付费模型、真实外部发送、24 小时稳定性或生产部署验收。

## 建议修复顺序

1. 先处理系统 Project 身份保护、默认门禁真实模型调用、完整历史加载和测试注册错误。
2. 对齐 Topic Prompt 合同，再将 Memory 并发覆盖与索引乱序作为两个独立场景修复。
3. 统一文档实现状态，加入上述行为回归后重跑完整、安全的默认门禁，再决定是否进入提交与部署。
