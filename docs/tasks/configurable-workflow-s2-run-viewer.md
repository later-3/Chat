# S2任务书：真实只读Run Viewer

> 状态：已批准，待实现验收  
> 阶段目标：把S1的产品投影做成桌面左到右、手机可用、可审核的真实运行界面  
> 前置完成门：S1六项反向验证全部通过  
> 参考：React Flow运行画布、Activepieces Input/Output/Timeline、Dify Node Execution Viewer

## 0. 阶段约束

1. 本阶段画布只读：nodesDraggable、nodesConnectable、elementsSelectable等能力按运行查看语义显式限制。
2. 节点、边、状态、输入输出都来自S1 DTO；前端不得从phase、Trace或标题推断事实。
3. 自动轮询或SSE失效不得打断用户正在查看的节点、滚动位置、缩放和平移。
4. 画布不是信息唯一载体；手机、键盘和屏幕阅读器必须有等价的顺序列表/详情路径。
5. 不在use-real-chain继续堆积所有逻辑；Workflow View、Inspector和命令各自使用窄Hook。

## S2.1 React Flow依赖证据与确定性LR布局

### 目标与结果

在真正引入依赖前验证@xyflow/react能满足只读运行查看、键盘、缩放和平移和自定义节点要求，并建立不依赖ELK的确定性左到右布局函数。

### 方案

1. 记录待选版本、许可证、bundle影响、React/TypeScript兼容、SSR/PWA行为、可移除边界和官方文档证据。
2. 用隔离Spike渲染S1的六节点Planning图、一个choice图和一个bounded loop图；Spike只作为证据，未通过门时不合并依赖。
3. 实现纯函数layoutWorkflowView(view, viewportClass)，输入只含语义节点/边，输出临时position：
   - 主序列按topological order从左到右；
   - choice outcome按稳定枚举顺序分层；
   - loop body为嵌套lane，loop_back只作语义边；
   - container子节点在展开时单独布局；
   - 同一输入、同一viewportClass必须字节级相同。
4. 不把position写回Product Store或Definition；布局算法版本只属于前端展示。
5. 提供无Canvas fallback所需的linearizedWorkflowView纯函数。

### 依赖退出标准

- React Flow只封装在WorkflowCanvas边界，领域DTO和测试Fixture不导入其Node/Edge类型。
- 移除React Flow时只需替换renderer和interaction adapter，不改API、Product Store或Definition。
- 若bundle增量、无障碍或移动端实测不符合项目预算，使用SVG/HTML只读布局，不继续堆插件补救。
- 首期不引入ELK、dagre或布局Worker；代表图证明纯布局不足后才能新开依赖审查。

### 测试设计

1. 纯布局golden：六节点、choice、单层loop、container展开、空/单节点和错误结构。
2. 属性测试：随机合法结构的节点不重叠到规定最小间距、所有主边总体向右、结果确定。
3. 组件Spike：节点不可拖动/连线；可点击、可键盘选择、可缩放平移、可重置视口。
4. PWA构建和懒加载Chunk测试；记录加入前后压缩bundle大小，而非凭感觉接受。
5. CSS隔离：React Flow基础样式不覆盖现有Composer、PlanPanel和响应式Token。

### 完成门

- 依赖证据、Spike截图/自动化断言和退出路径写入as-built技术说明。
- 纯布局对当前及S3预计结构都有Fixture，且没有持久化坐标。
- 只有证据门通过才修改package.json和锁文件。

## S2.2 Workflow View Hook与只读横向画布

### 目标与结果

在RealWorkspace中显示当前Run的真实横向节点图，节点状态、层级和边语义随Product Query更新，同时保持现有聊天和计划功能可用。

### 方案

1. 增加useWorkflowRunView(productRunId)独立查询Hook；缓存键含Run ID和API schema version。
2. SSE收到失效事件时只invalidate Query；离线或事件断开继续使用有界轮询，避免两套状态合并逻辑。
3. WorkflowRunPanel作为RealWorkspace中的独立区域，职责只包含加载/空/错误/图/顺序fallback；不接管Run生命周期。
4. 自定义WorkflowNodeCard显示label、node type友好名、status、duration、attempt或loop摘要；颜色和图标外还提供文字。
5. 画布边区分control、outcome、loop_back，但不做装饰性动画来伪装实时进度。
6. 首次载入或用户点击Reset时fitView；轮询更新节点状态不得自动fitView。

### 状态规则

