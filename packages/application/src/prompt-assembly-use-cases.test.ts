import {
  AGENT_VERSION_SCHEMA_VERSION,
  agentVersionHashInputSchema,
  agentVersionSchema,
  agentRuntimeBaselineDtoSchema,
  createEmptySnapshot,
  type AgentKey,
  type AgentVersion,
  type PromptFragmentRevision,
} from "@chat/contracts";
import { computePromptFragmentRevisionSha256, hashCanonical } from "@chat/domain";
import { describe, expect, it } from "vitest";
import type { ApplicationDeps } from "./deps.js";
import {
  compileDirectPromptAssembly,
  compileWorkflowPromptAssembly,
  previewDirectPromptAssembly,
  previewDirectPromptConfiguration,
} from "./prompt-assembly-use-cases.js";

const NOW = "2026-08-20T00:00:00.000Z";
const SHA = "a".repeat(64);

function runtimeTool(name: string, workspaceRootId?: string) {
  const effect = ["read", "grep", "find", "ls"].includes(name)
    ? ("read" as const)
    : name === "bash"
      ? ("shell" as const)
      : name === "edit" || name === "write"
        ? ("local_write" as const)
        : ("external_write" as const);
  const capabilityId =
    name === "project_bootstrap_prepare"
      ? "pi_direct:tool:managed_extension:project_bootstrap:project_bootstrap_prepare"
      : name === "runtime_probe"
        ? "pi_direct:tool:workspace_extension:test:runtime_probe"
        : `pi_direct:tool:builtin:${name}`;
  const sourceRef =
    name === "project_bootstrap_prepare"
      ? {
          sourceKind: "managed_extension" as const,
          repository: "later-3/Chat",
          revision: "chat-project-bootstrap-tool.v1",
          artifactSha256: "7".repeat(64),
          resourcePath: "packages/pi-runtime/src/project-bootstrap-tool.ts",
        }
      : name === "runtime_probe"
        ? {
            sourceKind: "workspace_extension" as const,
            package: "workspace-test",
            resourcePath: "<WORKSPACE_ROOT>/.pi/extensions/runtime-probe.ts",
            contentSha256: "8".repeat(64),
          }
        : {
            sourceKind: "builtin" as const,
            package: "@earendil-works/pi-coding-agent",
            repository: "later-3/pi",
            revision: "1".repeat(40),
            resourcePath: `pi/packages/coding-agent/src/core/tools/${name}.ts`,
          };
  const descriptorInput = {
    schemaVersion: "capability-descriptor.v1" as const,
    capabilityId,
    kind: "executable_tool" as const,
    runtimeOwner: "pi_direct" as const,
    localName: name,
    sourceRef,
    inputSchemaSha256: hashCanonical("test-tool-schema.v1", { name }),
    effect,
    scopePolicy:
      name === "project_bootstrap_prepare"
        ? ("provider_defined" as const)
        : ("workspace_required" as const),
    approvalPolicy:
      effect === "read" || name === "project_bootstrap_prepare"
        ? ("run_policy" as const)
        : ("product_decision_required" as const),
    evidencePolicy:
      effect === "read" || name === "project_bootstrap_prepare"
        ? ("runtime_journal" as const)
        : ("product_intent_result" as const),
    readiness: "available" as const,
  };
  const descriptorSha256 = hashCanonical("capability-descriptor.v1", descriptorInput);
  return {
    name,
    description: `${name} tool`,
    parametersJson: "{}",
    sourceRelativePath:
      sourceRef.resourcePath ?? `pi/packages/coding-agent/src/core/tools/${name}.ts`,
    capability: { ...descriptorInput, descriptorSha256 },
    resolvedRef: {
      capabilityId,
      descriptorSha256,
      inputSchemaSha256: descriptorInput.inputSchemaSha256,
      resolvedImplementationSha256: hashCanonical("test-tool-implementation.v1", sourceRef),
      scopeRef:
        name === "project_bootstrap_prepare"
          ? ({ kind: "provider", providerRef: "chat:project-bootstrap-candidate.v1" } as const)
          : workspaceRootId === undefined
            ? ({ kind: "global" } as const)
            : ({ kind: "workspace", rootId: workspaceRootId } as const),
    },
  };
}

