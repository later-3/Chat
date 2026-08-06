# Chat 项目经验与决策检查

本文件只保留会直接伤害新架构的高价值约束。每次设计、实现或审核前必须检查。

## 1. 不让Runtime拥有产品

Workflow Run、Checkpoint和pi Session能够恢复执行，但不能替代Product Session、Product Run、Approval、Work、Memory和Evidence。

检查：关闭或替换Runtime后，产品历史和长期事实是否仍完整？

## 2. 不把浏览器缓存写成事实源

TanStack Query、AG-UI reducer、IndexedDB和localStorage都只是缓存、草稿或投影。

检查：清空浏览器后，服务端是否能重建用户看到的正式状态？

## 3. 不用一个协议承载所有东西

产品资源使用Query/Command合同；活动Agent交互使用AG-UI兼容事件；媒体和大文件使用专用传输。它们可以共享身份与关联ID，但不能互相冒充。

检查：AG-UI事件是否被错误用作Project、文件或审批的唯一存储？

## 4. 不建立两套竞争实时协议

浏览器只订阅一条Chat有序事件流。Vercel Workflow原始流、pi原始事件和产品变化必须在后端归一化，不分别暴露给前端争夺游标与终态。

检查：一次Run是否只有一个公开sequence、cursor和终态来源？

## 5. Durability不是保存聊天记录

历史恢复、活动流重连、Workflow恢复、HITL恢复、Tool副作用对账和Worker接管是不同保证。

检查：方案是否明确进程退出时保存了什么、没有保存什么、怎样恢复？

## 6. HITL先提交决定，再恢复执行

浏览器不能直接持有或恢复Workflow Hook。用户决定必须先通过服务端身份、权限、revision、Hash和幂等校验，形成产品Decision，再由后端恢复Workflow。

检查：重复点击、旧页面、越权用户和过期决定是否都安全失败？

## 7. Product Session不等于长寿命Workflow

一个Product Session可以包含多个Product Run；一个Interaction可以触发零到多个Run。Workflow Run的生命周期不能反向规定产品会话结构。

检查：Workflow结束、替换或清理后，用户会话是否仍可继续？

## 8. 外部副作用不做盲重试

Provider或Tool请求发出后失联，状态可能是`outcome_unknown`。系统必须查询、对账、补偿或请求人工处置。

检查：普通异常重试是否可能重复扣费、发信、删除或写文件？

## 9. 模型输出只是候选

Agent说“完成了”不改变Work状态；必须经过结构校验、Evidence和产品提交门。

检查：最终状态能否由确定性事实解释，而不是依赖模型自述？

## 10. 先做一条完整纵向链

架构边界完整后，优先实现最小端到端场景，用真实断线、恢复和重复请求验证，再扩展节点类型与可视化工厂。

检查：新抽象是否服务当前纵向链，还是为尚不存在的未来预建平台？
