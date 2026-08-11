# S6任务书：受约束Definition Designer

> 状态：已批准，待实现验收  
> 阶段目标：让用户复制Chat已支持的Blueprint，在前端通过受约束节点操作形成、校验、发布和运行自己的Definition  
> 前置完成门：S5证明Planning与Note共享同一内核  
> 关键边界：设计器编辑语义结构，React Flow只负责可视化和受控拖放，不拥有可执行事实

## 0. 阶段约束

1. 不提供空白万能画布；用户从Planning/Note Blueprint或已发布Definition副本开始。
2. 不支持自由连线、任意回边、任意代码/HTTP/表达式、任意节点包和secret字段。
3. System Definition只读；用户先创建copy再编辑。所有保存产生不可变Draft Revision，发布由服务器CAS和Compiler决定。
4. 浏览器本地校验只为即时反馈；即使绕过前端，后端也必须拒绝同样的非法结构与策略。
5. 画布位置、折叠、缩放和选中项属于View State，不进入Definition Hash或RunSpec。

## S6.1 Definition草稿、Revision、发布、归档与CAS命令

### 目标与结果

把S4只读Definition生命周期补成可编辑产品用例：用户可以复制、保存草稿、验证、发布和归档，同时多标签页/多设备不会静默覆盖。

### 方案

1. createDefinitionFromPublished：从有权读取的Published Revision复制语义，创建user_copy Definition及首个Draft Revision；不复制owner、运行历史或Runtime绑定。
2. saveDefinitionDraft：输入expectedDefinitionRevision、baseRevisionId/hash和完整strict semanticRoot；服务器重新validate/normalize/hash，创建新不可变Draft，旧Draft标superseded并CAS更新Definition currentDraftRevisionId。
3. validateDefinition：对未保存payload执行同一Validator/Compiler前半段，返回diagnostics、normalized summary和candidate hash；不写Store。
4. publishDefinition：只接受当前Draft ID/hash与expectedDefinitionRevision；再次完整验证，创建/转换Published Revision，旧Published变superseded，原历史内容不变。
5. archiveDefinition/restoreDefinition：只改变Definition聚合status；已发布Revision和历史Run保持可读，archived不能发起新Run。
6. 删除不在本阶段；误操作通过Revision历史和archive恢复，不做危险硬删除。

### 一致性与并发

- 每次Definition聚合写入有command receipt和expectedRevision；相同command/payload返回原Revision。
- 保存草稿与发布不能用last-write-wins；冲突返回server current revision/ref/hash，不回显另一用户未授权内容。
- 一个Definition最多一个current Draft和一个current Published ref，但所有旧Revision保留。
- Published Revision内容不可原地改state以外字段；若实现采用新Published对象，语义Hash关系必须明确且测试固定。
- system Definition的Seed升级创建新Published Revision，不覆盖用户copy或其base ref。

### 测试设计

1. copy、save、re-save、publish、publish新版本、archive/restore的完整状态表。
2. 双标签页A/B：A保存后B保存409；A发布后B发布旧draft失败；草稿内容无丢失。
3. 重复command、同command异payload、响应丢失重试、事务中间异常。
4. system Definition直接编辑/归档拒绝；跨owner copy/read/write权限。
5. Draft/Published/Run历史引用完整性，Store重启与迁移后不漂移。
6. 超大payload、未知schemaVersion、恶意displayName/description、Hash篡改。

### 完成门

- 生命周期全部由Application用例和Product Store事实拥有，Router/React不直接改Revision。
- 任意发布都能指出唯一Draft、Compiler diagnostics和Hash；任意历史Run仍指向当时Revision。
- S6.2到S6.6只消费这些命令，不另建临时Definition后台。

## S6.2 Catalog/Blueprint公开合同与Schema驱动的受控配置表单

### 目标与结果

前端能根据后端公开的有限字段描述显示节点目录和配置表单，同时真实校验Parser继续只在服务端，避免前后端手写两套失控Schema。

