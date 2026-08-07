import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  B2_PLANNER_TOKEN_BUDGET,
  type ExecutionContract,
  type PlanningInputDto,
} from "@chat/contracts";
import { runPiPlanner, BailianNotReadyError } from "./planner.js";
import { runPiExecutor } from "./executor.js";
import { classifyProviderError } from "./errors.js";
import { loadBailianConfig, isBailianReady, BailianConfigError } from "./config.js";

/**
 * pi Adapter确定性测试：真实pi Agent loop + faux流。
 * 这些测试证明Adapter经过pi的工具校验、执行与终止语义；
 * 不证明真实百炼接入（真实Provider门由pnpm test:provider:bailian负责）。
 */

const config = {
  apiKey: "test-key",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  endpointHost: "dashscope.aliyuncs.com",
};

const planningInput: PlanningInputDto = {
  schemaVersion: "chat-internal-runtime.v1",
  productRunId: "run_1" as PlanningInputDto["productRunId"],
  attemptId: "att_1" as PlanningInputDto["attemptId"],
  inputRunRevision: 2,
  inputManifestSha256: "c".repeat(64),
  sourceMessageRef: { messageId: "msg_1" as never, sha256: "a".repeat(64) },
  sourceMessageText: "根据我的项目进展生成一份包含风险与下一步的Markdown周报",
  planRevision: 1,
  limits: { maxTurns: 1, timeoutMs: 10_000, tokenBudget: B2_PLANNER_TOKEN_BUDGET },
  promptTemplateVersion: "planner-prompt.v1",
  modelConfigVersion: "bailian.qwen3.7-plus.v1",
};

const validPlanParams = {
  objective: "整理项目进展并生成Markdown周报",
  summary: "先归纳进展，再生成周报",
  assumptions: [{ statement: "输入包含本周进展", source: "user" }],
  openQuestions: [],
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      requestedCapabilities: ["markdown_text_compose"],
      risk: "low",
    },
    {
      stepId: "step-2",
      title: "生成周报",
      purpose: "产出Markdown周报",
      dependsOn: ["step-1"],
      inputRefs: [],
      expectedOutput: "Markdown周报",
      successCriteria: ["包含风险与下一步"],
      requestedCapabilities: [],
      risk: "medium",
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  warnings: [],
};

function fauxStreamFn(
  steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
): StreamFn {
  const faux = fauxProvider({ provider: "bailian" });
  faux.setResponses(steps);
  return (model, context, options) => faux.provider.streamSimple(model, context, options);
}