- queued/running/waiting_human/succeeded/failed/skipped/cancelled/outcome_unknown全部有独立文字和Token。
- Product Run终态与节点状态矛盾时显示data_inconsistent错误并停止乐观渲染，不能在前端修补。
- 404/无权限与暂时网络失败使用不同Problem Detail映射；离线保留最后一次成功快照并标记陈旧。
- 切换Run必须清除旧selection，但同Run数据刷新保持selection。

### 测试设计

1. Hook：初次加载、ETag 304、SSE失效、轮询fallback、离线重连、切Run取消旧请求。
2. Canvas：所有状态、语义边、父子折叠、长标题、空图、错误图和legacy信息有限提示。
3. 视口：状态刷新不fit；结构Hash变化才提示图更新；用户Reset恢复确定性布局。
4. 数据边界：组件测试证明不读取run.phase、不导入Trace schema、不读取Runtime ID。
5. 回归：现有消息发送、会话切换、Context选择和PlanPanel测试仍通过。

### 完成门

- 使用S1真实API Fixture渲染，而不是组件私有假Node数组。
- 桌面上主序列明确从左到右；手机fallback可按逻辑顺序遍历。
- Network失败、离线和数据不一致都有用户可理解且可恢复的结果。

## S2.3 Node Inspector：Input、Output、Timeline、Evidence

### 目标与结果

点击任一节点后，用户可以区分“这个节点拿到了什么、产出了什么、发生过哪些状态变化、依据在哪里”，同时大输入输出与敏感数据不会拖垮或泄漏页面。

### 方案

1. useWorkflowNodeDetail(runId, nodeRunId, include)按当前tab惰性查询，取消已切换节点的旧请求。
2. Inspector五个固定tab：Overview、Input、Output、Timeline、Evidence；Trace全文不作为额外tab，只在有调试权限时从Evidence深链到既有Trace Viewer。
3. Manifest slot按Product Ref类型使用专用摘要Renderer；点击后通过相应产品Query查看有权读取的正文。
4. 文本预览服务端先截断，前端再做视觉折叠；下载/打开完整资源必须走具名产品资源路由并显示大小/hash。
5. Timeline只呈现NodeRunTransition和相关Decision/Evidence摘要；Trace深链只在开发/调试权限下跳到现有Trace Viewer。
6. Inspector状态和URL可选查询参数仅保存run/node/tab，不保存正文或Token；刷新能恢复选中项时需再次鉴权。

### 安全与容量

- Markdown正文以安全Renderer显示，不执行HTML、脚本、iframe或远程图片默认加载。
- 错误只显示公开分类、safeMessage、发生时间和可操作建议；Stack、Provider response和Credential永不进入DTO。
- 大列表分页或按slot惰性加载；前端不得JSON.stringify未知对象。
- Preview限制值在S7.2由测量确定；S2先使用服务端统一配置并测试limit与limit+1。

### 测试设计

1. 每种Manifest Ref的摘要、权限、缺失资源、revision过期和hash不匹配。
2. Input/Output为空、单个、多slot、大文本、二进制元数据、未知已升级类型的兼容提示。
3. Timeline顺序、重复transition防御、等待审核、resume、retry多attempt和outcome_unknown。
4. XSS语料、恶意Markdown、超长单词、Unicode、敏感键名扫描。
5. 快速连续点击多个节点只显示最后选择结果；卸载时无setState warning或泄漏请求。
6. 键盘可在节点、tab、资源链接间移动；焦点回到发起节点。

### 完成门

- 一个真实S1成功Run和一个失败Run的每个节点都有可解释详情。
- 大正文不会复制进Workflow View Query，Network面板可证明按需加载。
- 用户能从失败节点定位错误类别和相关产品证据，但看不到内部凭据与隐藏推理。

## S2.4 Human Review节点内嵌审核与幂等交互

### 目标与结果

把现有PlanPanel的审核能力收敛到选中的review节点语义中：用户能读计划、提交批准/拒绝/修订，并清楚看到该Decision绑定的Plan revision/hash和命令状态。

### 方案

1. 保留PlanPanel经过验证的计划阅读与表单逻辑，先抽出ReviewContent而非整页重写。
2. waiting_human review节点显示ReviewContent；画布节点、Inspector Overview和移动端顺序卡都能到达同一操作区，但页面只渲染一个权威表单实例。
3. 提交payload继续包含expectedRunRevision、approvalRequestId、planRevisionId/hash、decision commandId和用户输入。
4. pending command持久化沿用real-storage原则；刷新后恢复同一个commandId并查询结果，不能重新生成后重复消费。
5. 提交期间禁用冲突动作，但允许阅读其他节点；完成后由API响应和Query invalidation刷新，不本地直接把节点改成成功。
6. review_mode为auto_continue时不显示伪审核表单，展示Policy Resolution/Evidence和可追溯原因；它不能被标成human Decision。