### 方案

1. Query提供WorkflowBlueprintSummary/Detail、NodeTypePublicDescriptor和Definition Detail；带catalogVersion、blueprintVersion、ETag和supportedClientSchemaVersions。
2. Public Config Field是严格判别联合：boolean、enum_select、bounded_integer、short_text、resource_selector、rule_selector、skill_selector、review_mode。
3. 每类字段只暴露显示所需安全元数据：name、label、help、required/default、允许范围/option refs；不暴露Zod AST、正则实现、Executor key、secret或动态表达式。
4. Resource类字段只描述选择器能力，实际选项来自有权限的产品Query；Definition保存的是策略/slot配置，Run时资源选择按Blueprint决定是否覆盖。
5. web实现穷尽NodeConfigFieldRenderer；未知type/version显示升级阻断，不退回任意JSON textarea。
6. Catalog Conformance从S3扩展到公开DTO：每个字段能被server parser接受，default与normalization一致，私有字段不会投影。

### 版本与缓存

- Definition Detail携带其blueprint/catalog schema refs；前端不能用最新Catalog悄悄解释旧Revision。
- 不兼容旧Descriptor时只读展示原安全配置摘要，禁止编辑/发布，给出升级Definition动作。
- Catalog/Blueprint可长缓存但ETag变化必须失效；正在编辑草稿保持原版本并在保存时获得stale诊断。
- 显示文案变化不一定改执行Schema版本；影响config/outcome/风险的变化必须升版本。

### 测试设计

1. 八类field的DTO parse、renderer、默认值、错误、帮助文本和无障碍label。
2. 每个实际Node Type执行public→form value→command→server parser round trip。
3. unknown field/type/version、Catalog升级、Blueprint旧版本和不兼容Definition只读路径。
4. secret/private key投影扫描；恶意label/help做XSS测试。
5. Resource selector权限、分页、归档、stale ref和空结果。
6. 契约删除测试：私自改变server default或新增必填私有字段时Conformance失败。

### 完成门

- 前端没有Node Type专属重复校验逻辑，只有必要的专用体验组件。
- 后端Parser和Policy仍是发布权威；篡改表单请求不会绕过。
- Catalog版本漂移有明确只读/升级语义，不会静默按新规则运行旧Definition。

## S6.3 Sequence与Optional Task的语义化编辑

### 目标与结果

用户可以在Blueprint允许的槽位添加、移除、排序和默认启停节点；拖拽只产生可解释的结构操作，Definition中不保存自由坐标或任意edge。

### 方案

1. 设计器由三部分组成：左侧允许节点目录、中间结构化LR画布、右侧节点配置/诊断Inspector。
2. 本地Working Copy只保存semanticRoot与base revision/hash；structure-operations纯函数提供insertTask、moveElement、removeOptionalTask、setDefaultActivation、updateNodeConfig。
3. Blueprint提供allowedSequenceSlots、required roles和cardinality；画布只显示合法drop zones。拖入非法位置立即拒绝并说明，不先造非法edge。
4. 节点位置由S2布局派生；onNodeDrag结束根据目标drop zone执行moveElement，随意坐标变化不写Working Copy。
5. required Task不可删除/disable；optional且skipPolicy允许的Task可设置defaultActivation=enabled/skipped，编译后保留为明确skipped Node而非从历史图消失。
6. 所有鼠标操作提供键盘等价：添加到位置、上移/下移、移到组、启用/停用、撤销/重做。

### 本地状态与保存

- Working Copy、undo/redo和view state分开；undo只作用于未保存本地语义操作。
- 浏览器草稿持久化按definitionId + baseHash隔离；服务端保存成功后以返回normalizedRoot替换本地基线。
- dirty判断比较normalized semantic hash，不比较坐标/selection/折叠。
- 切换Definition、刷新、关闭页面时提示未保存语义变化；view state变化不提示。
- 不做实时多人协同或CRDT；CAS冲突由S6.5显式处理。

