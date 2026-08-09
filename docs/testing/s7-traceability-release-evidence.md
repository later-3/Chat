# S7 追踪与发布证据（独立质量门草案）

> 状态：**本地发布候选门通过；正式Provider组合门被环境安全阻断**。S7.1/S7.3 的独立 Fixture/Auditor/代表矩阵已有可重复证据；S7.2容量/秘密扫描通过；S7.4的Designer真实浏览器通过，Planning/Note正式付费Provider因当前Coding Plan Host在零调用前拒绝。

## 1. S7任务追踪

| S7任务 | O项 | 本轮复验证据 | 当前结论 |
| --- | --- | --- | --- |
| S7.1 兼容审计 | O8、O9、O13 | `s7-compatibility-auditor.test.ts`、versioned manifest、v1→v10迁移、重复打开/事务、迁移故障注入 | 17个Fixture；v1～v10各有物理版本代表样本；Planning/Note waiting可恢复 |
| S7.2 容量 | O11、O13 | `s7-capacity-quality-gate.test.ts`、`s7-capacity-evidence.md` | 核心limit+1与脱敏本机性能自动门；Preview/Store/UI预算仍有书面缺口 |
| S7.3 故障/并发/安全 | O4、O5、O9、O10 | `s7-failure-security-matrix.test.ts`、Product Integrity Auditor、既有B2/M1/Note/Store门 | 同Session 2 Planning + 1 Note并发成功；IDOR/strict/canary/同终态异证据冲突覆盖 |
| S7.4 干净真实组合 | O1～O14 | Designer 375/768/1440 + Choice/Loop 4/4；Provider与组合preflight | Designer通过；正式Provider与组合链因`coding.dashscope.aliyuncs.com`被安全门在0调用前阻断 |
| S7.5 全仓与发布审查 | O1～O14 | 本文、全仓 format/lint/typecheck/test/build | 12/12项目typecheck/build；102个Vitest文件891/891 + Node 14/14；format/lint/diff-check通过 |

42项任务到阶段/O项的批准映射以 `docs/tasks/configurable-workflow-task-map.md` 第14节为权威；本草案不复制第二套任务状态。当前共享 dirty 工作树也不能证明“42项均有独立PR证据”。

## 2. O1～O14最终复验索引

| O项 | 阶段证据 | S7复验/缺口 |
| --- | --- | --- |
| O1/O2 真实图与详情 | S1/S2 API、Viewer测试 | versioned历史View/Node审计；浏览器组合待S7.4 |
| O3 发起前配置 | S4配置质量门、S6 Composer/Designer | 同Definition多Run及冻结RunSpec；浏览器组合待S7.4 |
| O4 服务端校验 | Kernel、S4/S6发布门 | 64/65、strict unknown、stale/hash、IDOR代表反证 |
| O5 审核/循环 | B2、Kernel、Planning/Note Runner | Planning/Note waiting Fixture可读且正式Runner可恢复；真实模型链待S7.4 |
| O6 保存/发布 | S6 lifecycle/policy/structure测试 | 跨阶段矩阵只引用正式生命周期证据，不以运行配置冒充 |
| O7 两类工作流 | S5 Note纵向 | Note active/waiting/terminal Fixture + 正式投影Auditor；真实模型链待S7.4 |
| O8 历史稳定 | v1→v10迁移、RunSpec/View | 17个Fixture确定性Hash、重复打开及v1～v9迁移rename故障不改源文件 |
| O9 恢复/幂等 | Store、B2、M1、Note Local World | command replay、并发CAS、同status异outcome 409且零新Transition |
| O10 安全 | strict DTO、边界/IDOR测试 | canary只在权威Message；Product transport/Auditor不泄漏；durable scope与bundle秘密由容量门扫描 |
| O11 容量 | Kernel/S6布局 | 核心limit+1通过；完整浏览器/Store规模结论未完成 |
| O12 响应式/键盘 | S2/S4/S6 Web/Playwright | Designer 375/768/1440与Choice/Loop真实API/生产build 4/4 |
| O13 不回归 | B2、Memory、Project、Rules各纵向 | Store v10 Auditor覆盖Memory Selection、Policy Resolution、Project Context、Rules、Note正式投影 |
| O14 干净真实组合 | 只能由S7.4证明 | 正式Endpoint/Key不可用；安全preflight失败，不能以Fixture替代 |

## 3. 依赖与供应链复核

- 新增 `@xyflow/react` 锁定 12.11.2、MIT；用于受约束 Workflow Viewer/Designer，退出方式是回退线性列表/受控编辑器，不能影响 Product View/Definition 事实。安装目录约 2.8 MiB，这不是浏览器 gzip bundle 成本；最终 build 应记录真实 chunk 字节。
- 未新增 coverage provider、ELK、表达式引擎、通用 JSON 表单或第二 Markdown renderer。
- 仓库现有 `pnpm audit --prod`/许可证能力若未在最终门执行，只能记录为未验证，不能声称完整 SCA。
- `docs/architecture/version-evidence.md`与As-built已记录React Flow和react-markdown精确版本、许可证、用途与退出方式。

## 4. 发布阻断与判定

当前阻断/待证：

1. `pnpm test:provider:bailian`、`pnpm test:provider:bailian:note`与组合E2E均在导入测试模块/清理目录/启动服务/付费调用之前拒绝当前Coding Plan Host；需正式按量付费或业务空间Endpoint与对应Key后重跑。
2. Store规模/备份、Preview截断、浏览器布局性能与Trace保留策略尚未成为生产合同。
3. Web主chunk为599.64 kB（gzip 163.96 kB），build只给警告且公开Bundle边界通过；后续应按Workspace功能继续拆分，而不是提高告警阈值。

本轮全仓`format:check`、`lint`、`typecheck`、`test`、`build`及`git diff --check`均已通过；这关闭代码门禁，但不能替代上述真实组合与产品容量证据。

本地代码、迁移和确定性/浏览器门达到可审查发布候选；正式模型组合验收仍保持“不批准”。不得把安全预检失败写成通过，也不得使用历史Coding Plan 200或Fixture替代正式Provider证据。

## 5. 最终命令证据

- `pnpm format:check`：通过。
- `pnpm lint`：通过。
- `pnpm typecheck`：12/12 workspace projects通过。
- `pnpm test`：102个Vitest文件、891项；Node runtime 14项；合计905/905。
- `pnpm build`：12/12 workspace projects通过；Web public bundle boundary通过。
- `git diff --check`：通过。
- S7兼容/故障/容量34/34；Store70/70；Memory Selection6/6；Note/Policy12/12；Project/Rules原子上下文8/8。
