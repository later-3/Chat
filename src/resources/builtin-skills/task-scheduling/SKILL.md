---
name: task-scheduling
description: 为当前 Friend 管理一次性、周期或可信事件任务；在用户要求提醒、定时工作或调整任务时，使用 Chat 的 task_manage 服务。
---

# Task scheduling

任务定义由 Chat 管理，NanoClaw 只计算调度并可靠提交触发；Pi 在独立工作 Session 执行。任务不会占用用户的每日主聊，不会自动携带主聊全部历史。

先 `list` 查已有定义与修订，避免重复。用户要求今后某时执行才创建任务；现在的一次性工作用 `friend_work`。定时任务不是长期职责规划器，也不是无输入持续运行的模型。

## 创建合同

`create` 需要 `definition`：`name`、`prompt`、`timeZone`（IANA，如 `Asia/Shanghai`）、`schedule`、`missed` 和 `overlap`。

- 一次性：`schedule: {kind:"once", at:"2026-10-01T08:00:00+08:00"}`，根据用户日期调整，必须含时区。
- 周期：`schedule: {kind:"cron", expression:"0 8 * * *"}`；每天早中晚可用 `0 8,14,20 * * *`。时区使用本次明确选择，不能猜 UTC；沿用每日最多 4 次限制。
- 事件：`schedule: {kind:"event", source:"materials"}`，只有已接入的可信服务提交稳定事件 ID 才触发。不能声称创建定义就能自动监听网站或目录。
- `missed`: `skip`（超过 5 分钟跳过，适合时效通知）或 `latest`（只补最近一次）。
- `overlap`: `skip` 或 `queue-one`（前次仍运行时最多等候一次）。

项目上下文由调用 Tool 的当前协作项目自动绑定，无项目时使用 Friend 自身空间；参数不能伪造另一个 Friend 或 Session。跨项目应先明确项目上下文。

任务说明要包含目标、输入位置、产出和完成标准；不要假设能看到主聊未附带的内容。是否写文件或通知用户必须明确，消息投递只在用户已授权的目的地进行。不能以模型输出冒充产物保存或投递成功。

## 管理与验证

`update` 提交完整 `definition`；`pause/resume/cancel/update/run` 带 `taskId` 与读取到的 `expectedRevision`。冲突先重新读取，不能自动覆盖。取消保留历史，无 `delete` 操作。

暂停/取消定义只改变未来触发，已接受执行保留。`cancel-run` 通过 `occurrenceId` 取消某次，已经开始时还需其 `expectedTurnId`。`run` 手动执行一次，暂停的任务也可以试跑；不改变原排期。调用标识由程序产生，模型不要伪造请求身份。

定义已保存、调度已应用、执行完成和渠道已送达分别核对；调度未应用不能宣称会按时执行。失败先看该次执行结果，不能通过重复创建或反复 run 来掩盖错误。迁移包含脚本的旧任务会暂停并说明原因，必须显式改写后才能恢复。