describe("runPiPlanner（真实pi Agent loop + faux流）", () => {
  it("模型调用一次submit_plan_candidate且Schema合法时产生候选", async () => {
    let providerRequestStarts = 0;
    const result = await runPiPlanner({
      config,
      planningInput,
      onProviderRequestStart: () => {
        providerRequestStarts += 1;
      },
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([fauxToolCall("submit_plan_candidate", validPlanParams)]),
      ]),
    });
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.objective).toBe("整理项目进展并生成Markdown周报");
      expect(result.candidate.steps).toHaveLength(2);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.providerCallCount).toBe(1);
    }
    expect(providerRequestStarts).toBe(1);
  });

  it("模型不调用工具时返回no_tool_call，不发布候选", async () => {
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([fauxAssistantMessage([fauxText("我直接回答，不调用工具")])]),
    });
    expect(result.kind).toBe("invalid_candidate");
    if (result.kind === "invalid_candidate") expect(result.errorCode).toBe("no_tool_call");
  });

  it("TypeBox通过但Chat Schema非法（空steps）时返回schema_invalid", async () => {
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_plan_candidate", { ...validPlanParams, steps: [] }),
        ]),
      ]),
    });
    expect(result.kind).toBe("invalid_candidate");
    if (result.kind === "invalid_candidate") expect(result.errorCode).toBe("schema_invalid");
  });

  it("请求越权Capability时返回capability_violation", async () => {
    const broken = {
      ...validPlanParams,
      steps: [{ ...validPlanParams.steps[0], requestedCapabilities: ["shell_exec"] }],
    };
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([fauxToolCall("submit_plan_candidate", broken)]),
      ]),
    });
    expect(result.kind).toBe("invalid_candidate");
    if (result.kind === "invalid_candidate") expect(result.errorCode).toBe("capability_violation");
  });

  it("一条消息内多次合法调用返回multiple_tool_calls", async () => {
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_plan_candidate", validPlanParams),
          fauxToolCall("submit_plan_candidate", validPlanParams),
        ]),
      ]),
    });
    expect(result.kind).toBe("invalid_candidate");
    if (result.kind === "invalid_candidate") expect(result.errorCode).toBe("multiple_tool_calls");
  });

  it("Provider认证失败映射为provider.auth_failed", async () => {
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "401 Unauthorized: invalid api key",
        }),
      ]),
    });
    expect(result.kind).toBe("provider_failed");
    if (result.kind === "provider_failed") expect(result.errorCode).toBe("provider.auth_failed");
  });

  it("即使带完整工具参数，length截断也不得接纳候选", async () => {
    const result = await runPiPlanner({
      config,
      planningInput,
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([fauxToolCall("submit_plan_candidate", validPlanParams)], {
          stopReason: "length",
        }),
      ]),
    });
    expect(result.kind).toBe("provider_failed");
    if (result.kind === "provider_failed") {
      expect(result.errorCode).toBe("provider.stream_interrupted");
    }
  });

  it("在非付费流上冻结百炼模型与单次请求Payload选项，并只采集真实响应证据", async () => {
    const faux = fauxProvider({ provider: "bailian" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_plan_candidate", validPlanParams)]),
    ]);
    let captured:
      | {
          model: Parameters<StreamFn>[0];
          options: Parameters<StreamFn>[2];
        }
      | undefined;
    const streamFn: StreamFn = async (model, context, options) => {
      captured = { model, options };
      await options?.onResponse?.(
        {
          status: 201,
          headers: { "X-DashScope-Request-Id": "dashscope-req-123" },
        },
        model,
      );
      const fauxOptions = { ...options };
      delete fauxOptions.onResponse;
      return faux.provider.streamSimple(model, context, fauxOptions);
    };

    const result = await runPiPlanner({ config, planningInput, streamFnOverride: streamFn });
    expect(result.kind).toBe("candidate");
    expect(result.providerCallCount).toBe(1);
    expect(result.providerMeta).toEqual({
      httpStatus: 201,
      providerRequestId: "dashscope-req-123",
      providerStopReason: "stop",
      toolCallCount: 1,
    });
    expect(captured?.model).toMatchObject({
      id: "qwen3.7-plus",
      provider: "bailian",
      api: "openai-completions",
      baseUrl: config.baseUrl,
      reasoning: false,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_tokens",
        supportsStrictMode: false,
      },
    });
    expect(captured?.options).toMatchObject({
      apiKey: "test-key",
      maxTokens: B2_PLANNER_TOKEN_BUDGET,
      temperature: 0,
      timeoutMs: 10_000,
      maxRetries: 0,
      maxRetryDelayMs: 0,
      cacheRetention: "none",
    });
  });

  it("响应头没有请求ID时使用Provider响应ID作为真实关联证据", async () => {
    const faux = fauxProvider({ provider: "bailian" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit_plan_candidate", validPlanParams)], {
        responseId: "chatcmpl-response-123",
      }),
    ]);
    const streamFn: StreamFn = async (model, context, options) => {
      await options?.onResponse?.({ status: 200, headers: {} }, model);
      const fauxOptions = { ...options };
      delete fauxOptions.onResponse;
      return faux.provider.streamSimple(model, context, fauxOptions);
    };

    const result = await runPiPlanner({ config, planningInput, streamFnOverride: streamFn });
    expect(result.kind).toBe("candidate");
    expect(result.providerMeta).toEqual({
      httpStatus: 200,
      providerRequestId: "chatcmpl-response-123",
      providerStopReason: "stop",
      toolCallCount: 1,
    });
  });

  it("第二次Provider请求在发出前被硬门终止", async () => {
    const faux = fauxProvider({ provider: "bailian" });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("unknown_tool", {})]),
      fauxAssistantMessage([fauxToolCall("submit_plan_candidate", validPlanParams)]),
    ]);
    let dispatched = 0;
    let providerRequestStarts = 0;
    const result = await runPiPlanner({
      config,
      planningInput,
      onProviderRequestStart: () => {
        providerRequestStarts += 1;
      },
      streamFnOverride: (model, context, options) => {
        dispatched += 1;
        return faux.provider.streamSimple(model, context, options);
      },
    });
    expect(result).toMatchObject({
      kind: "provider_failed",
      errorCode: "provider.request_failed",
      providerCallCount: 1,
    });
    expect(dispatched).toBe(1);
    expect(providerRequestStarts).toBe(1);
  });

  it("缺少API Key时失败关闭，不发起任何调用", async () => {
    let providerRequestStarts = 0;
    await expect(
      runPiPlanner({
        config: { ...config, apiKey: undefined },
        planningInput,
        onProviderRequestStart: () => {
          providerRequestStarts += 1;
        },
      }),
    ).rejects.toBeInstanceOf(BailianNotReadyError);
    expect(providerRequestStarts).toBe(0);
  });
});