function runtimeProfile(agentKey: AgentKey) {
  if (agentKey !== "direct" && agentKey !== "project_bootstrap" && agentKey !== "coding_executor")
    return undefined;
  const direct = agentKey === "direct";
  const bootstrap = agentKey === "project_bootstrap";
  const variantKey = direct ? "pi_cli_default" : bootstrap ? "read_only" : "workspace_write_shell";
  const tools = direct
    ? ["read", "bash", "edit", "write"]
    : bootstrap
      ? ["project_bootstrap_prepare"]
      : ["read", "bash", "edit", "write", "grep", "find", "ls"];
  return agentRuntimeBaselineDtoSchema.parse({
    kind: "pi_coding_agent",
    title: "Pi Coding Agent",
    packageName: "@earendil-works/pi-coding-agent",
    packageVersion: "0.84.2",
    managedSource: "later-3/pi@codex/later-custom",
    managedSourceRevision: "1".repeat(40),
    compositionStrategy:
      "pi_runtime_then_agent_version_then_workflow_session_run_then_chat_context",
    chatRuntimeAppend: {
      bodyMarkdown: direct || bootstrap ? "Direct Runtime Contract" : "Coding Runtime Contract",
      sha256: "b".repeat(64),
      sourceRelativePath: "packages/pi-runtime/src/coding-agent-runtime-profile.ts",
      appliesToVariantKeys: [variantKey],
    },
    variants: (bootstrap
      ? [
          { key: "read_only", names: ["read", "grep", "find", "ls"] },
          { key: "project_bootstrap", names: tools },
        ]
      : [{ key: variantKey, names: tools }]
    ).map((definition) => ({
      variantKey: definition.key,
      title: definition.key,
      description: "测试Pi能力",
      capabilityCatalogSha256: "2".repeat(64),
      readiness: "available",
      diagnostics: [],
      enabledToolNames: definition.names,
      piSystemPrompt: {
        bodyMarkdown: `Pi System ${definition.key}`,
        sha256: "c".repeat(64),
        dynamicPlaceholders: ["WORKSPACE_ROOT"],
        sourceRelativePaths: ["pi/packages/coding-agent/src/core/system-prompt.ts"],
      },
      tools: definition.names.map((name) => runtimeTool(name)),
    })),
    finalReviewNote: "最终内容以发送前审核为准。",
  });
}

function region(
  regionKey: string,
  title: string,
  plannedPlacement: "system" | "messages",
  stableOrder: number,
) {
  return {
    schemaVersion: "chat-prompt-studio-api.v1" as const,
    regionKey,
    title,
    description: `${title}说明`,
    category: plannedPlacement === "system" ? ("identity" as const) : ("context" as const),
    plannedPlacement,
    contentKind: "markdown" as const,
    cardinality: "multiple" as const,
    userManageable: true,
    availability: "active" as const,
    stableOrder,
    catalogRevision: 1,
    sha256: SHA as never,
    sourceRelativePath: "prompts/regions/catalog.md",
  };
}

function revision(input: {
  id: string;
  fragmentId: string;
  regionKey: string;
  title: string;
  body: string;
}): PromptFragmentRevision {
  const body = {
    promptFragmentId: input.fragmentId as never,
    revision: 1,
    regionKey: input.regionKey,
    title: input.title,
    content: { kind: "markdown" as const, bodyMarkdown: input.body },
    authoredByPrincipalId: "usr_promptassembly" as never,
  };
  return {
    schemaVersion: "prompt-fragment-revision.v1",
    promptFragmentRevisionId: input.id as never,
    ...body,
    sha256: computePromptFragmentRevisionSha256(body) as never,
    createdAt: NOW,
  };
}

function directAgentVersion(input: {
  readonly agentVersionId: string;
  readonly bodyMarkdown: string;
  readonly enabledToolNames: readonly string[];
  readonly scope?:
    { readonly kind: "global" } | { readonly kind: "workspace"; readonly rootId: string };
  readonly capabilityCatalogSha256?: string;
  readonly version?: number;
  readonly resources: {
    readonly contextFiles: "inherit_runtime_default" | "disabled";
    readonly skills: "inherit_runtime_default" | "disabled";
    readonly promptTemplates: "inherit_runtime_default" | "disabled";
    readonly extensions: "inherit_runtime_default" | "disabled";
  };
}): AgentVersion {
  const hashInput = agentVersionHashInputSchema.parse({
    schemaVersion: AGENT_VERSION_SCHEMA_VERSION,
    agentVersionId: input.agentVersionId,
    agentKey: "direct",
    ownerPrincipalId: "usr_promptassembly",
    scope: input.scope ?? { kind: "global" },
    version: input.version ?? 1,
    title: "Direct Agent测试版本",
    description: "验证Prompt Assembly只采用显式Agent Version。",
    runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
    baselineRef: {
      packageName: "@earendil-works/pi-coding-agent",
      packageVersion: "0.84.2",
      managedSource: "later-3/pi@codex/later-custom",
      managedSourceRevision: "1".repeat(40),
      variantKey: "pi_cli_default",
      capabilityCatalogSha256: input.capabilityCatalogSha256 ?? "2".repeat(64),
    },
    systemPrompt: {
      mode: "replace",
      bodyMarkdown: input.bodyMarkdown,
      sha256: hashCanonical("agent-system-prompt.v1", {
        bodyMarkdown: input.bodyMarkdown,
      }),
    },
    enabledToolNames: input.enabledToolNames,
    enabledCapabilityRefs: input.enabledToolNames.map((name) => {
      const tool = runtimeTool(
        name,
        input.scope?.kind === "workspace" ? input.scope.rootId : undefined,
      );
      return {
        localName: name,
        capabilityId: tool.capability.capabilityId,
        descriptorSha256: tool.capability.descriptorSha256,
      };
    }),
    resources: input.resources,
    createdAt: NOW,
  });
  return agentVersionSchema.parse({
    ...hashInput,
    sha256: hashCanonical(hashInput.schemaVersion, hashInput),
  });
}

