import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  projectAdvancementUnderstandingSchema,
  type ProjectAdvancementUnderstanding,
} from "@chat/contracts";
import { runAgentWithTool } from "./agent-runner.js";
import { BailianNotReadyError } from "./planner.js";
import { buildProjectModel, type ProjectModelProfile } from "./project-model-profile.js";

const parameters = Type.Object({
  stage: Type.Object({
    name: Type.String(),
    goal: Type.String(),
    successCriteria: Type.Array(Type.String()),
  }),
  milestones: Type.Array(
    Type.Object({
      outcome: Type.String(),
      acceptanceCriteria: Type.Array(Type.String()),
      targetAt: Type.Optional(Type.String()),
    }),
  ),
  update: Type.Object({
    health: Type.Union([
      Type.Literal("on_track"),
      Type.Literal("at_risk"),
      Type.Literal("off_track"),
      Type.Literal("unknown"),
    ]),
    narrative: Type.String(),
    observedChanges: Type.Array(Type.String()),
    blockers: Type.Array(Type.String()),
    nextFocus: Type.Array(Type.String()),
  }),
});

const tool: AgentTool = {
  name: "submit_project_advancement_understanding",
  label: "提交项目推进理解结果",
  description: "提取阶段目标、关键结果和负责人更新草稿，不提交任何项目事实。",
  parameters,
  execute: async () => ({
    content: [{ type: "text", text: "项目推进理解结果已接收。" }],
    details: undefined,
    terminate: true,
  }),
};

const systemPrompt = [
  "你是Chat的项目推进自然语言理解节点，不是项目事实所有者。",
  "必须且只能调用submit_project_advancement_understanding一次，不要输出普通文本。",
  "结合用户输入和当前Stage摘要，提取用户希望采用的Stage名称、目标、成功标准、Milestone与Project Update草稿。",
  "不要虚构完成、测试、部署、贡献、文件变化或健康结论；信息不足时health使用unknown。",
  "Milestone只保留可验证关键结果，最多8项；普通待办不要冒充Milestone。",
  "Project Update是候选草稿：narrative说明当前判断，observedChanges只写用户明确提到的变化，blockers与nextFocus使用短句。",
  "targetAt只有用户给出可确定日期时才填写ISO 8601；不要猜日期。",
].join("\n");

export const PROJECT_ADVANCEMENT_PROMPT_TEMPLATE_VERSION = "project-advancement-understanding.v1";

export class PiProjectAdvancementUnderstandingAdapter {
  constructor(private readonly profile: ProjectModelProfile) {}

  describe() {
    return {
      profileVersion: this.profile.profileVersion,
      providerName: this.profile.providerName,
      modelId: this.profile.modelId,
      promptTemplateVersion: PROJECT_ADVANCEMENT_PROMPT_TEMPLATE_VERSION,
      endpointHost: this.profile.endpointHost,
    };
  }

  async understand(input: {
    readonly text: string;
    readonly projectName: string;
    readonly currentStage: {
      readonly name: string;
      readonly goal: string;
      readonly successCriteria: readonly string[];
    };
  }): Promise<{
    understanding: ProjectAdvancementUnderstanding;
    evidence: {
      durationMs: number;
      providerRequestId?: string;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
  }> {
    if (this.profile.apiKey === undefined) throw new BailianNotReadyError();
    const result = await runAgentWithTool<ProjectAdvancementUnderstanding>({
      apiKey: this.profile.apiKey,
      baseUrl: this.profile.baseUrl,
      model: buildProjectModel(this.profile),
      systemPrompt,
      userPrompt: [
        `项目：${input.projectName}`,
        `当前Stage：${input.currentStage.name}`,
        `当前Stage目标：${input.currentStage.goal}`,
        `当前成功标准：${input.currentStage.successCriteria.join("；")}`,
        "用户推进描述：",
        input.text,
        "请提交项目推进理解结果。",
      ].join("\n"),
      tool,
      parseCandidate: (params) => {
        const parsed = projectAdvancementUnderstandingSchema.safeParse(params);
        return parsed.success
          ? { ok: true, candidate: parsed.data }
          : {
              ok: false,
              errorCode: "schema_invalid",
              diagnostics: {
                fields: parsed.error.issues.map((issue) => issue.path.join(".")).filter(Boolean),
                issueCodes: parsed.error.issues.map((issue) => issue.code),
              },
            };
      },
      timeoutMs: 90_000,
      maxTurns: 1,
      maxProviderRequests: 1,
      maxTokens: 2_048,
    });
    if (result.kind === "candidate") {
      return {
        understanding: result.candidate,
        evidence: {
          durationMs: result.durationMs,
          ...(result.providerMeta.providerRequestId !== undefined
            ? { providerRequestId: result.providerMeta.providerRequestId }
            : {}),
          ...(result.usage !== undefined
            ? {
                tokenUsage: {
                  promptTokens: result.usage.inputTokens,
                  completionTokens: result.usage.outputTokens,
                  totalTokens: result.usage.inputTokens + result.usage.outputTokens,
                },
              }
            : {}),
        },
      };
    }
    if (result.kind === "provider_failed") {
      const error = new Error("Project Advancement Provider调用失败");
      Object.assign(error, { code: result.errorCode });
      throw error;
    }
    const error = new Error("Project Advancement理解结果不符合合同");
    Object.assign(error, { code: "model_candidate_invalid" });
    throw error;
  }
}