### 测试设计

1. 每个structure operation的纯函数测试：成功、非法slot、required删除、跨容器move、ID稳定、undo/redo。
2. 拖放只产生一次语义操作；小幅移动/取消拖动不脏；坐标不出现在save payload/hash。
3. optional默认skipped编译后Run Viewer显示skipped；required节点前端与后端都拒绝。
4. Blueprint cardinality：0/1/最大/超最大，重复Node Type与允许重复类型。
5. 本地草稿刷新恢复、baseHash不匹配隔离、保存后清理、切换Definition不串。
6. 键盘全路径与焦点顺序；触控使用明确“移动”模式避免页面滚动冲突。
7. 保存payload经S3 Validator，恶意直接调用operation也不能越权发布。

### 完成门

- 用户可通过拖拽/键盘改变顺序和optional节点，但无法画出不被IR表达的结构。
- semanticRoot是唯一保存内容，React Flow position/edges只是投影。
- Planning/Note两个Blueprint各完成一次合法编辑和非法操作拒绝测试。

## S6.4 Choice与BoundedLoop结构编辑

### 目标与结果

在不开放自由连线的情况下，让Blueprint允许的分支和循环通过专门容器表单可视化、可配置、可验证。

### 方案

1. Choice由“添加分支容器”操作创建：先选Blueprint允许的source outcome节点，再从Catalog枚举结果生成固定分支栏；用户不能输入表达式。
2. 分支增删只在Blueprint允许可选outcome时发生；required outcomes必须有显式body或明确empty policy。
3. BoundedLoop由“添加有界迭代”操作创建：选择body slot、continue/exit outcomes、maxIterations和exceededPolicy；范围由Blueprint/Policy给定。
4. 画布使用嵌套lane横向展示Choice和Loop；loop_back为渲染语义，不可拖动/重连。Inspector展示结构摘要和运行时iteration如何查看。
5. structure-operations增加wrapInChoice、moveIntoBranch、unwrapChoice、wrapInBoundedLoop、updateLoopPolicy、unwrapLoop；每个操作保持ID或按明确规则新建。
6. 不支持用户创建Composite；Composite由Blueprint/Executor定义并只在运行时展开。

### 结构规则

- Choice source必须结构上支配Choice且outcome enum版本匹配。
- 分支内部ID全局唯一；分支离开后不能直接引用内部Node output。
- Loop必须有编译期有限maxIterations和运行时总预算；不能嵌套超过Blueprint上限。
- unwrap只能在不会丢失语义时执行；否则要求用户先选择保留分支/移除循环，并显示影响。
- 改source Node Type导致outcome不兼容时Working Copy立即诊断，不自动猜分支映射。

### 测试设计

1. Choice创建、固定outcome、可选empty branch、move进入/移出、source变化、unwrap。
2. Loop创建、min/max、continue/exit、exceeded fail/request_human、嵌套上限、unwrap。
3. 结构操作后Schema parse、domain validate、normalize/hash、render layout全链性质测试。
4. 非法未来引用、兄弟输出、任意回边payload、表达式字段和超限iteration服务端拒绝。
5. 画布与线性树视图表达同一语义；手机不依赖看懂回边才能编辑。
6. 发布并用静态Executor运行choice两分支、loop两轮退出、loop超限三组真实Workflow Fixture。

### 完成门

- 用户能配置Chat允许的分支/循环，但页面不存在自由edge handle或表达式编辑器。
- 任一合法视觉操作都能产生合法IR；任一非法后端payload都被同一Validator拒绝。
- 运行Viewer的iteration/selected outcome与设计器语义一致，不需要特殊翻译。

## S6.5 实时诊断、预览、脏状态与CAS冲突UX

### 目标与结果

用户在保存/发布前能定位结构、配置、资源和策略错误；并发修改时能看懂冲突并安全选择重新应用，而不是覆盖或丢草稿。

