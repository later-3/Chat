# Chat统一兼容政策

机器政策见[`config/compatibility-policy.json`](../../config/compatibility-policy.json)，真实Owner生成的六域
事实见[`config/compatibility-facts.baseline.json`](../../config/compatibility-facts.baseline.json)，公共面基线见
[`config/api-surface.baseline.json`](../../config/api-surface.baseline.json)。Policy只声明规则、Owner root与
源码路由；当前写代、历史可读代、每代canonical hash、旧读/迁移入口和权限边界均从源码生成，不手抄进policy。

## 固定原则

六个兼容域统一执行`read old / write current`：网络合同、Product Store、Bridge State、
Workflow/RunSpec、Direct/Generic Journal、Browser DTO/Event。读取旧代只用于恢复、迁移或显示，不能让
旧代获得当前代没有授予的权限，也不能成为新写格式。

- 同一`schemaVersion` literal不可原地新增必填字段、收窄枚举或改变既有字段语义。
- 新写语义必须新增代际；旧代解析器保留到迁移、恢复和回滚完成门明确允许移除为止。
- 兼容层只翻译旧事实到当前内存模型，不把旧事实原样重新写回，也不绕过当前权限和完整性检查。
- breaking change必须先给出`detect / why / fix / verify / rollback`，并取得用户明确批准；
  [`config/api-breaking-change-waivers.json`](../../config/api-breaking-change-waivers.json)只记录这种批准，
  且逐项绑定issue kind、target、base/current digest与canonical diff hash，不允许Agent自行生成豁免，
  也不能把A→B批准复用于A→C或B→C。

## 怎样改

先运行`pnpm api-surface:diff`查看当前分支相对main/PR base baseline的可读差异；本地找不到base时才退回
checked-in baseline。公共新增还要在
[`config/api-compatible-change-records.json`](../../config/api-compatible-change-records.json)记录purpose、Owner、
before/after digest、diff hash、verification与rollback/removal；一条记录只能消费一次精确扩张。审查后运行
`pnpm api-surface:update-baseline`。`check`会先要求生成结果
与当前baseline精确一致，再把生成结果与Git base中的baseline做breaking diff，因此不能在同一分支同时改
代码和baseline来绕过删除、必填新增、枚举收窄、错误码变化、响应/公开符号签名变化、同代Schema变化或
导出收缩。Store、Bridge、Workflow或Journal的代际变化还必须在各自事实Owner内保留旧读测试和当前写
测试，不能只更新API Surface文件。`pnpm compatibility:facts:generate`确定性输出六域事实，只有审查后的
真实代际变更才运行`pnpm compatibility:facts:update`；`compatibility:check`还会读取PR/push Git base中的
事实baseline，因此同一分支同时修改Owner与baseline仍会失败。README或无关源码不能充当fact source。

如果确有breaking change，变更说明必须同时回答：怎样检测受影响数据/客户端、为什么必须变、用户怎样
修复、怎样验证、怎样回滚。未取得用户明确批准时停止，不修改冻结合同。
