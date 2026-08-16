# Chat 技术与所有权合同

> 本文冻结系统边界。当前落地事实见[PROJECT_STATE.md](../../PROJECT_STATE.md)。

## 1. 技术栈

| 层 | 选择 | 责任 |
|---|---|---|
| 唯一主前端 | DeepSeek Harness Web（固定版本） | 原生会话、消息、Composer、布局、主题和Client插件宿主 |
| 前端集成 | `@chat/dsh-lifeos-bridge` | DSH Host/Client插件、Chat Query/Command适配、HITL与Workbench表面 |
| HTTP | Node.js + Hono | 认证上下文、运行时校验、REST和未来SSE协议终止 |
| Product Core | TypeScript Domain + Application | 状态机、权限、用例、事务、幂等和产品提交 |
| Product Store | 当前版本化JSON Adapter | 权威产品事实；未来可替换生产Store |
| Durable Workflow | Vercel Workflow | 耐久步骤、暂停、恢复、重放和Checkpoint |
| Agent Runtime | `pi-agent-core` | Workflow中的Planner/Executor与Tool节点 |
| Memory | Port + memmy / Tencent MemoryCore Adapter | 外部Memory查询、导入与对账 |
| Hosted Workbench | code-server（固定版本） | Files、Editor、Terminal、Git、Diff和VS Code扩展 |
| 验证 | Vitest/Node Test + Playwright | 单元、合同、集成和真实浏览器纵向 |

## 2. 系统拓扑

```text
Browser
  -> DSH Web Host
     -> DSH Client Plugin Graph
     -> LifeOS Bridge Host
        -> Chat Hono API
           -> Application -> Product Store
                         -> Transactional Outbox -> Vercel Workflow -> pi
     -> Hosted Workbench proxy -> code-server
```

DSH和code-server是可替换Adapter/Hosted App，不拥有Chat产品对象。Chat API不依赖DSH类型；Domain/Application不依赖Hono、DSH、Vercel Workflow或pi。

## 3. 前端合同

### 3.1 DSH负责

- 会话列表、原生聊天轨迹、Composer、主题、响应式布局和插件Slot。
- 显示Host插件返回的文本流与Client插件提供的产品投影。
- 保存草稿、滚动、当前视图等可丢弃界面状态。

### 3.2 DSH不负责

- 创建或修改Product Store事实。
- 判断Product Run、Plan、Approval、Tool或项目对象的权威状态。
- 直接调用Workflow、Hook、pi、Provider或Memory服务。
- 把DSH Session ID当作产品身份或授权。

### 3.3 LifeOS Bridge负责

- 固定DSH Session与Product Session的Adapter映射。
- 将DSH正常对话请求变成Chat公开Command/Query。
- 保留稳定`commandId`，处理网络结果未知和刷新恢复。
- 在DSH公开Slot中展示Plan/HITL；决定仍走Chat Command。
- 将Chat正式Assistant Message以DSH文本流投影回原生轨迹。
- 为完整Hosted App提供窄Surface与受控Host代理。

`session-title`、`compaction`等DSH内部辅助请求不能创建Chat Message或Run。

## 4. API与事务合同

Query读取资源并返回revision/ETag/cursor；Command表达一次用户意图并使用：

```json
{
  "commandId": "cmd_...",
  "expectedRevision": 7,
  "payload": {}
}
```

规则：

1. 同一`commandId`与同一规范化请求返回原结果；相同ID换正文必须409。
2. 修改已有对象必须CAS；Decision还绑定Plan/Approval的ID、revision和SHA-256。
3. Router不直接写Store；Application在事务中提交事实、Receipt与Outbox。
4. HTTP响应丢失不能产生新的命令身份。
5. 错误使用稳定Problem Details；公开响应不含密钥、Stack、隐藏推理或Runtime私有ID。

## 5. Workflow与pi合同

- Product Run先于Workflow Run存在，两者不能合并。
- Workflow只接收不可变输入和产品引用；通过私有Application活动读取/提交事实。
- Step必须可重放；非确定性值、模型调用和外部I/O进入Step边界。
- pi是Agent节点，不创建Product Session、Approval、Memory或完成事实。
- 模型输出先成为候选；确定性校验与Product Commit之后才是正式结果。
- 付费模型失败默认不盲目自动重试；外部副作用必须有幂等、结果未知与对账。

## 6. HITL合同

1. Workflow创建私有Hook并请求Application创建Approval事实。
2. 用户通过DSH Client表面读取Plan/Approval。
3. Client把意图交给Bridge Host；Host提交Chat Decision Command。
4. Application校验Principal、Run revision、Plan/Approval版本与Hash，并原子提交Decision和Resume Outbox。
5. 后端Dispatcher私下恢复Hook。

浏览器永远不持有Hook Token。

## 7. Workbench合同

- code-server作为独立进程/容器运行，不拆UI组件。
- 只挂载获准Workspace，使用独立UID、清洗后的环境和独立user-data/extensions目录。
- 仅绑定loopback/internal网络；DSH Host负责鉴权、健康、HTTP与WebSocket代理。
- DSH用顶级Surface打开，关闭后原聊天Session、草稿和滚动保持。
- code-server写文件或执行命令不自动成为Chat产品完成事实。

## 8. 实时与恢复

当前Bridge使用公开Query恢复Run、Messages、Plan和Approval。未来加入Chat拥有的SSE Cursor Journal时，它只提供有序事件和资源失效通知，不成为产品事实源，也不改变Query/Command合同。

必须覆盖：浏览器刷新、DSH Host重启、API重启、Workflow Worker恢复、重复Command、响应丢失、过期Decision、Provider结果未知和Workbench进程崩溃。

## 9. 依赖与升级

每个外部依赖记录精确版本、来源、integrity、许可证、运行边界、升级测试和退出方式。DSH/code-server不以源码副本进入仓库；升级只替换固定版本并通过合同与真实浏览器E2E。需要长期维护上游补丁时必须重新审核其成本，不能静默形成Fork。

## 10. 完成门

1. 全仓格式、lint、typecheck、test、build和生产依赖审计通过。
2. DSH原生Host与Client插件真实启动，不是旁路Adapter页面。
3. 真实浏览器完成发送、Plan、修订/批准/拒绝、执行、正式回复与刷新恢复。
4. 浏览器Bundle/响应/日志不泄漏凭据或Runtime私有身份。
5. Workbench真实验证Files、Terminal、Git与Diff，WebSocket和停止回收通过。
