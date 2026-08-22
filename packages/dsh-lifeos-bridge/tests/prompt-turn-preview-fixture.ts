import { promptTurnPreviewDtoSchema, type PromptTurnPreviewDto } from "@chat/contracts/public";

const SHA = "a".repeat(64);
const AGENT_VERSION_SHA = "b".repeat(64);

/** 边界测试只需要一份严格合法、无运行时副作用的Prompt预览读模型。 */
export function promptTurnPreviewFixture(text = "审核后发送"): PromptTurnPreviewDto {
  return promptTurnPreviewDtoSchema.parse({
    schemaVersion: "chat-product-api.v1",
    status: "pre_send",
    currentInput: text,
    assembly: {
      schemaVersion: "prompt-assembly.v3",
      promptAssemblyId: "pma_previewfixture",
      productSessionId: "psn_previewfixture",
      productRunId: "run_previewfixture",
      sourceMessageId: "msg_previewfixture",
      workflowDefinitionRevisionId: "wfr_previewfixture",
      profileVersion: "workflow-agent-prompt-profile.v1",
      compilerVersion: "workflow-agent-prompt-compiler.v1",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v2",
        workflowDefinitionRevisionId: "wfr_previewfixture",
        regions: [],
        nodeSelections: [],
      },
      sharedRegions: [],
      nodes: [
        {
          definitionNodeId: "agent.plan",
          nodeType: "agent.plan",
          profileVersion: "planner-prompt.v3",
          regions: [],
          systemPromptAppend: "你是规划 Agent。",
          sha256: SHA,
        },
      ],
      sha256: SHA,
      createdAt: "2026-08-22T00:00:00.000Z",
    },
    nodes: [
      {
        definitionNodeId: "agent.plan",
        nodeType: "agent.plan",
        runtimeResolution: {
          stage: "workflow_node_template",
          governedSystemPromptAppend: "# 用户管理提示词（受治理层）\n\n你是规划 Agent。",
          toolResolution: "runtime_deferred",
          note: "这是Workflow节点发送前冻结的Chat管理层；节点固定Runtime System在执行时解析。",
        },
        agent: {
          schemaVersion: "chat-agent-profile-api.v2",
          agentKey: "planner",
          title: "规划 Agent",
          description: "生成计划候选。",
          profileVersion: "planner-prompt.v3",
          supportedNodeTypes: ["agent.plan"],
          systemPrompt: {
            source: "builtin",
            mode: "replace",
            promptFragmentId: "pfg_previewfixture",
            promptFragmentRevisionId: "pfr_previewfixture",
            revision: 1,
            aggregateRevision: 0,
            sha256: SHA,
            bodyMarkdown: "你是规划 Agent。",
            sourceRelativePath: "prompts/fragments/agent-identity/planner-agent.md",
          },
          tools: [
            {
              name: "submit_plan_candidate",
              description: "提交结构化计划候选。",
              policy: "runtime_locked",
            },
          ],
          versions: [
            {
              schemaVersion: "agent-version.v1",
              agentVersionId: "avn_previewfixture1",
              agentKey: "planner",
              ownerPrincipalId: "usr_debug",
              scope: { kind: "global" },
              version: 1,
              title: "规划 Agent · 默认版本",
              description: "用于Prompt预览测试的不可变Agent Version。",
              sha256: AGENT_VERSION_SHA,
              runtime: {
                kind: "pi_coding_agent",
                baseVariantKey: "read_only",
              },
              baselineRef: {
                packageName: "@earendil-works/pi-coding-agent",
                packageVersion: "0.84.2",
                managedSource: "later-3/pi@codex/later-custom",
                managedSourceRevision: "a".repeat(40),
                variantKey: "read_only",
                capabilityCatalogSha256: "e".repeat(64),
              },
              systemPrompt: {
                mode: "replace",
                bodyMarkdown: "你是规划 Agent。",
                sha256: AGENT_VERSION_SHA,
              },
              enabledToolNames: ["read"],
              resources: {
                contextFiles: "inherit_runtime_default",
                skills: "inherit_runtime_default",
                promptTemplates: "inherit_runtime_default",
                extensions: "inherit_runtime_default",
              },
              createdAt: "2026-08-22T00:00:00.000Z",
            },
          ],
          allowedActions: ["revise_prompt"],
        },
      },
    ],
  });
}