### 方案

1. 本地快速诊断覆盖required、field type、明显结构错误；服务端validate使用防抖/显式按钮调用完整S3 Validator，返回stable code/path/severity/help。
2. Diagnostics映射到节点、容器和全局列表；点击错误定位节点并聚焦字段。未知path显示全局错误，不因前端版本旧而丢失。
3. Preview展示normalized结构、View Snapshot和本次Definition Hash，不执行Workflow、不调用模型、不创建Run。
4. 保存草稿成功后使用服务器返回normalizedRoot/hash/revision作为新base；前端不自行宣称Hash。
5. 409 CAS冲突保留local operations和server current revision；提供“查看变更”“基于最新版本重新应用我的操作”“另存为副本”，不提供一键强制覆盖。
6. 重应用以语义operation log尝试，不做文本JSON merge；任一operation失效时停止并逐项提示。

### 诊断优先级

- error：Schema/结构/策略/权限/资源版本问题，禁止保存或发布按服务器规则决定。
- warning：合法但可能无效果/高成本/历史版本兼容，允许保存草稿，发布门可按Blueprint提升为error。
- info：默认值、自动skip和布局说明。
- 安全与高影响策略不能被前端“忽略warning”绕过。

### 测试设计

1. 每类S3 diagnostic path映射到正确节点/字段；多错误稳定排序与去重。
2. 快速连续编辑取消旧validate请求，旧响应不覆盖新结果；离线仍保留本地诊断并标服务器未验证。
3. Preview不产生Store/Outbox/模型调用；hash与保存后服务器hash一致。
4. CAS：互不冲突move/config可重放，已删除节点上的config操作失败并保留，base Blueprint升级阻断。
5. 未保存提示只由语义dirty触发；视口/selection变化不触发。
6. 恶意diagnostic message/path安全渲染，不插HTML或泄漏Server stack。
7. 草稿恢复和另存副本的command identity、owner与source revision正确。

### 完成门

- 非法Definition无法发布；用户能从错误列表到具体控件完成修正。
- 并发冲突没有silent overwrite、丢草稿或自动JSON merge。
- Preview与实际Published View/Hash有合同测试，避免“预览一套、运行一套”。

## S6.6 发布、发起Run与历史版本稳定

### 目标与结果

用户发布一个自定义Definition后可以从Composer选择并发起Run；随后继续编辑/发布新版本时，已活动和历史Run仍按原Revision、RunSpec和View Snapshot显示/恢复。

### 方案

1. Publish成功后Definition Query显示新Published ref；Composer只列active、Blueprint兼容、有权限的Published Revision。
2. 发起Run继续使用S4.2事务：客户端提交Published revision/hash，服务器重新编译资源和策略，写不可变RunSpec。
3. 新Run的View Snapshot由Published semanticRoot生成并Hash绑定；Viewer不回读当前Definition。
4. Definition更新/归档只影响新建Run列表；活动Run的Runner manifest、Node config、limits、资源refs和View均不变。
5. 不兼容Executor部署时按RunSpec manifest/version recovery处理；不能用最新Executor“尽量跑”旧Run。
6. Published Definition不能因运行失败被自动修改；修复走新Draft/Published Revision。

### 版本稳定场景

1. 发布Revision A并发起Run A，停在review。
2. 从A保存/发布Revision B，修改optional节点顺序和loop上限。
3. Run A继续审核/恢复，仍显示A图、A配置和A Hash。
4. 新Run B使用B；两个Run的Node identity和结果不串。
5. 归档Definition，A/B历史可看，活动Run继续，新Run入口消失。

### 测试设计

1. Publish→Composer cache invalidate→选择→submit→RunSpec/View refs全链。
2. 上述A/B场景在真实Workflow checkpoint与服务重启后验证。
3. 归档、恢复、无权、Blueprint/Catalog不兼容、Executor manifest不兼容。
4. Definition hash被篡改、客户端提交旧hash、发布后资源变化的失败分类。
5. 同一Published Revision并发发起多个Run，各有独立RunSpec资源refs和Node Runs。
6. Viewer历史页面不发Definition latest Query也能完整显示当时图。

