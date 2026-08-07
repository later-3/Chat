/**
 * B2版本证据常量。
 *
 * Workflow Definition、Prompt模板与模型配置版本必须进入Trace与回放证据；
 * 既有Run固定原Definition语义，新部署只影响新Run。
 */

export const WORKFLOW_DEFINITION_ID = "wfd_planning_execution";
export const WORKFLOW_DEFINITION_VERSION = "planning-execution-workflow.v1";

export const PLANNER_PROMPT_TEMPLATE_VERSION = "planner-prompt.v1";
export const EXECUTOR_PROMPT_TEMPLATE_VERSION = "executor-prompt.v1";
export const MODEL_CONFIG_VERSION = "bailian.qwen3.7-plus.v1";

/** Provider与模型冻结（任务书§14）：变更需合同PR。 */
export const PROVIDER_NAME = "bailian";
export const PROVIDER_MODEL = "qwen3.7-plus";
export const BAILIAN_DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/** 第一版Execution Contract允许的唯一无外部副作用Capability。 */
export const EXECUTION_CAPABILITY_MARKDOWN_COMPOSE = "markdown_text_compose";

/** B2费用/时延硬边界：一次Run最多5次Planner + 8次Executor真实调用。 */
export const B2_MAX_PLAN_STEPS = 8;
export const B2_PLANNER_TOKEN_BUDGET = 4_096;
export const B2_EXECUTOR_TOKEN_BUDGET_PER_STEP = 2_048;
