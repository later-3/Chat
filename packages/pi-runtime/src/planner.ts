import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  EXECUTION_CAPABILITY_MARKDOWN_COMPOSE,
  planContentSchema,
  PLANNER_PROMPT_TEMPLATE_VERSION,
  type PlanContent,
  type PlanningInputDto,
} from "@chat/contracts";
import { runAgentWithTool, type AgentRunResult } from "./agent-runner.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { BailianConfig } from "./config.js";

/**
 * pi Planner（任务书§14.2）。
 *
 * Planner只得到原始User Message、选定上下文引用、上版Plan与本轮Revision
 * Input，并只暴露内部submit_plan_candidate工具。模型输出只是候选；
 * 只有PublishPlanForReview Application用例成功后Plan才可Query。
 */

const submitPlanCandidateParameters = Type.Object({
  objective: Type.String(),
  summary: Type.String(),
  assumptions: Type.Array(
    Type.Object({
      statement: Type.String(),
      source: Type.Union([Type.Literal("user"), Type.Literal("context"), Type.Literal("planner")]),
    }),
  ),
  openQuestions: Type.Array(Type.String()),
  steps: Type.Array(
    Type.Object({
      stepId: Type.String(),
      title: Type.String(),
      purpose: Type.String(),
      dependsOn: Type.Array(Type.String()),
      inputRefs: Type.Array(
        Type.Object({ refId: Type.String(), revision: Type.Number(), sha256: Type.String() }),
      ),
      expectedOutput: Type.String(),
      successCriteria: Type.Array(Type.String()),
      requestedCapabilities: Type.Array(Type.String()),
      risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
    }),
  ),
  completionCriteria: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
});

function createSubmitPlanCandidateTool(): AgentTool {
  return {
    name: "submit_plan_candidate",
    label: "提交计划候选",
    description: "提交一份结构化计划候选。必须且只能调用一次；计划随后由用户审核，审核前不会执行。",
    parameters: submitPlanCandidateParameters,
    execute: async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "计划候选已收到，等待用户审核。" }],
      details: undefined,
      terminate: true,
    }),
  };
}

const PLANNER_SYSTEM_PROMPT = [
  "你是Chat产品的规划节点。你的唯一任务是把用户目标拆解为一份可审核的结构化计划。",
  "规则：",
  "1. 必须通过submit_plan_candidate工具提交恰好一次计划候选，不要用普通文本回答。",
  "2. 计划必须包含：objective、summary、assumptions、openQuestions、steps、completionCriteria、warnings。",
  "3. 每个step包含stepId、title、purpose、dependsOn、inputRefs、expectedOutput、successCriteria、requestedCapabilities、risk。",
  "4. steps按执行顺序排列，dependsOn只能引用排在前面的stepId。",
  "5. 你只能请求markdown_text_compose这一种无外部副作用能力；不得请求Shell、Git、文件、网络、邮件、日历、删除或支付能力。",
  "6. 计划是候选，需要用户审核后才会执行；不要声称已经完成任何工作。",
  "7. successCriteria与completionCriteria必须是可由服务端逐条核对证据的明确陈述。",
].join("\n");

export function buildPlannerUserPrompt(input: PlanningInputDto): string {
  const parts: string[] = [
    `用户原始需求（第${String(input.planRevision)}版规划）：`,
    input.sourceMessageText,
  ];
  if (input.priorPlan !== undefined) {
    parts.push(
      "",
      "上一版计划（已被用户要求修改，请保留合理部分并响应修改意见）：",
      JSON.stringify(input.priorPlan.content),
    );
  }
  if (input.revisionInstruction !== undefined) {
    parts.push("", "用户对本版的修改意见（必须逐条响应）：", input.revisionInstruction);
  }
  parts.push("", "请提交计划候选。");
  return parts.join("\n");
}

export interface RunPiPlannerInput {
  readonly config: BailianConfig;
  readonly planningInput: PlanningInputDto;
  /** 确定性测试注入；生产必须缺省。 */
  readonly streamFnOverride?: StreamFn;
}

/** 缺少API Key时抛出；调用方映射为provider.pre_request.no_api_key，绝不切换假Provider。 */
export class BailianNotReadyError extends Error {
  readonly code = "provider.pre_request.no_api_key";
  constructor() {
    super("DASHSCOPE_API_KEY未配置");
    this.name = "BailianNotReadyError";
  }
}

export async function runPiPlanner(input: RunPiPlannerInput): Promise<AgentRunResult<PlanContent>> {
  if (input.config.apiKey === undefined) throw new BailianNotReadyError();
  const apiKey = input.config.apiKey;
  return runAgentWithTool<PlanContent>({
    apiKey,
    baseUrl: input.config.baseUrl,
    systemPrompt: PLANNER_SYSTEM_PROMPT,
    userPrompt: buildPlannerUserPrompt(input.planningInput),
    tool: createSubmitPlanCandidateTool(),
    parseCandidate: (params) => {
      const parsed = planContentSchema.safeParse(params);
      if (!parsed.success) return { ok: false, errorCode: "schema_invalid" };
      for (const step of parsed.data.steps) {
        for (const capability of step.requestedCapabilities) {
          if (capability !== EXECUTION_CAPABILITY_MARKDOWN_COMPOSE) {
            return { ok: false, errorCode: "capability_violation" };
          }
        }
      }
      return { ok: true, candidate: parsed.data };
    },
    timeoutMs: input.planningInput.limits.timeoutMs,
    ...(input.planningInput.limits.tokenBudget !== undefined
      ? { maxTokens: input.planningInput.limits.tokenBudget }
      : {}),
    ...(input.streamFnOverride !== undefined ? { streamFnOverride: input.streamFnOverride } : {}),
  });
}

export const PLANNER_VERSION = PLANNER_PROMPT_TEMPLATE_VERSION;