### 完成门

- “设计—发布—运行”成为真实产品闭环，不是仅保存JSON。
- 修改Definition不能改变活动/历史Run；测试通过关闭服务再恢复仍成立。
- 运行失败不会污染Published Revision或自动回退到别的Revision。

## S6.7 响应式、无障碍、安全与真实设计器E2E

### 目标与结果

证明受约束设计器在真实浏览器、桌面和手机上能完成用户核心配置任务，同时不能通过UI或API越过Blueprint/Policy。

### 方案与真实主场景

1. 复制system Planning Definition为个人Definition。
2. 在允许slot添加/启用Project Rules节点，停用一个可跳Memory节点，设置manual review与两轮上限。
3. 故意产生一个非法移动，看到诊断并修复；保存Draft、发布。
4. 从Composer选新Definition发起Run，Viewer显示Memory skipped、Rules执行、Review等待。
5. Run等待时发布Definition B；批准旧Run并验证仍按A完成。
6. 复制Note Definition，修改允许的review默认策略，发布并发起最小Note Run，证明第二Blueprint可编辑。

### 测试设计与矩阵

| 维度 | 必测 |
| --- | --- |
| viewport | 375x812线性结构编辑、768x1024、1440x900 LR画布 |
| 操作 | 鼠标拖放、触控移动模式、纯键盘结构操作 |
| 生命周期 | copy、dirty、validate、save、conflict、publish、archive、run |
| 结构 | sequence、optional、choice、bounded loop及非法表达 |
| 版本 | Catalog旧客户端、Blueprint升级、A/B历史稳定 |
| 安全 | 越权Definition、篡改nodeType/risk/limit/executor、XSS文本、大payload |
| 恢复 | 刷新本地草稿、响应丢失、API/Workflow重启、离线重连 |

### 自动化与人工证据

1. Vitest覆盖纯structure operations、renderer、Hook和冲突状态机。
2. API/应用合同覆盖所有Command identity、CAS、权限和Validator failure。
3. Playwright完成两个Blueprint真实主场景；真实模型只在最终发起Run处最小调用，编辑验证不调用模型。
4. Console零未处理错误；Network断言无Runtime/secret；Store断言Revision/RunSpec/View Hash链。
5. 语义HTML、焦点、键盘与屏幕阅读器清单；状态和错误不只靠颜色/画布位置。
6. as-built交互文档说明拖拽实际产生的语义操作、为何无自由连线、手机如何等价编辑。

### 完成门

- 桌面和手机都能完成copy→edit→validate→publish→run，不需要编辑原始JSON。
- 用户不能从前端产生服务端接受的任意回边、无界循环、高风险skip或未知节点。
- A/B版本稳定、CAS冲突和刷新恢复真实通过。
- 只有本任务通过才进入S7整体验收。

## 8. S6阶段反向验证

| 用户原始要求 | 设计器回答 |
| --- | --- |
| 前端拖拽搭工作流 | 拖拽映射insert/move/wrap等语义操作，后端再验证/编译 |
| 已有节点自己组合 | Catalog + Blueprint限定节点和slot，可添加/排序/配置 |
| 节点死人/不死人 | optional + skipPolicy + defaultActivation/per-run override，不是任意disabled |
| 加决策、停下来问 | human review节点与Choice/BoundedLoop专用结构 |
| 不想重写代码 | 组合已有节点无需改Runner；新增Node Type仍需高质量代码与测试 |
| 运行后不能改 | Run绑定Published Revision、RunSpec和View Snapshot；编辑只影响新Run |

S6不把Chat变成n8n；它交付的是Chat自己的有限Workflow设计器，边界由产品对象、Blueprint和策略共同约束。
