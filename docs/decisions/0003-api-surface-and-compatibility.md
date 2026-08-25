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
结果。106条路由逐条从`c.req`来源、Query parser/allowed keys与`c.json`/response helper生成
path/query/body、成功响应Schema/表达式/HTTP状态及Problem/Recovery合同；输入Schema位于return表达式也不会
被误判为响应，路由引用但未从public barrel导出的Contracts Schema也按真实声明闭包冻结，无法解析时
失败关闭。公共API只冻结外部可观察合同，不冻结内部Application use-case或调用图；内部Operation替换若
不改变请求、响应、状态和错误合同，不构成API breaking change，其产品行为由Application合同、Integration
和Browser测试负责。Package export冻结key、target、conditions、bin与公共入口符号签名。CI还把当前生成
结果与PR/push Git base中的baseline比较，不能靠同分支更新baseline绕过breaking diff。私有Runtime路由、
凭据身份、Hook/Workflow/Pi私有ID、Prompt正文和内部路径不进入Manifest；禁止身份若从public barrel导出
会硬失败，不会被静默过滤。

六类兼容域统一遵守[兼容政策](../architecture/compatibility-policy.md)：read old / write current、同一
schema literal不可原地改变语义、新写语义升代际、旧代只读不扩权。breaking change必须取得用户明确
批准并以精确before→after digest/diff hash记录detect/why/fix/verify/rollback；Agent不能自行豁免。兼容新增
也必须有一次性的精确change record，不能靠同分支更新baseline绕过。

六域当前/历史代际、canonical hash、旧读/迁移入口和authority boundary由真实Owner源码生成到
`compatibility-facts.baseline.json`；Policy不重复这些事实，CI同时与Git base中的事实baseline比较，不能
用同分支同步更新Owner与baseline绕过兼容门。

## 后果

路由/导出删除、请求响应合同变化、必填新增、枚举收窄、Problem Code变化与同代Schema变化会在机器门
中失败，并提供可读diff。新增路由/导出/符号/Schema/Command/Query/Problem/Recovery缺change record同样失败。
内部Application重构在外部合同稳定时不会产生API兼容噪声。代价是合法兼容新增仍要审查、记录用途与回滚
并更新baseline。

## 替代方案

- 手写OpenAPI/接口表：当前代码未以其生成路由，会形成第二事实源，拒绝。
- 只比较文本diff：无法区分公共面与私有实现，拒绝。
- 任意Agent写waiver：绕过用户对breaking change的批准权，拒绝。

## 变更与回滚

兼容新增先运行`pnpm api-surface:diff`并更新baseline。breaking change必须按政策记录五项迁移信息和用户
批准。回滚恢复旧路由/导出与旧读能力，并重新生成相同baseline；不得只删除差异记录。
