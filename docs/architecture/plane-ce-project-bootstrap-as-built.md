# Plane CE 项目初始化纵向

> 文档类型：as-built
>
> 固定上游：Plane Community Edition 1.4.1，commit
> `5662b761062b0b2f9d42a6578b55481b5b069792`，AGPL-3.0-only

## 1. 用户结果

用户从 DSH 侧栏点击“创建项目”，进入一个普通新会话。Bridge 为这个会话预选：

1. 内置“项目创建 Agent”Prompt；
2. 现有 Direct Agent Workflow；
3. `project_bootstrap`能力模式。

用户继续用自然语言描述项目。Agent只能调用受控的
`project_bootstrap_prepare`工具生成候选，不能直接创建外部资源。DSH显示候选的Plane
Workspace、Project标识、本地Root、目录和初始Modules。只有用户显式确认后，Application
才会初始化Plane Project和本地Git Workspace。两边都完成并对账后，DSH才显示“进入
Workspace”和“打开Plane”。

这不是特殊Product Session，也不是第二套Workflow。专用侧栏动作只负责把已发布Prompt和
发送级Workflow配置预选到一个普通DSH会话；长期对话、Prompt审核、Direct Agent执行和
Trajectory仍走现有纵向。

## 2. 事实所有权

| 事实 | 唯一所有者 | Chat保存什么 |
|---|---|---|
| Project、Modules、Work Items、状态、成员、进度、面板 | Plane CE | 稳定外部引用和读取快照 |
| 文件、课程材料、笔记、代码、Commit | 本地Git Workspace | 获授权Root与目录绑定 |
| 建项候选、显式确认/拒绝 | Chat Product Store | revision、Hash、Principal和来源Run |
| 外部写入过程 | Chat Product Store | operation、结果未知、错误和对账状态 |
| DSH会话与当前项目的关联 | Chat Product Store | Plane Project ID + Workspace Root/目录 |
| Agent运行、Prompt审核、工具Journal | Chat | 现有Run/Attempt/Trace事实 |

Plane不拥有Chat Session、Run或Agent完成事实；Chat也不复制Plane的项目状态机、看板、通知
或任务CRUD。旧Chat原生Project聚合仍为历史兼容代码，本纵向不双写它，也不把它当Plane
项目的第二真相。

## 3. 运行链路

```text
DSH“创建项目”
  -> 新DSH Session + 固定Prompt/Direct配置
  -> User与Agent澄清目标
  -> project_bootstrap_prepare（只准备候选）
  -> Product Store Candidate(prepared)
  -> DSH显示可读预览
  -> User confirm/reject
  -> Decision + queued Operation
  -> Workspace Adapter：Root白名单/一级子目录/Git/模板/marker
  -> Plane CE REST Adapter：查询业务键/创建Project/创建Modules
  -> 读后对账
  -> ready Binding
  -> DSH进入Workspace / 打开Plane
```

创建目录和Plane资源是两个不可原子提交的外部副作用。Plane公共REST没有通用
Idempotency-Key或expected revision，因此Application保存operation；Adapter使用
`external_source=chat`与`external_id=<operationId>`查询后创建。网络在写后断开时，操作进入
`outcome_unknown`，不得盲重试；用户点击重试会先按稳定业务键查询和对账。本地目录使用
`.chat/project-bootstrap.json`绑定同一个operation和candidate Hash，避免把已有任意目录误认
为本次创建结果。

只有Workspace和Plane两步都为`completed`时才建立Binding和显示`ready`。失败或结果未知
不会产生假成功。

## 4. 配置与权限

启用能力必须同时配置：

- `CHAT_PLANE_CE_BASE_URL`
- `CHAT_PLANE_CE_API_TOKEN`
- `CHAT_PLANE_CE_WORKSPACES_JSON`
- `CHAT_PROJECT_CREATION_ROOTS_JSON`

未配置时普通Chat能力不受影响；只配置一部分时组合根失败关闭。非loopback Plane地址强制
HTTPS。API Token只进入服务端Plane Adapter；浏览器只得到Plane Web Origin、允许的
Workspace slug和无绝对路径的Root描述。目录名必须是安全的单段名称，目标只能是配置Root
的一级子目录。

当前受控写能力仅包含：

1. 创建一个Plane Project；
2. 为项目创建初始化Modules；
3. 创建一级本地目录、受控模板和Git仓库。

Agent没有Plane原始REST、删除、任意PATCH、Shell或任意文件路径能力。后续推进若需要创建
Work Item或更新状态，应以新的窄工具和独立确认/对账合同逐项开放，不能把API Token或通用
HTTP工具交给Agent。

## 5. CE部署与退出路径

仓库的`scripts/plane-ce/lock.json`固定Plane源码、许可证、上游Compose Hash以及全部容器镜像
digest。`pnpm plane-ce:prepare`校验并生成私有的锁定Compose和0600环境文件；
`pnpm plane-ce:up`拉取并启动本机CE。该管理器是本地开发/验收便利层，不是Chat运行依赖。

其他环境可以按Plane CE官方方式独立部署同一固定版本，Chat只通过公开REST连接。迁移环境时
需要迁移Plane自身数据库/对象存储，并把Chat的Base URL、Token和Workspace白名单切到新
实例；本地Git仓库按普通Git方式迁移。Chat没有私有Plane数据格式，也不需要复制Plane前端。

停止本机服务使用`pnpm plane-ce:down`，不会删除`.data/plane-ce`中的卷数据。删除或重建数据
不属于普通停止命令，必须另行人工授权。

## 6. 完成门

1. 合同/Domain/Application/Store测试覆盖：确认前零外部写、确认后唯一Binding、结果未知无
   假ready、迁移和引用完整性。
2. Adapter测试覆盖：Plane查询后创建/查重/Module对账；Workspace真实Git、幂等marker、路径
   越界和已有目录冲突。
3. API/Bridge测试覆盖：专用入口预选Prompt和能力、显式决定、刷新恢复、ready目标。
4. 锁定部署测试覆盖：来源Hash、镜像digest、无`latest`、Compose可解析。
5. 真实CE门：固定容器健康、Web入口可达；提供有效Token后再运行真实创建/对账门。
6. 根级`build`、`lint`、`format:check`、`typecheck`和`test`全部通过。

真实创建门是`pnpm test:provider:plane-ce`。它默认拒绝运行，只有显式设置
`CHAT_PLANE_CE_REAL_TEST=1`及专用Project/目录身份后才会产生持久副作用；成功后再次查询
Plane external ID、Workspace marker和Git仓库，不以单次POST响应宣告完成。
