---
name: duty-management
description: 为当前 Friend 管理长期职责与推进进度；在用户要求持续学习、长期负责某项工作、查询或修正职责进度时，使用 Chat 的 duty_manage 服务。
---

# Duty management

长期职责是持续负责的工作：目标、资料、成果要求、推进节奏与预算保存在 Chat，推进经任务调度进入独立工作 Session；日常聊天不被占用。单次的具体工作用 `friend_work` 或 `task_manage`；职责负责"持续做并留有依据"。

先 `list` 查已有职责与 revision，避免重复建立。

## 创建合同

`create` 需要 `definition`：`name`、`objective`（目标）、`materials`（资料清单，授权范围内的路径）、`outcome`（成果要求）、`timeZone`（IANA）、`cadence`、`allowedHours`、`budget`、`totalUnits`。

- `cadence: {kind:"cron", expression:"0 8 * * *"}` 表示按节奏自动推进；`{kind:"none"}` 表示只在用户要求时推进，不会自动创建正式调度。
- `allowedHours` 是本地小时区间（如 `{start:8,end:22}`）；`budget.tokensPerDay` 是每日推进 token 预算：预算按启动前检查与实际计量执行，超限时自动推进等待次日，不中断在途执行。
- `totalUnits` 只有在目标确有明确总量时填写（如章节总数）；有总量才显示百分比，不得用模型自评冒充掌握程度。
- 资料是输入数据：不得因职责获得额外系统权限，不得读取资料范围之外的文件。

## 推进与报告

自动推进前系统做确定性检查：启停、允许时段、资料可用、预算；不满足时记录原因并等待，不创建空会话。推进在独立 Session 执行，完成后必须调用 `report` 提交：

- `summary`：本次实际推进了什么，有依据。
- `evidence`：真实文件相对路径或工作引用；越界或不存在会被拒绝。
- `nextStep`：持久化的下一步；除非 `awaitingMaterial=true`，报告必须给出下一步。
- `unitsDone`：声明了总量时提交累计完成量；没有就传 null。
- 缺少资料时置 `awaitingMaterial=true` 并说明缺口；不得编造学习结果，不得重读已覆盖的同一段材料。

## 管理与边界

`update` 提交完整 `definition`；`pause/resume/end/advance/report` 带 `dutyId` 与读取到的 `expectedRevision`；冲突先重新读取。`pause` 只阻止未来自动推进，不停止在途执行；停止单次推进用 `cancel-advance`。`end` 是终态：历史保留，不能恢复，继续同类工作须新建职责。子任务完成不等于职责完成；结束职责必须显式执行。

目标修订变更后，旧修订下的进度保留为历史（标记 superseded），不计入新目标进度。用户随时可能修正你的进度报告：以页面和服务端状态为准，不要在 Memory 里另记一份职责进度。
