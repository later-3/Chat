/**
 * 工作流 id 常量（**无依赖**模块）。
 *
 * 放在这里是为了避免循环依赖：`registry` 会 import 各工作流定义，而工作流定义又 import
 * 存储/配置层（`agent-model-config`、`long-agents/storage`），它们都需要知道默认工作流 id。
 */
/** 默认工作流（= 连续会话）：**不定义 Agent**，执行主体是本轮 Long Agent。 */
export const DEFAULT_CHAT_WORKFLOW_ID = "chat-direct";
