import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { EXECUTOR_PROMPT_TEMPLATE_VERSION, type ExecutionContract } from "@chat/contracts";
import { z } from "zod";
import { runAgentWithTool, type AgentRunResult } from "./agent-runner.js";
import { BailianNotReadyError } from "./planner.js";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { BailianConfig } from "./config.js";

/**
 * pi Executor（任务书§14.3）。
 *
 * Executor只得到不可变Execution Contract和当前Approved Step；
 * 第一版Capability仅允许在内存中整理文本并生成Markdown候选，
 * 不开放文件、Shell、Git、网络、邮件、日历或删除能力。
 * Executor不得修改Plan、增加步骤或宣布Product Run成功。
 */

const submitExecutionResultParameters = Type.Object({
  stepId: Type.String(),
  output: Type.String(),
  sections: Type.Array(Type.Object({ heading: Type.String(), body: Type.String() })),
  successCriteriaEvidence: Type.Array(Type.String()),
  criteriaEvidence: Type.Array(Type.String()),
  warnings: Type.Array(Type.String()),
});

function createSubmitExecutionResultTool(): AgentTool {
  return {
    name: "submit_execution_result",
    label: "提交执行结果候选",
    description: "提交当前步骤的执行结果候选。必须且只能调用一次；结果随后由服务端确定性验证。",
    parameters: submitExecutionResultParameters,
    execute: async (_toolCallId: string, _params: unknown) => ({
      content: [{ type: "text", text: "执行结果候选已收到，等待服务端验证。" }],
      details: undefined,
      terminate: true,
    }),
  };
}

/** 每个Executor Step的候选（最终候选由Workflow确定性组装，不新增模型调用）。 */
export const executorStepCandidateSchema = z
  .object({
    stepId: z.string().min(1).max(100),
    output: z.string().min(1).max(50_000),
    sections: z
      .array(
        z
          .object({ heading: z.string().min(1).max(200), body: z.string().min(1).max(50_000) })
          .strict(),
      )
      .max(20),
    successCriteriaEvidence: z.array(z.string().min(1).max(1000)).min(1).max(20),
    criteriaEvidence: z.array(z.string().min(1).max(1000)).max(20),
    warnings: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();

export type ExecutorStepCandidate = z.infer<typeof executorStepCandidateSchema>;

const EXECUTOR_SYSTEM_PROMPT = [
  "你是Chat产品的执行节点。你只能按照已批准的不可变执行合同完成当前这一个步骤。",
  "规则：",
  "1. 必须通过submit_execution_result工具提交恰好一次结果候选，不要用普通文本回答。",
  "2. stepId必须与给你的当前步骤完全一致。",
  "3. output是本步骤的文字产出；sections是最终Markdown文档中由本步骤贡献的小节（heading + body）。",
  "4. successCriteriaEvidence必须逐条引用本步骤successCriteria原文并给出对应证据。",
  "5. criteriaEvidence用于整体完成条件：引用完成条件原文并给出本步骤对它的贡献证据；无关时可以留空数组。",
  "6. 你没有任何外部工具：不能读写文件、执行Shell、访问网络、发邮件、改日历或删除任何内容。",
  "7. 你提交的是候选，服务端会做确定性验证；不要声称整个任务已经完成。",
].join("\n");

export function buildExecutorUserPrompt(contract: ExecutionContract, stepId: string): string {
  const step = contract.steps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) {
    throw new Error(`当前步骤${stepId}不在Execution Contract中`);
  }
  return [
    "整体完成条件（completionCriteria）：",
    JSON.stringify(contract.completionCriteria),
    "",
    `当前步骤（共${String(contract.steps.length)}步，按顺序执行）：`,
    JSON.stringify(step),
    "",
    "请只完成当前步骤并提交结果候选。",
  ].join("\n");
}

export interface RunPiExecutorInput {
  readonly config: BailianConfig;
  readonly contract: ExecutionContract;
  readonly stepId: string;
  /** 确定性测试注入；生产必须缺省。 */
  readonly streamFnOverride?: StreamFn;
}

export async function runPiExecutor(
  input: RunPiExecutorInput,
): Promise<AgentRunResult<ExecutorStepCandidate>> {
  if (input.config.apiKey === undefined) throw new BailianNotReadyError();
  const apiKey = input.config.apiKey;
  const step = input.contract.steps.find((candidate) => candidate.stepId === input.stepId);
  return runAgentWithTool<ExecutorStepCandidate>({
    apiKey,
    baseUrl: input.config.baseUrl,
    systemPrompt: EXECUTOR_SYSTEM_PROMPT,
    userPrompt: buildExecutorUserPrompt(input.contract, input.stepId),
    tool: createSubmitExecutionResultTool(),
    parseCandidate: (params) => {
      const parsed = executorStepCandidateSchema.safeParse(params);
      if (!parsed.success) return { ok: false, errorCode: "schema_invalid" };
      if (step === undefined || parsed.data.stepId !== step.stepId) {
        return { ok: false, errorCode: "schema_invalid" };
      }
      return { ok: true, candidate: parsed.data };
    },
    timeoutMs: input.contract.limits.timeoutMsPerStep,
    ...(input.contract.limits.tokenBudgetPerStep !== undefined
      ? { maxTokens: input.contract.limits.tokenBudgetPerStep }
      : {}),
    ...(input.streamFnOverride !== undefined ? { streamFnOverride: input.streamFnOverride } : {}),
  });
}

export const EXECUTOR_VERSION = EXECUTOR_PROMPT_TEMPLATE_VERSION;
