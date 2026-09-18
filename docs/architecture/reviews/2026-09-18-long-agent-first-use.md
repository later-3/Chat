# Long Agent 首次启用与创建

## 场景与机制

用户在全新 Chat Home、尚未选择 Project 时启用长期同事，获得一个 Nexus 并能打开日常会话；之后新增第二个同事，保持配置、Workspace、Session 与 Memory 隔离。复用现有生命周期服务、Agent home、公共 Pi 装配及单 NanoClaw Host。

现有缺口是侧栏依赖 Project、表单要求手填预建 Group、后端缺少 Group 创建桥接。此变更补全管理入口，不引入另一套 Runtime 或全局启停系统。

## 合同与恢复

- Web `enable` 是用户显式创建动作，不在启动或 GET 时自动创建；已有同事时返回原记录，不复活归档身份。新增同事与管理 Tool 共用 `createLongAgent()`。
- Backend 从既有 Registry 选择实例；仅新环境可使用部署环境的 Gateway URL（缺省本机3000、实例local），先验证带认证的健康响应。模型来自 Chat，Channel 绑定可后补。
- NanoClaw 增加带服务认证的 `v1/agent-groups/provision` 窄合同：schemaVersion、requestId、name。requestId 为 Backend 持久化的 UUID，确定 Group ID 与专用目录；复用原生 `initGroupFilesystem()` 和现有 Memory scaffold。只支持 chat-pi；不代理 CLI Socket、不接收文件路径或模型配置。
- Backend 原子保存初始化记录，失败重试复用 Group；home 可用后才登记 Agent。跨文件/HTTP 部分失败保留可恢复的初始化文件与未绑定 Group，不能承诺远端磁盘事务回滚。重复请求不覆盖 Memory；删除后显式重建使用新 Group，拒绝采用无归属的旧目录。
- 现有显式 Group 绑定 API 保持兼容。创建 ID 与已有业务 Project 冲突时拒绝，不能重定位用户项目。

## 验证范围

门禁覆盖空环境首次启用、重复/并发提交、响应丢失后的身份复用、两个同事的独立 home、归档不复活、删除后不继承旧 Memory，以及 NanoClaw 原生 scaffold 与孤立目录拒绝。浏览器验证空状态、创建、刷新、无 Project 对话入口；双方真实 HTTP 合同和本地假模型用于验证默认助手可实际交互。执行结果以本次交付记录为准，不用文档存在代替运行证据。

## 架构核对与实测记录（2026-09-18）

变更属于现有 Long Agent 生命周期管理入口补全。Web、HTTP API 与管理 Tool 复用 Backend 生命周期服务；Backend 经带认证的 NanoClaw 管理接口创建 Group，未读取 NanoClaw 数据库或接入 CLI Socket；对话继续复用公共 Pi 装配。无需架构红线例外。

在隔离 Chat Home 中，用浏览器创建 Nexus 和第二个 Coder，刷新后分别打开日常会话；两个助手均通过各自 Long Agent 消息 API 收到本地测试模型回复。检查原生 Session 文件确认各自保留自己的消息且不串入另一助手的提示词。此验证使用实际 NanoClaw Gateway handler、原生数据库和目录初始化，以及 Chat 生产构建；未启动完整 NanoClaw Host 调度循环，未验证外部模型或 IM 投递。默认任务初始化在该最小 Gateway 环境中不可用，不影响创建与对话验证。

浏览器检查覆盖 390、768、1024 像素宽度、浅色/深色、创建失败保留草稿、无横向溢出和移动端输入/按钮可用性。首次 Project 发现不再关闭已打开的长期同事面板。

最终代码在隔离 checkout 完整通过 `pnpm verify`：27 项 tooling、298 项 Backend、131 项 Frontend、29 项生产构建测试和 1 项真实 Nitro dev Workflow/Pi/本地模型测试，类型检查与生产构建均通过。NanoClaw 类型检查、构建和全量 216 个测试文件 / 2382 项测试通过，修改的 TypeScript 文件格式检查通过；三个仓库 `git diff --check` 均通过。未替换本机运行服务的构建产物，未部署。
