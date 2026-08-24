# ADR-0003: API Surface与统一兼容政策

- 状态：accepted
- 日期：2026-08-24
- 适用范围：公开HTTP、Browser合同、workspace package exports及持久代际
- 决策所有者：Later / Chat

## 背景

公开路由、DTO、错误码和package export分散在组合根、合同barrel与package manifest中。手写清单会成为
第二事实源，也无法在重构时稳定识别删除、必填新增或同代语义漂移。

## 决定

[`scripts/ci/api-surface.mjs`](../../scripts/ci/api-surface.mjs)从真实API组合根、
`@chat/contracts/public`和workspace package manifests确定性生成公共面；checked-in baseline只保存生成
结果。路由响应同时记录显式Schema签名或从Application真实返回类型/return路径生成的摘要；CI还把当前生成
结果与PR/push Git base中的baseline比较，不能靠同分支更新baseline绕过breaking diff。私有Runtime路由、
凭据身份、Hook/Workflow/Pi私有ID、Prompt正文和内部路径不进入Manifest。

六类兼容域统一遵守[兼容政策](../architecture/compatibility-policy.md)：read old / write current、同一
schema literal不可原地改变语义、新写语义升代际、旧代只读不扩权。breaking change必须取得用户明确
批准并记录detect/why/fix/verify/rollback；Agent不能自行豁免。

## 后果

路由/导出删除、请求响应合同变化、必填新增、枚举收窄、Problem Code变化与同代Schema变化会在机器门
中失败，并提供可读diff。代价是合法兼容新增也要审查并更新baseline。

## 替代方案

- 手写OpenAPI/接口表：当前代码未以其生成路由，会形成第二事实源，拒绝。
- 只比较文本diff：无法区分公共面与私有实现，拒绝。
- 任意Agent写waiver：绕过用户对breaking change的批准权，拒绝。

## 变更与回滚

兼容新增先运行`pnpm api-surface:diff`并更新baseline。breaking change必须按政策记录五项迁移信息和用户
批准。回滚恢复旧路由/导出与旧读能力，并重新生成相同baseline；不得只删除差异记录。