### 交互失败

- 409 revision/hash冲突：保留用户备注草稿，刷新最新计划并要求重新确认。
- 命令响应丢失：显示“结果待确认”，用同一commandId查询/重试，不显示失败或成功猜测。
- Hook恢复失败：Decision已提交则显示“已决定，系统正在恢复”，不能允许第二次不同Decision。
- 无权限/Decision窗口已关闭：表单只读并解释原因。

### 测试设计

1. approve、reject、request_revision、auto_continue、默认同意的显式策略证据。
2. 双击、刷新重提、响应丢失、409、500、离线、恢复失败的command identity断言。
3. Decision与Plan revision/hash、Approval Request和review Node Run的端到端一致性。
4. 选中其他节点再返回，未提交备注保留；切换Run则不串草稿。
5. 桌面Inspector与手机卡片不会同时产生两个可提交表单。
6. 现有PlanPanel所有关键测试迁移后保持同等或更强断言，删除重复实现前做行为清单对照。

### 完成门

- 人工决定仍先提交Chat产品事实再恢复Workflow Hook。
- 所有异常路径没有重复Decision、假成功和丢失备注。
- 审核操作的视觉位置属于review节点，但事实所有权没有移到前端或画布。

## S2.5 响应式、无障碍与真实浏览器阶段门

### 目标与结果

证明Run Viewer不是只在组件测试和桌面大屏成立；在真实服务、真实浏览器、手机和键盘场景中可以观察、审核和恢复。

### 方案

1. 桌面：画布占主区域，Inspector为可调整或固定宽度侧栏；不遮挡Composer和会话导航。
2. 窄屏：默认显示线性节点时间线，点节点打开bottom sheet/full-screen detail；提供“画布预览”而非强迫横向拖动完成任务。
3. 使用现有设计Token，所有状态有文字、图标和非颜色差异；焦点样式、减少动画偏好、触控目标符合项目指南。
4. 扩展现有真实Planning E2E：发消息、观察节点推进、等待审核、查看输入输出、提交修订/批准、执行完成、刷新后历史不变。
5. 保存浏览器Console、Network失败、关键对象ID/hash和最终产品对象断言；截图只辅助，不作为完成事实。

### 测试设计与矩阵

| 维度 | 必测代表 |
| --- | --- |
| viewport | 375x812、768x1024、1440x900 |
| 输入 | 鼠标、触控等价操作、纯键盘 |
| 网络 | 正常、慢响应、短暂离线、SSE断开后恢复 |
| Run | running、waiting_human、succeeded、failed、outcome_unknown、legacy limited |
| 数据 | 六节点、多review cycle、多Action container、长标题、大preview |
| 恢复 | 选中节点刷新、审核提交响应丢失、服务重启、浏览器重新连接 |

### 自动化与人工检查

1. Vitest/Testing Library覆盖组件、焦点和Hook状态。
2. Playwright覆盖三种viewport中的主任务、Console零未处理错误、关键Network合同。
3. axe或项目批准的等价检查若新增依赖需单独证据；否则先用语义查询和人工屏幕阅读器清单，不能假称已自动证明全部无障碍。
4. 真实E2E至少复用一条真实B2 Planning Run；故障场景使用可控Adapter，避免付费模型重复调用。
5. 视觉回归只覆盖结构和遮挡，不锁死动态时间、duration或生成正文。

### 完成门

- 三个viewport均能完成“找到等待节点→读计划→查看依据→提交决定→确认继续”。
- 状态更新不重置用户视口、selection、tab或正在填写的备注。
- Console无未处理异常，公开响应无敏感字段，服务重启后图与详情一致。
- as-built交互、调试入口、端口和常见恢复方法同步更新。

## 6. S2阶段反向验证

| 原始诉求 | S2证据 |
| --- | --- |
| 左到右展示数学结构 | 确定性LR布局与真实Run画布 |
| 点节点看输入输出Trace日志 | Inspector的Manifest、Transition、Evidence和受控Trace深链 |
| 审核可停、可修订、可默认继续 | review节点内嵌审核及策略证据 |
| 前后端界定清楚 | API DTO唯一事实源；React Flow类型不越过web边界 |
| 不做一坨复杂前端 | 独立Hook、只读运行模式、无ELK、手机线性fallback、依赖退出路径 |

S2通过后只证明“当前固定流程已经高质量可观察和可审核”。若S2未通过，禁止用S3可配置能力掩盖显示层或事实层问题。
