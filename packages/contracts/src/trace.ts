/**
 * 结构化Trace合同（任务书§7）。
 *
 * 职责边界：
 * - Trace记录系统边界、状态转换、调用关系、错误、耗时与统计；
 * - 用户正文、Plan正文、模型候选正文、Prompt、Provider请求/响应正文只保存在
 *   Product Store，Trace通过`对象ID + revision + sha256`引用它们；Pi工具调用/结果
 *   例外地保存Executor边界前已脱敏且有界的可观察显示证据；
 * - Trace不是第二份产品事实源，永远不保存模型隐藏推理；
 * - 合同是以eventName为判别字段的严格联合：未声明字段（含body/content/
 *   message/prompt/payload等任意正文入口）在根部与嵌套层都失败关闭，
 *   不存在Record<string, unknown>形式的内容通道。
 *
 * 关联与统计保证（回放可信的前提）：
 * - Product Run事件必须有productRunId；
 * - Workflow/Provider/pi/执行/Product Commit事件必须有productRunId + attemptId；
 * - Workflow事件必须绑定workflowDefinitionVersion；
 * - Provider/pi事件必须绑定promptTemplateVersion + modelConfigVersion；
 * - Provider completed/failed必须有durationMs；started/completed必须有输入manifest Hash，
 *   failed只在预请求失败（provider.pre_request.*错误族）时允许缺失manifest；
 * - outcome按事件名固定：started/received/waiting=unknown，
 *   completed/committed/validated及事实断言类=success，rejected=rejected，failed=failure。
 *
 * 实现拆分：基础件在trace/foundations.ts，事件族在trace/events-*.ts，
 * 严格联合在trace/union.ts；本文件保持原公开面不变的barrel。
 */
export {
  TRACE_SCHEMA_VERSION,
  traceLevelSchema,
  type TraceLevel,
  traceOutcomeSchema,
  type TraceOutcome,
  TRACE_EVENT_NAMES,
  stableErrorCodeSchema,
  PROVIDER_PRE_REQUEST_ERROR_PREFIX,
  traceErrorSchema,
  type TraceError,
  messageRefSchema,
  planRefSchema,
  decisionRefSchema,
  executionContractRefSchema,
  executionCandidateRefSchema,
  contextPackageRefSchema,
  artifactRefSchema,
  traceObjectRefSchema,
  type TraceObjectRef,
} from "./trace/foundations.js";
export { providerStopReasonSchema } from "./trace/events-provider.js";
export { traceEventSchema, type TraceEvent, type TraceEventInput } from "./trace/union.js";
export { sha256Schema } from "./hash.js";
