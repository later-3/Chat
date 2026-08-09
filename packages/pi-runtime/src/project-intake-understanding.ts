import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { projectIntakeUnderstandingSchema, type ProjectIntakeUnderstanding } from "@chat/contracts";
import { runAgentWithTool } from "./agent-runner.js";
import { BailianNotReadyError } from "./planner.js";
import { buildProjectModel, type ProjectModelProfile } from "./project-model-profile.js";

const parameters = Type.Object({
  name: Type.String(),
  goal: Type.String(),
  summary: Type.String(),
  scopeHints: Type.Array(Type.String()),
  successCriteriaHints: Type.Array(Type.String()),
  initialWorkHints: Type.Array(Type.String()),
  openQuestions: Type.Array(Type.String()),
});

const tool: AgentTool = {
  name: "submit_project_intake_understanding",
  label: "提交建项理解结果",
  description: "只提取用户明确表达的项目目标、范围线索和初始工作，不决定项目状态或方法。",
  parameters,
  execute: async () => ({
    content: [{ type: "text", text: "建项理解结果已接收。" }],
    details: undefined,
    terminate: true,
  }),
};

const systemPrompt = [
  "你是Chat的项目建项自然语言理解节点，不是项目经理。",
  "必须且只能调用submit_project_intake_understanding一次，不要输出普通文本。",
  "只提取用户明确表达或可以保守归纳的信息；不要虚构项目状态、参与者、完成事实、文件内容或方法选择。",
  "name是简短项目名；goal是长期目标；summary是用户诉求摘要。",
  "scopeHints、successCriteriaHints和initialWorkHints使用短句；initialWorkHints至少一项。",
  "信息不足写入openQuestions，但仍生成最小可审核理解结果。",
  "资源显示名只用于消歧，不代表你已经读取资源。",
].join("\n");

export const PROJECT_INTAKE_PROMPT_TEMPLATE_VERSION = "project-intake-understanding.v1";

export class PiProjectIntakeUnderstandingAdapter {
  constructor(private readonly profile: ProjectModelProfile) {}

  describe() {
    return {
      profileVersion: this.profile.profileVersion,
      providerName: this.profile.providerName,
      modelId: this.profile.modelId,
      promptTemplateVersion: PROJECT_INTAKE_PROMPT_TEMPLATE_VERSION,
      endpointHost: this.profile.endpointHost,
    };
  }

  async understand(input: {
    readonly text: string;
    readonly resourceDisplayName: string;
  }): Promise<{
    understanding: ProjectIntakeUnderstanding;
    evidence: {
      durationMs: number;
      providerRequestId?: string;
      tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number };
    };
  }> {
    if (this.profile.apiKey === undefined) throw new BailianNotReadyError();
    const result = await runAgentWithTool<ProjectIntakeUnderstanding>({
      apiKey: this.profile.apiKey,
      baseUrl: this.profile.baseUrl,
      model: buildProjectModel(this.profile),
      systemPrompt,
      userPrompt: [
        `资源显示名：${input.resourceDisplayName}`,
        "用户建项描述：",
        input.text,
        "请提交建项理解结果。",
      ].join("\n"),
      tool,
      parseCandidate: (params) => {
        const parsed = projectIntakeUnderstandingSchema.safeParse(params);
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
      const error = new Error("Project Intake Provider调用失败");
      Object.assign(error, { code: result.errorCode });
      throw error;
    }
    const error = new Error("Project Intake理解结果不符合合同");
    Object.assign(error, { code: "model_candidate_invalid" });
    throw error;
  }
}
