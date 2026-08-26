# Project Agent统一协作入口 As-built

> 更新日期：2026-08-26

## 1. 用户结果

Codex、Pi Agent和Chat内Agent从同一个Chat Application Query恢复项目开工包，不把当前对话、工作目录或外部页面当作项目事实。普通开工包只包含完成当前协作所需的Chat权威信息：

- 稳定Project解析结果和采用的Profile / Configuration版本；
- 当前Work、候选Work、Claim、Block、Handoff和完成门；
- 当前Agent允许执行的Application动作；
- 按目的和预算编译的Project Context；
- `agent_started`触发得到的Maintenance建议；
- 受管Resource的有界上下文与稳定引用。

外部Provider状态、凭据、同步Operation和入站变化不进入普通Agent上下文；Agent不会因为某个外部系统不可用而失去Chat Project、Work和历史。

## 2. Resolver与协议

Resolver只接受稳定产品身份：`projectId`、`productSessionId`、`workspaceRootId`，至少一个必填。它不接受绝对路径、`cwd`、Git分支、DSH Session或外部Credential。多个身份解析到不同Project时返回冲突，不选择“看起来最像”的对象。

公开入口：

- `GET /api/project-agent/opening-packet`
- `GET /api/project-agent/opening-packet-v3`

查询参数使用strict Schema；当前Application与新调用使用`project-agent-coordination.v3`，其management绑定`project-agent-context.v2`的精确Project目标。v1/v2入口只读保留，DSH可在独立迁移后切换，不原地改变历史合同。普通入口支持项目身份、可选Work/Participant以及是否读取Resource Context，返回值不包含任意Provider专用字段。

## 3. 开工与交接规则

1. Agent开工时先解析Project，再读取采用的Configuration和当前Work；不能靠Session摘要猜测。
2. 没有精确Work且存在多个候选时返回`requiresWorkSelection=true`，由Agent或用户使用受治理Command选择。
3. Claim、进展、阻塞、Evidence、Review和Handoff都通过Application命令写入，使用Command ID与Revision校验。
4. 完成门由当前Profile和Work决定；口头结论、文件存在、外部事项状态都不能单独制造完成。
5. Handoff保留已完成、剩余工作、下一步和Evidence，使不同Agent或新Session可以恢复。

## 4. DSH表面

LifeOS Bridge只以Product Session和受管Workspace Root查询开工包，不传`cwd`。Dock只显示当前Project、Work、候选、阻塞、Resource摘要和下一步，不复制Project管理完整页面，也不暴露路径或Credential。

普通Project视图与开工包复用Chat公开Query；浏览器状态只是投影缓存，刷新后重新读取Application事实。

## 5. 源码与验证

| 责任 | 源码 |
|---|---|
| Opening Packet合同 | `packages/contracts/src/project-agent-coordination.ts` |
| Resolver与Context编译 | `packages/application/src/project-agent-coordination-use-cases.ts` |
| 公开路由 | `apps/api/src/product-routes/project-routes.ts` |
| DSH Client与投影 | `packages/dsh-lifeos-bridge/src/chat-client.ts`、`bridge-service.ts`、`client/LifeosDock.tsx` |
| Application场景测试 | `packages/application/src/project-coordination-use-cases.test.ts` |
| DSH合同测试 | `packages/dsh-lifeos-bridge/tests/chat-client.test.ts`、`lifeos-dock.test.ts` |

已验证Resolver冲突、Work选择、Claim冲突与租约、Block恢复、Handoff接手、完成门、Resource裁剪、Session恢复以及浏览器拿不到绝对路径或Credential。
