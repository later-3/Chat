/**
 * B2版本证据常量。
 *
 * Workflow Definition、Prompt模板与模型配置版本必须进入Trace与回放证据；
 * 既有Run固定原Definition语义，新部署只影响新Run。
 */

export const WORKFLOW_DEFINITION_ID = "wfd_planningexecution";
export const WORKFLOW_DEFINITION_VERSION = "planning-execution-workflow.v3";
export const MEMORY_IMPORT_WORKFLOW_DEFINITION_VERSION = "memory-import-workflow.v1";
export const MEMORY_WRITE_WORKFLOW_DEFINITION_VERSION = "memory-write-workflow.v1";

export const PLANNER_PROMPT_TEMPLATE_VERSION = "planner-prompt.v3";
export const EXECUTOR_PROMPT_TEMPLATE_VERSION = "executor-coding-agent-prompt.v1";
export const MODEL_CONFIG_VERSION = "bailian.qwen3.7-plus.v1";

/** Provider与模型冻结（任务书§14）：变更需合同PR。 */
export const PROVIDER_NAME = "bailian";
export const PROVIDER_MODEL = "qwen3.7-plus";
export const BAILIAN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * Execution Contract中的能力是工具白名单，不是模型自授权。
 * `workspace_*`与`shell_execute`只有在Plan明确请求、用户批准且Contract绑定了
 * Workspace Root时才会映射成Pi工具；Executor Service仍在每次工具调用前落盘意图。
 */
export const EXECUTION_CAPABILITY_MARKDOWN_COMPOSE = "markdown_text_compose";
export const EXECUTION_CAPABILITY_WORKSPACE_READ = "workspace_read";
export const EXECUTION_CAPABILITY_WORKSPACE_WRITE = "workspace_write";
export const EXECUTION_CAPABILITY_SHELL_EXECUTE = "shell_execute";

export const EXECUTION_CAPABILITIES = [
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  EXECUTION_CAPABILITY_WORKSPACE_READ,
  EXECUTION_CAPABILITY_WORKSPACE_WRITE,
  EXECUTION_CAPABILITY_SHELL_EXECUTE,
] as const;

/** B2费用/时延硬边界：一次Run最多5次Planner + 8次Executor真实调用。 */
export const B2_MAX_PLAN_STEPS = 8;
export const B2_PLANNER_TOKEN_BUDGET = 4_096;
export const B2_EXECUTOR_TOKEN_BUDGET_PER_STEP = 2_048;

/** 完整Coding Agent允许多轮Tool loop；费用和时延仍由不可变Execution Contract冻结。 */
export const CODING_EXECUTOR_MAX_TURNS_PER_STEP = 24;
export const CODING_EXECUTOR_TIMEOUT_MS_PER_STEP = 20 * 60_000;
export const CODING_EXECUTOR_TOKEN_BUDGET_PER_STEP = 64_000;
