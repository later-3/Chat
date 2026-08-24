# Chat统一兼容政策

机器政策见[`config/compatibility-policy.json`](../../config/compatibility-policy.json)，公共面基线见
[`config/api-surface.baseline.json`](../../config/api-surface.baseline.json)。本页解释政策，不复制各Store、
Workflow或DTO的当前字段；当前事实仍由政策列出的源码拥有。

## 固定原则

六个兼容域统一执行`read old / write current`：网络合同、Product Store、Bridge State、
Workflow/RunSpec、Direct/Generic Journal、Browser DTO/Event。读取旧代只用于恢复、迁移或显示，不能让
旧代获得当前代没有授予的权限，也不能成为新写格式。

- 同一`schemaVersion` literal不可原地新增必填字段、收窄枚举或改变既有字段语义。
- 新写语义必须新增代际；旧代解析器保留到迁移、恢复和回滚完成门明确允许移除为止。
- 兼容层只翻译旧事实到当前内存模型，不把旧事实原样重新写回，也不绕过当前权限和完整性检查。
- breaking change必须先给出`detect / why / fix / verify / rollback`，并取得用户明确批准；
  [`config/api-breaking-change-waivers.json`](../../config/api-breaking-change-waivers.json)只记录这种批准，
  不允许Agent自行生成豁免。

## 怎样改

先运行`pnpm api-surface:diff`查看当前分支相对main/PR base baseline的可读差异；本地找不到base时才退回
checked-in baseline。兼容新增通过后，审查并运行`pnpm api-surface:update-baseline`。`check`会先要求生成结果
与当前baseline精确一致，再把生成结果与Git base中的baseline做breaking diff，因此不能在同一分支同时改
代码和baseline来绕过删除、必填新增、枚举收窄、错误码变化、响应/公开符号签名变化、同代Schema变化或
导出收缩。Store、Bridge、Workflow或Journal的代际变化还必须在各自事实Owner内保留旧读测试和当前写
测试，不能只更新API Surface文件。

如果确有breaking change，变更说明必须同时回答：怎样检测受影响数据/客户端、为什么必须变、用户怎样
修复、怎样验证、怎样回滚。未取得用户明确批准时停止，不修改冻结合同。