function fixture(): {
  deps: ApplicationDeps;
  snapshot: ReturnType<typeof createEmptySnapshot>;
  globalRevision: PromptFragmentRevision;
  workspaceRevision: PromptFragmentRevision;
} {
  const snapshot = createEmptySnapshot(NOW);
  const globalRevision = revision({
    id: "pfr_globalbackground1",
    fragmentId: "pfg_globalbackground",
    regionKey: "background",
    title: "全局背景",
    body: "全局背景正文",
  });
  const workspaceRevision = revision({
    id: "pfr_workspacerules1",
    fragmentId: "pfg_workspacerules",
    regionKey: "rules",
    title: "Chat 工作区规则",
    body: "工作区规则正文",
  });
  snapshot.entities.promptFragmentRevisions[globalRevision.promptFragmentRevisionId] =
    globalRevision;
  snapshot.entities.promptFragmentRevisions[workspaceRevision.promptFragmentRevisionId] =
    workspaceRevision;
  snapshot.entities.promptFragments[globalRevision.promptFragmentId] = {
    schemaVersion: "prompt-fragment.v1",
    promptFragmentId: globalRevision.promptFragmentId,
    ownerPrincipalId: "usr_promptassembly" as never,
    scope: { kind: "global" },
    status: "active",
    currentRevisionId: globalRevision.promptFragmentRevisionId,
    currentRevisionNumber: 1,
    currentRevisionSha256: globalRevision.sha256,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.entities.promptFragments[workspaceRevision.promptFragmentId] = {
    schemaVersion: "prompt-fragment.v1",
    promptFragmentId: workspaceRevision.promptFragmentId,
    ownerPrincipalId: "usr_promptassembly" as never,
    scope: { kind: "workspace", rootId: "root_chat" },
    status: "active",
    currentRevisionId: workspaceRevision.promptFragmentRevisionId,
    currentRevisionNumber: 1,
    currentRevisionSha256: workspaceRevision.sha256,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const deps = {
    store: {
      read: async () => ({ snapshot: structuredClone(snapshot) }),
      transact: async () => {
        throw new Error("测试不写Store");
      },
    },
    now: () => NOW,
    ids: {},
    promptCatalog: {
      load: async () => ({
        catalogSha256: SHA,
        sharedSelectionProfile: {
          profileId: "test-shared-default.v1",
          defaultRevisionIds: [],
        },
        regions: [
          region("agent_identity", "Agent 身份", "system", 10),
          region("background", "背景", "messages", 20),
          region("rules", "规则", "messages", 30),
        ],
        builtinFragments: [
          {
            promptFragmentId: "pfg_builtinagentidentity" as never,
            promptFragmentRevisionId: "pfr_builtinagentidentityv2" as never,
            revision: 2,
            regionKey: "agent_identity",
            title: "通用身份",
            content: { kind: "markdown" as const, bodyMarkdown: "你是Chat Agent。" },
            scope: { kind: "global" as const },
            sha256: SHA,
            sourceRelativePath: "prompts/fragments/agent-identity/general-chat-agent.md",
            createdAt: NOW,
          },
          ...[
            ["planner", "规划 Agent", "你是规划 Agent。"],
            ["direct", "直接执行 Agent", "你是直接执行 Agent。"],
            ["projectbootstrap", "项目初始化 Agent", "你是项目初始化 Agent。"],
            ["codingexecutor", "编码执行 Agent", "你是编码执行 Agent。"],
            ["noteextractor", "笔记提取 Agent", "你是笔记提取 Agent。"],
          ].map(([key, title, body]) => ({
            promptFragmentId: `pfg_builtin${key}` as never,
            promptFragmentRevisionId: `pfr_builtin${key}v1` as never,
            revision: 1,
            regionKey: "agent_identity",
            title: title!,
            content: { kind: "markdown" as const, bodyMarkdown: body! },
            scope: { kind: "global" as const },
            sha256: SHA,
            sourceRelativePath: `prompts/fragments/agent-identity/${key}.md`,
            createdAt: NOW,
          })),
        ],
        agents: [
          {
            agentKey: "planner" as const,
            title: "规划 Agent",
            description: "负责规划",
            profileVersion: "planner-prompt.v3",
            supportedNodeTypes: ["agent.plan"],
            defaultPrompt: {
              kind: "catalog_fragment",
              promptFragmentRevisionId: "pfr_builtinplannerv1" as never,
            },
            tools: [{ name: "submit_plan_candidate", description: "提交计划候选" }],
          },
          {
            agentKey: "direct" as const,
            title: "直接执行 Agent",
            description: "负责直接执行",
            profileVersion: "direct-agent-prompt.v1",
            supportedNodeTypes: ["agent.direct"],
            defaultPrompt: {
              kind: "pi_coding_agent",
              defaultVariantKey: "pi_cli_default",
            },
            tools: [{ name: "read", description: "读取文件" }],
          },
          {
            agentKey: "project_bootstrap" as const,
            title: "项目初始化 Agent",
            description: "负责准备项目初始化候选",
            profileVersion: "project-bootstrap-agent.v1",
            supportedNodeTypes: ["agent.direct"],
            defaultPrompt: {
              kind: "pi_coding_agent",
              defaultVariantKey: "read_only",
              promptFragmentRevisionId: "pfr_builtinprojectbootstrapv1" as never,
            },
            tools: [
              { name: "read", description: "读取文件" },
              { name: "project_bootstrap_prepare", description: "准备项目候选" },
            ],
          },
          {
            agentKey: "coding_executor" as const,
            title: "编码执行 Agent",
            description: "负责编码执行",
            profileVersion: "executor-coding-agent-prompt.v1",
            supportedNodeTypes: ["execute.plan"],
            defaultPrompt: {
              kind: "pi_coding_agent",
              defaultVariantKey: "workspace_write_shell",
            },
            tools: [{ name: "write", description: "写入文件" }],
          },
          {
            agentKey: "note_extractor" as const,
            title: "笔记提取 Agent",
            description: "负责笔记提取",
            profileVersion: "note-capture.v1",
            supportedNodeTypes: ["note.extract"],
            defaultPrompt: {
              kind: "catalog_fragment",
              promptFragmentRevisionId: "pfr_builtinnoteextractorv1" as never,
            },
            tools: [{ name: "submit_note_candidate", description: "提交笔记候选" }],
          },
        ],
      }),
    },
    projectRoots: {
      list: () => [
        {
          rootId: "root_chat",
          displayName: "Chat 工作区",
          enabledAdapters: ["local-git-workspace.v1" as const],
          grantSha256: "4".repeat(64),
        },
      ],
      observe: async () => {
        throw new Error("测试不观察Workspace");
      },
    },
    agentRuntimeProfiles: { read: async (agentKey: AgentKey) => runtimeProfile(agentKey) },
  } as unknown as ApplicationDeps;
  return { deps, snapshot, globalRevision, workspaceRevision };
}

describe("Direct Prompt Assembly", () => {
  it("V3为不同Agent注入各自System Prompt并共享同一会话上下文", async () => {
    const { deps, globalRevision, workspaceRevision } = fixture();
    const assembly = await compileWorkflowPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "规划并执行",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v2",
        workspaceRootId: "root_chat",
        workflowDefinitionRevisionId: "wfr_promptworkflow1" as never,
        regions: [
          {
            regionKey: "background",
            mode: "replace",
            selected: [
              {
                promptFragmentRevisionId: globalRevision.promptFragmentRevisionId,
                sha256: globalRevision.sha256,
              },
            ],
          },
        ],
        nodeSelections: [
          {
            definitionNodeId: "planning.execute",
            regions: [
              {
                regionKey: "rules",
                mode: "append",
                selected: [
                  {
                    promptFragmentRevisionId: workspaceRevision.promptFragmentRevisionId,
                    sha256: workspaceRevision.sha256,
                  },
                ],
              },
            ],
          },
        ],
      },
      productSessionId: "psn_promptworkflow1" as never,
      productRunId: "run_promptworkflow1" as never,
      sourceMessageId: "msg_promptworkflow1" as never,
      workflowDefinitionRevisionId: "wfr_promptworkflow1" as never,
      nodeResolutions: [
        {
          definitionNodeId: "planning.plan",
          nodeType: "agent.plan",
          schemaVersion: 1,
          config: {},
          activation: "enabled",
        },
        {
          definitionNodeId: "planning.execute",
          nodeType: "execute.plan",
          schemaVersion: 1,
          config: {},
          activation: "enabled",
        },
      ],
      createdAt: NOW,
    });

    expect(assembly.schemaVersion).toBe("prompt-assembly.v3");
    expect(assembly.nodes.map((node) => node.definitionNodeId)).toEqual([
      "planning.plan",
      "planning.execute",
    ]);
    const planner = assembly.nodes[0]!;
    const executor = assembly.nodes[1]!;
    expect(planner.systemPromptAppend).toContain("全局背景正文");
    expect(planner.systemPromptAppend).toContain("你是规划 Agent");
    expect(planner.systemPromptAppend).not.toContain("工作区规则正文");
    expect(executor.systemPromptAppend).toContain("全局背景正文");
    expect(executor.systemPromptAppend).not.toContain("你是编码执行 Agent");
    expect(executor.piSystemPrompt).toEqual({ kind: "pi_coding_agent", mode: "inherit" });
    expect(executor.systemPromptAppend).not.toContain("工作区规则正文");
    expect(executor.sha256).not.toBe(planner.sha256);
  });

  it("Workflow/Run节点Prompt覆盖替换Agent默认，并保留独立来源身份", async () => {
    const { deps } = fixture();
    const assembly = await compileWorkflowPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "规划",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v2",
        workflowDefinitionRevisionId: "wfr_promptworkflowoverride1" as never,
        regions: [],
        nodeSelections: [],
      },
      productSessionId: "psn_promptworkflowoverride1" as never,
      productRunId: "run_promptworkflowoverride1" as never,
      sourceMessageId: "msg_promptworkflowoverride1" as never,
      workflowDefinitionRevisionId: "wfr_promptworkflowoverride1" as never,
      nodeResolutions: [
        {
          definitionNodeId: "planning.plan",
          nodeType: "agent.plan",
          schemaVersion: 1,
          config: {
            agentKey: "planner",
            agentPromptOverride: "你是这个Workflow专属的规划Agent。",
          },
          activation: "enabled",
        },
      ],
      createdAt: NOW,
    });

    const identity = assembly.nodes[0]?.regions[0];
    expect(identity).toMatchObject({
      regionKey: "agent_identity",
      mode: "replace",
      fragments: [
        {
          ownerKind: "workflow_node_override",
          selectionKind: "explicit",
          content: {
            kind: "markdown",
            bodyMarkdown: "你是这个Workflow专属的规划Agent。",
          },
        },
      ],
    });
    expect(assembly.nodes[0]?.systemPromptAppend).toContain("Workflow专属的规划Agent");
    expect(assembly.nodes[0]?.systemPromptAppend).not.toContain("你是规划 Agent");
  });

  it("每个Region独立执行default/replace/append并保留全局与Workspace精确来源", async () => {
    const { deps, globalRevision, workspaceRevision } = fixture();
    const preview = await previewDirectPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "这是一个什么项目？",
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [
          {
            regionKey: "background",
            mode: "replace",
            selected: [
              {
                promptFragmentRevisionId: globalRevision.promptFragmentRevisionId,
                sha256: globalRevision.sha256,
              },
            ],
          },
          {
            regionKey: "rules",
            mode: "append",
            selected: [
              {
                promptFragmentRevisionId: workspaceRevision.promptFragmentRevisionId,
                sha256: workspaceRevision.sha256,
              },
            ],
          },
        ],
      },
    });

    expect(preview.regions.map((item) => [item.regionKey, item.mode])).toEqual([
      ["background", "replace"],
      ["rules", "append"],
    ]);
    expect(preview.systemPromptAppend).not.toContain("你是Chat Agent");
    expect(preview.systemPromptAppend).toContain("全局背景正文");
    expect(preview.systemPromptAppend).toContain("工作区规则正文");
    expect(preview.userPrompt).toBe("这是一个什么项目？");
    expect(preview.regions[1]?.fragments[0]?.scope).toEqual({
      kind: "workspace",
      rootId: "root_chat",
    });

    const configuration = await previewDirectPromptConfiguration(deps, {
      principalId: "usr_promptassembly" as never,
      selection: {
        schemaVersion: "prompt-turn-selection-input.v1",
        workspaceRootId: "root_chat",
        regions: [],
      },
    });
    expect(configuration.systemPromptAppend).not.toContain("你是Chat Agent");
    expect(configuration.messageContext).toBe("");
    expect(JSON.stringify(configuration)).not.toContain("当前输入");
  });

  it("拒绝把其他Workspace组件选入当前会话", async () => {
    const { deps, workspaceRevision } = fixture();
    await expect(
      previewDirectPromptAssembly(deps, {
        principalId: "usr_promptassembly" as never,
        text: "检查",
        selection: {
          schemaVersion: "prompt-turn-selection-input.v1",
          regions: [
            {
              regionKey: "rules",
              mode: "replace",
              selected: [
                {
                  promptFragmentRevisionId: workspaceRevision.promptFragmentRevisionId,
                  sha256: workspaceRevision.sha256,
                },
              ],
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("V4保留最近正式user/assistant历史并把本轮原文作为最后一条user", async () => {
    const { deps, snapshot } = fixture();
    snapshot.entities.sessions["psn_promptassembly"] = {
      schemaVersion: "product-session.v1",
      sessionId: "psn_promptassembly" as never,
      ownerPrincipalId: "usr_promptassembly" as never,
      status: "active",
      lastMessageSequence: 2,
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.entities.messages["msg_promptassemblyolduser"] = {
      schemaVersion: "message.v1",
      messageId: "msg_promptassemblyolduser" as never,
      sessionId: "psn_promptassembly" as never,
      sessionSequence: 1,
      role: "user",
      content: { format: "markdown", text: "上一轮问题" },
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.entities.messages["msg_promptassemblyoldassistant"] = {
      schemaVersion: "message.v1",
      messageId: "msg_promptassemblyoldassistant" as never,
      sessionId: "psn_promptassembly" as never,
      sessionSequence: 2,
      role: "assistant",
      content: { format: "markdown", text: "上一轮正式回答" },
      sourceRunId: "run_promptassemblyold" as never,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.entities.runs["run_promptassemblyold"] = {
      schemaVersion: "product-run.v3",
      runKind: "direct_agent",
      productRunId: "run_promptassemblyold" as never,
      sessionId: "psn_promptassembly" as never,
      sourceMessageId: "msg_promptassemblyolduser" as never,
      workflowViewDefinitionId: "wvw_promptassemblyold" as never,
      workflowRunSpecId: "wrs_promptassemblyold" as never,
      runnerFamily: "direct-agent.v1",
      runnerBundleVersion: "direct-agent.bundle.v1",
      status: "succeeded",
      phase: "completed",
      finalMessageId: "msg_promptassemblyoldassistant" as never,
      revision: 3,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const assembly = await compileDirectPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "这是本轮原始用户输入",
      selection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
      productSessionId: "psn_promptassembly" as never,
      productRunId: "run_promptassemblycurrent" as never,
      sourceMessageId: "msg_promptassemblycurrent" as never,
      sourceMessageSequence: 3,
      sourceMessageSha256: "b".repeat(64),
      workflowDefinitionRevisionId: "wfr_promptassembly" as never,
      createdAt: NOW,
    });

    expect(assembly.schemaVersion).toBe("prompt-assembly.v4");
    expect(
      assembly.messages.map(({ role, text, source }) => ({ role, text, kind: source.kind })),
    ).toEqual([
      { role: "user", text: "上一轮问题", kind: "product_message" },
      { role: "assistant", text: "上一轮正式回答", kind: "product_message" },
      { role: "user", text: "这是本轮原始用户输入", kind: "current_input" },
    ]);
    expect(assembly.systemPromptAppend).not.toContain("你是直接执行 Agent");
    expect(assembly.piSystemPrompt).toEqual({ kind: "pi_coding_agent", mode: "inherit" });
    expect(assembly.budget.totalEstimatedTokens).toBeLessThanOrEqual(
      assembly.budget.inputTokenLimit,
    );
  });

  it("Agent Version与临时配置精确决定System Prompt、Tools和资源且临时值不落库", async () => {
    const { deps, snapshot } = fixture();
    const versionResources = {
      contextFiles: "inherit_runtime_default",
      skills: "disabled",
      promptTemplates: "inherit_runtime_default",
      extensions: "disabled",
    } as const;
    const version = directAgentVersion({
      agentVersionId: "avn_promptassemblyversion1",
      bodyMarkdown: "你是持久Agent Version定义的Direct Agent。",
      enabledToolNames: ["read", "bash"],
      resources: versionResources,
    });
    const zeroToolVersion = directAgentVersion({
      agentVersionId: "avn_promptassemblyzerotool1",
      bodyMarkdown: "你是合法的零Tool Direct Agent。",
      enabledToolNames: [],
      resources: versionResources,
      version: 2,
    });
    snapshot.entities.agentVersions[version.agentVersionId] = version;
    snapshot.entities.agentVersions[zeroToolVersion.agentVersionId] = zeroToolVersion;
    const committedBefore = structuredClone(snapshot);
    const compile = (suffix: string, config: Readonly<Record<string, unknown>>) =>
      compileDirectPromptAssembly(deps, {
        principalId: "usr_promptassembly" as never,
        text: "检查Agent配置",
        selection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
        productSessionId: `psn_prompt${suffix}` as never,
        productRunId: `run_prompt${suffix}` as never,
        sourceMessageId: `msg_prompt${suffix}` as never,
        sourceMessageSequence: 1,
        sourceMessageSha256: "d".repeat(64),
        workflowDefinitionRevisionId: `wfr_prompt${suffix}` as never,
        nodeResolutions: [
          {
            definitionNodeId: "direct.agent",
            nodeType: "agent.direct",
            schemaVersion: 1,
            config,
            activation: "enabled",
          },
        ],
        createdAt: NOW,
      });

    const versionConfig = {
      capabilityMode: "pi_cli_default",
      promptReviewMode: "manual",
      agentVersionId: version.agentVersionId,
      agentVersionSha256: version.sha256,
    } as const;
    const versionAssembly = await compile("version1", versionConfig);
    expect(versionAssembly.piSystemPrompt).toMatchObject({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: "你是持久Agent Version定义的Direct Agent。",
    });
    expect(versionAssembly.tools).toMatchObject({
      capabilityMode: "custom",
      selectionMode: "explicit",
      names: ["read", "bash"],
      resources: versionResources,
      estimatedTokens: 8_000,
    });
    expect(
      versionAssembly.tools.capabilities?.map((capability) => capability.ref.capabilityId),
    ).toEqual(["pi_direct:tool:builtin:read", "pi_direct:tool:builtin:bash"]);
    expect(versionAssembly.requestOptions).toMatchObject({
      thinkingLevel: "medium",
      retryEnabled: true,
      compactionEnabled: true,
    });

    const temporaryResources = {
      contextFiles: "disabled",
      skills: "inherit_runtime_default",
      promptTemplates: "disabled",
      extensions: "inherit_runtime_default",
    } as const;
    const temporaryConfiguration = {
      runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "replace", bodyMarkdown: "你只在当前Run临时生效。" },
      enabledToolNames: ["read"],
      enabledCapabilityRefs: [runtimeTool("read").capability].map((capability) => ({
        capabilityId: capability.capabilityId,
        descriptorSha256: capability.descriptorSha256,
      })),
      resources: temporaryResources,
      basedOnVersionId: version.agentVersionId,
      basedOnVersionSha256: version.sha256,
    } as const;
    const temporaryAssembly = await compile("temporary1", {
      capabilityMode: "custom",
      promptReviewMode: "manual",
      enabledToolNames: temporaryConfiguration.enabledToolNames,
      resourcePolicy: temporaryResources,
      agentTemporaryConfiguration: temporaryConfiguration,
    });
    expect(temporaryAssembly.piSystemPrompt).toMatchObject({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: "你只在当前Run临时生效。",
    });
    expect(temporaryAssembly.tools).toMatchObject({
      capabilityMode: "custom",
      selectionMode: "explicit",
      names: ["read"],
      resources: temporaryResources,
      estimatedTokens: 8_000,
    });
    expect(temporaryAssembly.tools.capabilities?.map((capability) => capability.localName)).toEqual(
      ["read"],
    );
    const zeroToolAssembly = await compile("zerotool1", {
      capabilityMode: "custom",
      promptReviewMode: "manual",
      agentVersionId: zeroToolVersion.agentVersionId,
      agentVersionSha256: zeroToolVersion.sha256,
    });
    expect(zeroToolAssembly.tools).toMatchObject({ names: [], capabilities: [] });

    await expect(
      compile("temporarymissingtool1", {
        capabilityMode: "custom",
        promptReviewMode: "manual",
        enabledToolNames: ["runtime_probe"],
        resourcePolicy: temporaryResources,
        agentTemporaryConfiguration: {
          ...temporaryConfiguration,
          enabledToolNames: ["runtime_probe"],
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      compile("temporaryhashdrift1", {
        capabilityMode: "custom",
        promptReviewMode: "manual",
        enabledToolNames: ["read"],
        resourcePolicy: temporaryResources,
        agentTemporaryConfiguration: {
          ...temporaryConfiguration,
          basedOnVersionSha256: "f".repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });

    const versionAgain = await compile("version2", versionConfig);
    expect(versionAgain.piSystemPrompt).toEqual(versionAssembly.piSystemPrompt);
    expect(versionAgain.tools).toEqual(versionAssembly.tools);
    expect(snapshot).toEqual(committedBefore);

    const defaults = await compile("default1", {
      capabilityMode: "pi_cli_default",
      promptReviewMode: "manual",
    });
    expect(defaults.piSystemPrompt).toEqual({ kind: "pi_coding_agent", mode: "inherit" });
    expect(defaults.tools).toMatchObject({
      capabilityMode: "pi_cli_default",
      selectionMode: "inherit_runtime_default",
      names: [],
      resources: {
        contextFiles: "inherit_runtime_default",
        skills: "inherit_runtime_default",
        promptTemplates: "inherit_runtime_default",
        extensions: "inherit_runtime_default",
      },
      estimatedTokens: 8_000,
    });
    expect(defaults.tools.capabilities.map((capability) => capability.localName)).toEqual([
      "read",
      "bash",
      "edit",
      "write",
    ]);
  });

  it("Run按当前Workspace目录验证全局版本Tool，并用scoped基线解析Workspace版本与临时配置", async () => {
    const { deps, snapshot } = fixture();
    const globalRuntime = runtimeProfile("direct");
    if (globalRuntime === undefined) throw new Error("缺少全局Direct Runtime");
    const scopedRuntime = agentRuntimeBaselineDtoSchema.parse({
      ...globalRuntime,
      variants: globalRuntime.variants.map((variant) =>
        variant.variantKey === "pi_cli_default"
          ? {
              ...variant,
              capabilityCatalogSha256: "3".repeat(64),
              enabledToolNames: ["read", "runtime_probe"],
              tools: [
                variant.tools.find((tool) => tool.name === "read")!,
                {
                  ...runtimeTool("runtime_probe", "root_chat"),
                },
              ],
            }
          : variant,
      ),
    });
    const scopedDeps: ApplicationDeps = {
      ...deps,
      agentRuntimeProfiles: {
        read: async (agentKey: AgentKey, workspaceRootId?: string) =>
          agentKey === "direct" && workspaceRootId === "root_chat"
            ? scopedRuntime
            : runtimeProfile(agentKey),
      },
    };
    const resources = {
      contextFiles: "inherit_runtime_default",
      skills: "inherit_runtime_default",
      promptTemplates: "inherit_runtime_default",
      extensions: "inherit_runtime_default",
    } as const;
    const globalAllowed = directAgentVersion({
      agentVersionId: "avn_scopedglobalallowed1",
      bodyMarkdown: "Global version",
      enabledToolNames: ["read"],
      resources,
    });
    const globalMissing = directAgentVersion({
      agentVersionId: "avn_scopedglobalmissing1",
      bodyMarkdown: "Global version with missing tool",
      enabledToolNames: ["bash"],
      resources,
      version: 2,
    });
    const workspaceVersion = directAgentVersion({
      agentVersionId: "avn_scopedworkspace1",
      bodyMarkdown: "Workspace version",
      enabledToolNames: ["runtime_probe"],
      resources,
      scope: { kind: "workspace", rootId: "root_chat" },
      capabilityCatalogSha256: "3".repeat(64),
      version: 3,
    });
    for (const version of [globalAllowed, globalMissing, workspaceVersion]) {
      snapshot.entities.agentVersions[version.agentVersionId] = version;
    }
    const compile = (suffix: string, config: Readonly<Record<string, unknown>>) =>
      compileDirectPromptAssembly(scopedDeps, {
        principalId: "usr_promptassembly" as never,
        text: "验证Workspace Agent目录",
        selection: {
          schemaVersion: "prompt-turn-selection-input.v1",
          workspaceRootId: "root_chat",
          regions: [],
        },
        productSessionId: `psn_scoped${suffix}` as never,
        productRunId: `run_scoped${suffix}` as never,
        sourceMessageId: `msg_scoped${suffix}` as never,
        sourceMessageSequence: 1,
        sourceMessageSha256: "e".repeat(64),
        workflowDefinitionRevisionId: `wfr_scoped${suffix}` as never,
        nodeResolutions: [
          {
            definitionNodeId: "direct.agent",
            nodeType: "agent.direct",
            schemaVersion: 1,
            config,
            activation: "enabled",
          },
        ],
        createdAt: NOW,
      });

    await expect(
      compile("globalok1", {
        capabilityMode: "custom",
        agentVersionId: globalAllowed.agentVersionId,
        agentVersionSha256: globalAllowed.sha256,
      }),
    ).resolves.toMatchObject({ tools: { names: ["read"] } });
    await expect(
      compile("globalmissing1", {
        capabilityMode: "custom",
        agentVersionId: globalMissing.agentVersionId,
        agentVersionSha256: globalMissing.sha256,
      }),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await expect(
      compile("workspace1", {
        capabilityMode: "custom",
        agentVersionId: workspaceVersion.agentVersionId,
        agentVersionSha256: workspaceVersion.sha256,
      }),
    ).resolves.toMatchObject({ tools: { names: ["runtime_probe"] } });
    await expect(
      compile("temporary1", {
        capabilityMode: "custom",
        agentTemporaryConfiguration: {
          runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
          systemPrompt: { mode: "inherit_runtime" },
          enabledToolNames: ["runtime_probe"],
          enabledCapabilityRefs: [runtimeTool("runtime_probe", "root_chat").capability].map(
            (capability) => ({
              capabilityId: capability.capabilityId,
              descriptorSha256: capability.descriptorSha256,
            }),
          ),
          resources,
        },
      }),
    ).resolves.toMatchObject({ tools: { names: ["runtime_probe"] } });
  });

  it("Project Bootstrap的Capability Tool清单在V4 Assembly中冻结", async () => {
    const { deps } = fixture();
    const assembly = await compileDirectPromptAssembly(deps, {
      principalId: "usr_promptassembly" as never,
      text: "创建项目",
      selection: { schemaVersion: "prompt-turn-selection-input.v1", regions: [] },
      productSessionId: "psn_promptbootstrap1" as never,
      productRunId: "run_promptbootstrap1" as never,
      sourceMessageId: "msg_promptbootstrap1" as never,
      sourceMessageSequence: 1,
      sourceMessageSha256: "c".repeat(64),
      workflowDefinitionRevisionId: "wfr_promptbootstrap1" as never,
      nodeResolutions: [
        {
          definitionNodeId: "direct.agent",
          nodeType: "agent.direct",
          schemaVersion: 1,
          config: {
            capabilityMode: "project_bootstrap",
            promptReviewMode: "manual",
          },
          activation: "enabled",
        },
      ],
      createdAt: NOW,
    });
    expect(assembly.tools).toMatchObject({
      capabilityMode: "project_bootstrap",
      selectionMode: "explicit",
      names: ["project_bootstrap_prepare"],
      resources: {
        contextFiles: "disabled",
        skills: "disabled",
        promptTemplates: "disabled",
        extensions: "disabled",
      },
      estimatedTokens: 8_000,
    });
    expect(assembly.tools.capabilities.map((capability) => capability.localName)).toEqual([
      "project_bootstrap_prepare",
    ]);
    expect(assembly.systemPromptAppend).not.toContain("你是项目初始化 Agent");
    expect(assembly.piSystemPrompt).toMatchObject({
      kind: "pi_coding_agent",
      mode: "replace",
      bodyMarkdown: expect.stringContaining("你是项目初始化 Agent"),
    });
  });
});
