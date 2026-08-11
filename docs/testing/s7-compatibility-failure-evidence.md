# S7.1/S7.3 兼容与故障证据（as-built 草案）

> 状态：Store v10的独立Fixture/Auditor/代表矩阵已建立；不替代S7.4真实组合链，也不构成发布批准。

## 1. 只读 Product Integrity Auditor

`packages/testing/src/product-integrity-auditor.ts`只读取传入的`ProductSnapshot`，一次返回全部问题；不调用Store的fail-fast入口、不写数据、不修复。报告只含问题码、对象类型、ID和安全摘要，不复制Message、Plan、Note或Project/Rule正文，也不包含Workflow/Hook/pi私有身份。

Store v10覆盖面：

1. Run→Session/来源及最终Message、终态Run无活动Node。
2. RunSpec→Definition Revision→不可变View→Runner版本证据。
3. Node→连续Transition→最后状态及输入/输出Manifest Hash。
4. Planning的Plan/Attempt/Approval/Decision/Execution/Validation/Artifact链。
5. Note的Source Message/选区Hash、Candidate/Decision/Revision/Note/Owner链，以及waiting审核Node、成功commit Node正式投影。
6. Rule/Revision/生命周期Decision/确定性Selection，以及Attempt绑定。
7. Planning Project Context的Run/Owner、Project/Method/Stage、来源revision/hash及Attempt绑定。
8. Planning Memory Selection的Run/RunSpec/Definition Node、有限Memory Result Snapshot引用、maxItems和Attempt绑定。
9. Workflow Policy Resolution的RunSpec、Note Candidate revision/hash、内置策略版本/hash、允许/拒绝理由与审核Node投影；不接受伪造human Decision。
10. Outbox→Run/RunSpec/Decision，Receipt提交revision和已知result ref。

生产`assertSnapshotIntegrity`仍是open/transact失败关闭入口；Auditor是独立测试Oracle，不能替代生产校验或成为后台修复脚本。

## 2. Versioned Fixture Manifest

Manifest位于`packages/testing/src/fixtures/s7-versioned-fixtures.ts`，共17项。每项冻结物理schema、工作负载、生命周期、脱敏对象数和canonical Hash。

- v1三项的`sourceCommit=7692155d9f4e7b75eeaa819c7955041e2748689a`，表示历史v1合同来源；不是运行时当前HEAD。
- v2～v9每版各保留一项由v1代表样本逐版迁移得到的非空active快照；它们由当前未提交迁移实现生成，因此`sourceKind=working_tree_generated`且`sourceCommit=null`。v10六项同样来自当前工作树。`null`是刻意的来源声明，不能借用v1的历史commit冒充各版迁移实现的provenance。
- v1对象数为4/7/4；v2～v5为5，v6为20，v7为23，v8/v9为26；v10 Planning为33/45/51，v10 Note为15/22/38。
- v10 Planning active相较旧构造口径只少一个伪造给queued `planning.plan`的输入Manifest：测试同时锁定对象数33、Planner仍为queued、`inputManifestId`缺失且该Node的Manifest数为0。该变化没有删除业务事实或终态证据。
- active为当前可读/可运行，Planning与Note waiting均为`resumable`，terminal为`read_only_history`。

| Fixture组 | active | waiting | terminal |
| --- | --- | --- | --- |
| v1 legacy planning | 可继续 | 可继续 | 只读历史 |
| v2～v9 legacy planning代表样本 | 可继续 | 未重复造样本 | 未重复造样本 |
| v10 configurable planning | 当前 | 可继续 | 只读历史 |
| v10 note_capture | 当前 | 可继续 | 只读历史 |

每项执行：构造并校验冻结Hash、逐版v1→v10、重复迁移确定、Zod parse、生产完整性、只读Auditor、Store打开、合法新事务、再次打开字节不变。v1～v9每个物理版本还注入迁移atomic rename失败并验证源文件逐字节不变；v1伪装new planning/note_capture与未知v999均安全拒绝。

## 3. 兼容/故障/并发/权限/敏感矩阵

| 维度 | 自动证据 | 产品结论 |
| --- | --- | --- |
| 同Session 2 Planning + 1 Note并发 | `s7-failure-security-matrix.test.ts` | CAS以同一Command重放后收敛为3个独立Message/RunSpec/Start Outbox |
| 同Definition多Run | 同上、S4 quality gate | 每Run冻结独立RunSpec，不随latest漂移 |
| 同Node同status异证据 | 同上 | 新command返回409 `revision_conflict`，不新增Transition、不覆盖旧outcome/summary |
| 同review/Note/Designer竞态 | B2、Note Backend/Local World、`workflow-designer-lifecycle.test.ts` | 以CAS/Decision identity失败或幂等收敛，不产生第二业务事实 |
| Store损坏/迁移/IO | Product Store迁移与quality-gate测试 | open/transact失败关闭；原文件/备份语义由Store测试拥有 |
| Outbox重复/恢复 | B2、M1、Note Local World、API dispatcher | 同一产品命令/Outbox不重复业务副作用 |
| Session/Run/Node/Definition/Resource/Note IDOR | S7/S4/Note/Rules/Project路由与用例测试 | 知道ID/hash不能替代owner授权，拒绝且零写入 |
| strict/unknown/prototype输入 | S7 + contracts/API测试 | 400/422，Store revision不变 |
| 正文/秘密 | S7 canary、architecture-boundaries、capacity scanner | canary只允许在权威Message；不进Outbox/Receipt/RunSpec/Auditor；Planning/Note/Execution durable scope由源码与bundle扫描判定 |
| outcome_unknown/外部结果未知 | S4/B2 execution门 | 不用普通重试伪造成功；查询/人工处置语义保持 |
| Project/Rules stale与Hash | Project Context/Rule纵向 | 冻结前三元组变化失败；冻结后旧Run继续用原Selection/Context |

Workflow私有checkpoint可以耐久保存Vercel Hook token；安全门要求它不进入Product Store、Trace、公开API、HTML或浏览器缓存。不能仅因Workflow Store保存自己的身份而误报泄漏。

## 4. 当前数字与缺口

- v10 Memory Selection定向6/6；Note/Policy/Manifest不可变与`allowCustomTags`权威边界12/12；Project/Rules原子上下文8/8；Store迁移/完整性70/70。
- S7兼容/Auditor、故障安全与容量代表门3文件34/34；`@chat/testing`全量25文件189/189，另有dev-runtime 14/14。
- 全仓门：12/12 workspace projects typecheck与build通过；102个Vitest文件891/891，加14个Node测试，共905/905；lint、format:check和`git diff --check`通过。
- Note waiting已经由正式Local World + Hook实现证明可恢复，不再标`blocked_by_S5.4`；同Session Planning+Note是后端支持能力，Web当前一次看护一个Run只是交互约束。
- 本轮未执行付费Provider、真实浏览器、手机viewport或干净环境组合链；由S7.4负责。
- JSON Store规模/备份阈值、Preview统一截断/资源链接、浏览器布局性能与Trace保留策略仍是已知发布证据缺口。
