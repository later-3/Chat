import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { planContentSchema, type PlanContent } from "@chat/contracts";
import { AgentSessionPiCodingAgentRunner } from "./coding-agent-executor.js";
import { runPiPlanner } from "./planner.js";

export const DETERMINISTIC_PLANNING_E2E_COMPLETION = "PLANNING_FAUX_E2E_COMPLETED";

const PLAN: PlanContent = planContentSchema.parse({
  objective: "验证确定性Plan审核与恢复",
  summary: "一个步骤完成确定性浏览器纵向",
  assumptions: [],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "生成确定性完成标记",
      purpose: "验证批准后Workflow继续执行并提交正式Assistant",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: DETERMINISTIC_PLANNING_E2E_COMPLETION,
      successCriteria: ["输出唯一确定性完成标记"],
      requestedCapabilities: [],
      risk: "low",
    },
  ],
  completionCriteria: ["正式Assistant包含确定性完成标记"],
  warnings: [],
});

function streamWith(response: ReturnType<typeof fauxAssistantMessage>): StreamFn {
  const faux = fauxProvider({ provider: "bailian" });
  faux.setResponses([response]);
  return (model, context, options) => faux.provider.streamSimple(model, context, options);
}

/** 真实pi Agent loop，只把付费Provider流替换为进程内Faux；生产组合根从不调用。 */
export function createDeterministicPlanningE2EOverrides() {
  return {
    planner: (input: Parameters<typeof runPiPlanner>[0]) =>
      runPiPlanner({
        ...input,
        streamFnOverride: streamWith(
          fauxAssistantMessage(fauxToolCall("submit_plan_candidate", PLAN), {
            responseId: "planning-faux-plan-1",
          }),
        ),
      }),
  };
}

/** 完整Executor仍走真实AgentSession、Operation Journal与Service，只替换模型流。 */
export function createPlanningE2EPiCodingRunner() {
  const faux = fauxProvider({
    api: "faux",
    provider: "dashscope-coding",
    models: [{ id: "qwen3.7-plus", name: "Planning Deterministic Provider" }],
  });
  faux.setResponses([
    async (_context, options, _state, model) => {
      // Faux没有HTTP payload构造阶段；显式走Pi公开onPayload接缝，让真实AgentSession
      // Journal记录provider.started，而不是在测试中旁路或手写Operation事件。
      await options?.onPayload?.({ kind: "planning-faux-e2e", requestIndex: 1 }, model);
      return fauxAssistantMessage(DETERMINISTIC_PLANNING_E2E_COMPLETION, {
        responseId: "planning-faux-executor-1",
      });
    },
  ]);
  return new AgentSessionPiCodingAgentRunner({
    model: { ...faux.getModel(), baseUrl: "https://coding.dashscope.aliyuncs.com" },
    createModelRuntime: async () => {
      const runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      runtime.registerNativeProvider(faux.provider);
      return runtime;
    },
  });
}
