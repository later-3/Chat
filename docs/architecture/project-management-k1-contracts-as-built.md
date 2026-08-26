# 全项目生命周期 K1 合同 As-built

> 文档类型：当前源码事实与调试路标
>
> 实现日期：2026-08-25
>
> 上位规范：[Chat 全项目生命周期管理蓝图](../product/project-management-system-blueprint.md)

## 1. 已实现结果

K1已经把蓝图的第一组工具无关语义变成可执行合同，不再只存在于讨论或Markdown中：

1. `ProjectProfileRevision`：版本化Object Catalog、生命周期、时间政策、Authority、Evidence、六类Context、View Requirement、Maintenance Cadence和Metric；
2. `ProjectConfigurationRevision`：一个真实Project选择的Profile Revision、目标、范围、时区、目标日期/Cadence、参与者、Resource Capability和Presentation Capability Binding；
3. `ProjectEvent`：明确区分`occurredAt / observedAt / recordedAt`，对象Revision变化必须连续；
4. `ProjectNeed`与`ProjectRequirement`：Need被捕获不等于形成Commitment，Committed Need必须绑定Decision；
5. `ProjectArtifactRef`：正文或二进制仍由Resource拥有，Chat只保存locator、revision、Hash和Provenance Event；
6. `ProjectMetricObservation`：指标必须带窗口、单位、来源和Evidence，不能用当前值覆盖历史；
7. 工具无关View：`project_home/work/timeline/calendar/object_detail/document/code/media/review/report/relation/attention`；
8. 工具无关Resource能力：`discover/read/write/version/diff/search/watch/render/export`。

## 2. 代码路标

| 责任 | 源码 |
|---|---|
| ID、网络Schema和Type | `packages/contracts/src/ids.ts`、`project-management.ts` |
| 四个内置Profile与通用编译器 | `packages/domain/src/project-management.ts` |
| 网络不变量测试 | `packages/contracts/src/project-management.test.ts` |
| Profile差异、确定性和反例测试 | `packages/domain/src/project-management.test.ts` |
| 跨Contracts/Domain与第五Profile测试 | `packages/testing/src/project-management-profile-k1.test.ts` |

Domain不依赖Contracts。Domain编译器返回普通形状并计算Canonical Hash；网络边界再用Contracts严格解析。这保持依赖向内，也防止Zod或HTTP合同进入领域内核。

## 3. 四种内置Profile

| Profile | 关键对象 | 类别默认时间模式 | 必需View差异 | 终态Evidence差异 |
|---|---|---|---|---|
| `software-delivery` | Need、Requirement、Work、Artifact、Review、Acceptance | `delivery` | Code、Document、Work、Timeline、Review、Report | 代码/Artifact Revision、测试、用户验收 |
| `content-production` | Source语义、Artifact、Media、Publication、Case、Practice | `continuous` | Document、Media、Work、Timeline、Review、Report | Source/内容Revision、QC、用户审核、发布回执 |
| `learning` | Competency、Assessment、Knowledge、Work、Review | `continuous` | Document、Calendar、Timeline、Report、Relation | 测评、独立讲解、练习、作品和反馈 |
| `personal-journal` | Capture、Daily Entry、Report、跨Project关系 | `continuous` | Document、Calendar、Timeline、Report、Relation、Attention | 原始记录、用户修订和关联Project Event |

内置Profile不是核心分支上限。`compileProjectProfileRevision`接受符合稳定key和通用不变量的定义；测试中的`research-goal.fixture.v1`不修改Router、Store或编译函数分支即可编译并通过网络Schema。

这四项是管理类别，不是Chat、Content Lab、AI学习或个人日报等实际Project。具体Project的名称、目标、目标日期和日/周/月Cadence进入
`ProjectConfigurationRevision.schedulePolicy`。Application反例验证同一个`learning` Profile同时支撑有期限的AI职业学习和无期限的长期哲学阅读。

## 4. 已冻结不变量

1. Profile保存View Capability，不保存某个Viewer或某个DSH页面名称；
2. Profile不得保存实际Project名称、业务目标、目标日期或具体执行Cadence；这些由Configuration拥有；
3. Configuration才选择当前Presentation Provider；更换Viewer不改变Project或Artifact身份；
4. Profile必须包含Project、Objective、Need、Resource、Artifact、Evidence、Decision和Event八类必需对象；
5. Opening、Execution、Delta、Review、Handoff、Maintenance六类Context缺一不可且不能重复；
6. View Requirement和Maintenance Cadence key不能重复；
7. Agent自报不能成为终态Evidence；
8. Need只有进入`committed`才绑定承诺Decision；
9. Project Event必须满足`occurredAt <= observedAt <= recordedAt`；对象Revision变化必须同时记录连续before/after；
10. Configuration只有`adopted`状态才能且必须绑定采用Decision和`effectiveFrom`；
11. Artifact正文不进入该合同，只有Resource、locator、Revision、Hash和Provenance。

## 5. 后续实现状态

K1合同存在不等于用户纵向已经完成。当前边界是：

- Product Store v23已经持久化Profile/Configuration/Event/Need/Requirement/ArtifactRef/Metric集合，迁移与完整性事实见[全项目生命周期 K2 Product Store实现](./project-management-k2-store-as-built.md)；
- Configuration Candidate/Decision/Adoption、Project Home、六类Context和Maintenance Plan已经由K2 Application消费；
- Maintenance只按显式触发编译计划，尚未由Workflow自动调度；
- DSH还没有Project Home、Attention、Timeline或Document View；
- 现有P8 `ProjectContextMap v1`、`Method Snapshot v3`和`content-lab-*`专用合同仍是兼容事实，尚未迁移到通用Profile/Configuration；
- Content Lab运行了真实JsonProductStore重启纵向；AI学习、长期阅读、个人日报和Chat当前仍是确定性场景Fixture，尚未写入正式Product Store。

不得因为K1 Schema与测试或场景Fixture通过，就宣称全项目生命周期管理已经完成正式采用。

## 6. 已运行验证

- Contracts K1测试：4/4；
- Domain K1测试：5/5；
- 跨包Profile K1测试：5/5；
- K1修改前的双谱系集成根级`pnpm typecheck`和`pnpm test`已通过；
- K1修改后的最终根级质量门以当前Commit的交付报告为准。