const contract: ExecutionContract = {
  schemaVersion: "execution-contract.v1",
  executionContractId: "exc_1" as never,
  productRunId: "run_1" as never,
  approvedPlanId: "pln_1" as never,
  approvedPlanRevision: 1,
  approvedPlanSha256: "b".repeat(64),
  approvalDecisionId: "dec_1" as never,
  steps: [
    {
      stepId: "step-1",
      title: "整理进展",
      purpose: "结构化原始输入",
      dependsOn: [],
      inputRefs: [],
      expectedOutput: "要点清单",
      successCriteria: ["覆盖全部输入要点"],
      capabilityRefs: ["markdown_text_compose"],
    },
  ],
  completionCriteria: ["周报包含风险与下一步"],
  capabilityRefs: ["markdown_text_compose"],
  limits: {
    maxTurnsPerStep: 1,
    timeoutMsPerStep: 10_000,
    tokenBudgetPerStep: B2_EXECUTOR_TOKEN_BUDGET_PER_STEP,
  },
  sha256: "c".repeat(64),
  revision: 1,
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
};

describe("runPiExecutor（真实pi Agent loop + faux流）", () => {
  it("返回当前步骤的结构化候选", async () => {
    const result = await runPiExecutor({
      config,
      contract,
      stepId: "step-1",
      dependencyResults: [],
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_execution_result", {
            stepId: "step-1",
            output: "要点清单：A完成，B进行中",
            sections: [{ heading: "本周进展", body: "- A完成\n- B进行中" }],
            successCriteriaEvidence: ["覆盖全部输入要点：已覆盖A与B两个要点"],
            criteriaEvidence: ["周报包含风险与下一步：本周进展小节为风险分析提供输入"],
            warnings: [],
          }),
        ]),
      ]),
    });
    expect(result.kind).toBe("candidate");
    if (result.kind === "candidate") {
      expect(result.candidate.stepId).toBe("step-1");
      expect(result.candidate.sections).toHaveLength(1);
    }
  });

  it("stepId与当前步骤不一致时返回schema_invalid", async () => {
    const result = await runPiExecutor({
      config,
      contract,
      stepId: "step-1",
      dependencyResults: [],
      streamFnOverride: fauxStreamFn([
        fauxAssistantMessage([
          fauxToolCall("submit_execution_result", {
            stepId: "step-99",
            output: "x",
            sections: [],
            successCriteriaEvidence: ["y"],
            criteriaEvidence: [],
            warnings: [],
          }),
        ]),
      ]),
    });
    expect(result.kind).toBe("invalid_candidate");
    if (result.kind === "invalid_candidate") expect(result.errorCode).toBe("schema_invalid");
  });
});

describe("Provider配置与错误归一化", () => {
  it("Base URL必须是HTTPS且符合百炼域名合同", () => {
    expect(() =>
      loadBailianConfig({ DASHSCOPE_BASE_URL: "http://dashscope.aliyuncs.com/v1" }),
    ).toThrow(BailianConfigError);
    expect(() => loadBailianConfig({ DASHSCOPE_BASE_URL: "https://api.openai.com/v1" })).toThrow(
      BailianConfigError,
    );
    const ok = loadBailianConfig({ DASHSCOPE_API_KEY: "k" });
    expect(ok.endpointHost).toBe("dashscope.aliyuncs.com");
    expect(isBailianReady(ok)).toBe(true);
    expect(isBailianReady(loadBailianConfig({}))).toBe(false);
  });

  it("错误特征映射到稳定错误族", () => {
    expect(classifyProviderError("401 Unauthorized")).toBe("provider.auth_failed");
    expect(classifyProviderError("429 Too Many Requests")).toBe("provider.rate_limited");
    expect(classifyProviderError("request timed out after 30s")).toBe("provider.timeout");
    expect(classifyProviderError("socket hang up, stream terminated")).toBe(
      "provider.stream_interrupted",
    );
    expect(classifyProviderError("something else")).toBe("provider.request_failed");
  });
});
