# Chat 项目状态

> 更新日期：2026-08-07

## 1. 当前结论

| 项目 | 当前事实 |
|---|---|
| 产品身份 | 独立、完整、持续运营的Chat产品 |
| 主分支 | `main` |
| 前端 | React + TypeScript + Vite；响应式PWA |
| 后端 | Node.js + TypeScript；Hono Web/API Adapter |
| 产品接口 | REST Query/Command + 运行时校验 |
| 实时接口 | Chat有序SSE事件流；Agent事件采用AG-UI兼容语义 |
| Workflow | Vercel Workflow |
| Agent Runtime | `pi-agent-core` + `pi-ai` + `pi-coding-agent` |
| 前端服务端状态 | TanStack Query；浏览器仅持有投影与草稿 |
| 代码状态 | P0、P1.1、P1.2、B1调试/Trace已合并；B2纵向闭环代码已完成确定性实现与审核修复 |
| 当前阶段 | B2真实规划—确认—执行纵向闭环 |
| 当前任务 | 真实百炼Provider与浏览器E2E由用户配置本地Key后验收 |

## 2. 已冻结决定

1. Product Store是产品事实源。
2. 浏览器不直接调用Vercel Workflow或pi。
3. Vercel Workflow负责耐久执行与Checkpoint。
4. pi作为Workflow中的Agent节点。
5. AG-UI负责Agent交互事件语义，不负责产品资源。
6. Chat拥有公开事件sequence、cursor、终态和重连合同。
7. Product Session、Product Run、Run Attempt、Workflow Run、Checkpoint和pi Session分别建模。
8. HITL先提交产品Decision，再恢复Workflow Hook。
9. 文件、语音、Canvas和通知使用各自适合的传输，不塞进Agent事件流。
10. 前端只投影服务端状态，PWA缓存不成为第二事实源。
11. P1.2 Web静态产物在开发机或CI构建后上传到现有弱服务器；服务器不得安装依赖或编译，发布使用可回滚的原子切换。

## 3. 当前未决定

以下内容不属于本轮前后端技术选型，不得假装已经冻结：

1. B2冻结版本化JSON快照为单机Product Store；后续生产数据库与迁移工具仍未决定。
2. Identity Provider与认证部署方式。
3. 对象存储、向量检索和Memory实现。
4. API、Workflow、Product Store等后端的具体部署拓扑；P1.2只确定Web静态产物部署到现有服务器，具体Origin、路径和私有连接参数仍由部署环境提供。
5. UI组件库、视觉系统和Canvas协作引擎。
6. 语音媒体服务、日历Provider与通知Provider。
7. pi实际运行工件已固定为npm 0.82.1及pnpm SHA-512；未来升级版本仍需合同PR。

这些选择必须服从已冻结状态所有权和前后端合同。

## 4. 当前没有的能力

- 没有SSE Cursor Runtime Journal和AG-UI活动流投影；B2暂用受控Query轮询。
- 没有Memory Adapter、BMAD、经验规则选择、长期Project/Work或上下文包实现。
- 没有外部副作用Tool、多实例数据库、备份恢复和生产部署拓扑。
- 真实百炼付费闭环需要本地`DASHSCOPE_API_KEY`验收；普通CI只跑确定性pi流，不冒充真实Provider。

文档批准不等于软件已经实现；P0骨架也不等于纵向链已经打通。

## 5. 当前禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器保存Workflow Run ID、Hook Token或pi Session ID作为权威恢复身份。
3. 不并行建立AG-UI流、Workflow原始流和pi原始流三套前端通道。
4. 不在第一条纵向链之前预建完整Workflow编辑器、插件平台或多Runtime抽象。
5. 不提交密钥、本地数据库、运行事件、缓存和构建产物。
6. 技术决定只在对应子任务中关闭：P1.1～P1.2不提前安装Workflow/pi，P1.3不反向冻结未来数据库，P1.4不提前接pi，P1.7不夹带Tool能力。

## 6. P1任务状态

| 任务 | 结果 | 状态 |
|---|---|---|
| P1.1 | 响应式Chat工作空间 | 已完成，PR #2合并于`0b24b9f` |
| P1.2 | 可安装PWA与离线边界 | 已完成并合并 |
| B1 | 固定端口调试与严格Trace | 已完成并合并 |
| B2 | JSON Store + Workflow + pi + HITL + Product Commit + 最小前端 | 确定性实现完成；待真实百炼验收 |
| P1.6 | 实时进度与断线续接 | 待开始 |
| 后续 | Memory、BMAD、经验规则、外部Tool | 未开始 |

当前详细执行边界与验收缺口见[B2任务书](./docs/tasks/b2-planning-execution-vertical-slice.md)。
