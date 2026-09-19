# Friend 数据升级与恢复

适用于公共 Agent 装配与每日 Session 升级（P1–P5）。单个 Chat Home 仅由一个 Backend 写入；不支持多个 Backend 同时执行迁移。外部渠道实测状态见阶段审计，健康检查不代表 Telegram 已收发成功。

## 升级前

1. 先停止接收新消息，检查并排空执行和投递。现有脚本停止服务不保证业务已排空；不要在模型或工具执行中升级。
2. 按[运行手册](./running.md)停止当前 Chat 与 Nano 服务。完整备份 Chat Home、Nano 原生数据目录和项目配置，保留当前父仓库及 3 个 Submodule Commit。备份含私人历史和凭据，不能提交 Git。
3. 在受限访问的副本上演练，单独设置 `CHAT_HOME`。副本 registry 的路径仍指向原项目：必须改成副本项目路径后再启动；不能把“换了 CHAT_HOME”视为已经隔离所有文件访问。禁止连接正式 Nano Gateway，禁止重放副本中的待投递事件到真实用户。
4. 完成迁移测试及全量 `pnpm verify`；验证产物与原运行服务分开构建。首次真实环境升级需要明确部署授权。

## 自动处理与保留范围

| 对象 | 行为 |
|---|---|
| 内联 definition | 拆分到 `long-agents/<id>/definition.json`；先校验全部定义，同名内容冲突就失败，双方原件保留 |
| state 1–3 | 升级为 schema 4，保留源备份；在 state 写完但完成标记未写时可补标记 |
| 旧 daily / daily-agent | 保留 Registry、Workspace、Session、Project Memory 和配置；仅补新 Home。工作区普通文件可无覆盖复制，`.chat` 仍属原 Project，不自动改变其配置作用域 |
| 旧业务 Friend Session | 保留原项目和原生字节；读模型保留 Friend 归属，只读，不合并到今天 |
| 新每日 Session | 迁移、空闲维护不创建空会话；实际交流按 Friend＋日期唯一定位 |
| 旧渠道绑定 | 保留原 Nano 坐标、目的地与收据；冻结原业务 contextProjectId，旧系统容器转 null；下一次可信来信接入当天 Home Session |
| 已执行 v1 归一迁移 | 从旧备份和仍存在的原生文件恢复精确旧 URL 别名；不重写 header 或把历史拼入新会话 |
| Memory | 不再把旧 Agent/Daily Project Catalog 自动复制到 Personal；Nano Markdown Memory 不迁移、不复制 |

原项目资源仍可在原 Project 中管理；不会因复制 Workspace 普通文件而隐式继承全部旧配置。已被 v1 删除且无独立备份的文件无法凭索引重建；升级前必须核对旧数据完整性，不能声称代码能恢复已丢失内容。

## 迁移记录

均相对 Chat Home：

- `runtime/migrations/long-agent-definition-split/`：首次索引备份与 `done.json`。
- `runtime/migrations/long-agent-daily-v4/`：`source.json` 与 `complete.json`。
- `runtime/migrations/agent-home-normalization/`：v1 备份/`done.json`原样保留；P5 使用首次 `*.v2.bak.json` 和 `done-v2.json`，后者记录旧 Project、Session、当前位置和 Friend 身份。失败不写完成标记，重试不替换原备份。

这些是迁移恢复依据，不是第二份消息事实。消息内容始终来自原生 Pi JSONL。不能手工伪造完成标记跳过校验。

## 冲突与回退

- **文件冲突**：保留两个文件，检查差异，将需要保留的目标文件另存到明确管理的位置后重试；不要直接覆盖或删除原件。非法 JSON、符号链接和读取权限错误会明确失败。
- **旧链接失败**：检查原项目登记、原生文件及精确迁移记录；未知映射不搜索其他 Project，也不自动回退 Home。旧历史只读，点击 Friend 开始当天交流。
- **队列中断**：queued 可按持久输入继续；running 没有可信终态时标记 interrupted。检查已产生的工具副作用后决定新请求，不能删状态让它自动重跑。
- **模型已完成、投递失败**：保留原事件、Delivery 与 Ack，恢复 Nano 后只重试投递；不要重新向模型提交同一用户消息。
- **回退**：仅在新版本尚未接受新工作时，停服务并整体恢复升级前数据副本及对应代码/子模块版本。已有新工作时采用向前修复，先保存全部新历史；禁止只恢复旧 state 而保留新消息，或让旧代码读取未知 schema。

## 验收入口

`test/long-agents/migration.test.mjs` 验证旧数据无损、冲突重试、定义拆分、标记恢复、日历归属与旧链接；`long-agents.test.mjs` 验证接收、执行、Delivery/Ack 与重复事件。浏览器必须另验旧链接刷新、历史只读、返回当天、真实流式内容和正常收尾。P5 证据与未验收项统一记录在阶段审计，模拟 Nano HTTP 不能替代真实 Telegram 回路。
