import { describe, expect, it } from "vitest";
import { hashCanonical, type WorkflowSequence } from "@chat/domain";
import {
  DEFAULT_WORKFLOW_BLUEPRINTS,
  validateDefinitionAgainstBlueprint,
  WorkflowBlueprintRegistry,
  WORKFLOW_BLUEPRINTS,
} from "./workflow-blueprints.js";
import {
  kernelCompilerInputFixture,
  kernelDefinitionFixture,
  PLANNING_LOOP_ROOT,
} from "./workflow-kernel-fixtures.js";
import {
  DEFAULT_NODE_CATALOG,
  NODE_CATALOG_DESCRIPTORS,
  NodeCatalog,
} from "./workflow-node-catalog.js";
import { BUILTIN_WORKFLOW_EXECUTOR_MANIFEST } from "./workflow-executor-manifest.js";
import {
  compileWorkflowRunSpec,
  validateRunSpecResourcesCurrent,
  validateWorkflowRunSpecIntegrity,
} from "./workflow-run-spec-compiler.js";
import {
  createSystemDirectAgentDefinition,
  createSystemMemoryPlanningDefinition,
  createSystemPlanningDefinition,
  DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
  DIRECT_AGENT_RUNNER_FAMILY,
  systemDirectAgentSemanticRoot,
  systemSimplePlanningSemanticRoot,
} from "./workflow-system-definitions.js";
import { getWorkflowBlueprints, getWorkflowCatalog } from "./workflow-config-query-use-cases.js";

const fixtureKeys = [
  "sequence",
  "choice",
  "bounded_loop",
  "human_review",
  "composite",
  "mixed",
] as const;

describe("Node Catalog与Blueprint一致性", () => {
  it("当前18种能力全部使用strict parser且默认配置/公开默认值一致", () => {
    expect(DEFAULT_NODE_CATALOG.list()).toHaveLength(18);
    for (const descriptor of DEFAULT_NODE_CATALOG.list()) {
      expect(
        DEFAULT_NODE_CATALOG.parseConfig(
          descriptor.nodeType,
          descriptor.schemaVersion,
          descriptor.defaultConfig,
        ).success,
      ).toBe(true);
      expect(
        DEFAULT_NODE_CATALOG.parseConfig(descriptor.nodeType, descriptor.schemaVersion, {
          ...descriptor.defaultConfig,
          credential: "must-not-pass",
        }).success,
      ).toBe(false);
      for (const field of descriptor.publicConfigFields) {
        if (!("defaultValue" in field)) continue;
        expect(
          DEFAULT_NODE_CATALOG.parseConfig(descriptor.nodeType, descriptor.schemaVersion, {
            ...descriptor.defaultConfig,
            [field.name]: field.defaultValue,
          }).success,
        ).toBe(true);
      }
    }
    expect(
      DEFAULT_NODE_CATALOG.parseConfig("agent.direct", 1, {
        capabilityMode: "custom",
        promptReviewMode: "manual",
        agentVersionId: "avn_catalogambiguous1",
        agentVersionSha256: "a".repeat(64),
        agentTemporaryConfiguration: {
          runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
          systemPrompt: { mode: "inherit_runtime" },
          enabledToolNames: ["read", "bash", "edit", "write"],
          resources: {
            contextFiles: "inherit_runtime_default",
            skills: "inherit_runtime_default",
            promptTemplates: "inherit_runtime_default",
            extensions: "inherit_runtime_default",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      DEFAULT_NODE_CATALOG.parseConfig("agent.direct", 1, {
        capabilityMode: "custom",
        promptReviewMode: "manual",
        agentVersionId: "avn_catalogpromptambiguous1",
        agentVersionSha256: "b".repeat(64),
        agentPromptOverride: "不能与Agent Version混合的普通Prompt Override。",
      }).success,
    ).toBe(false);
  });

  it("重复Catalog键和Blueprint降低风险在启动阶段失败关闭", () => {
    expect(
      () => new NodeCatalog([NODE_CATALOG_DESCRIPTORS[0]!, NODE_CATALOG_DESCRIPTORS[0]!]),
    ).toThrow("workflow.catalog.duplicate_key");
    const baseBlueprint = WORKFLOW_BLUEPRINTS[0]!;
    const weakened = {
      ...baseBlueprint,
      immutableMinimumRisk: {
        ...baseBlueprint.immutableMinimumRisk,
        "product.commit": "product_commit" as const,
      },
    };
    // structuredClone不能复制Zod parser；重组时保留原parser，只替换风险字段。
    const catalog = new NodeCatalog(
      NODE_CATALOG_DESCRIPTORS.map((descriptor) =>
        descriptor.nodeType === "product.commit"
          ? { ...descriptor, riskPolicy: "read_context" as const }
          : descriptor,
      ),
    );
    expect(() => new WorkflowBlueprintRegistry([weakened], catalog)).toThrow(
      "workflow.blueprint.risk_lowered",
    );
  });

  it("Planning、Note与Direct Blueprint都能从权威Registry按版本读取", () => {
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("planning", 1)?.terminalNodeType).toBe("product.commit");
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("note", 1)?.terminalNodeType).toBe("note.commit");
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("direct", 1)).toMatchObject({
      runnerFamily: "direct-agent.v1",
      terminalNodeType: "agent.direct",
      allowedNodeTypes: ["agent.direct"],
      optionalNodeTypes: [],
      repeatableNodeTypes: [],
      mandatoryManualReviewTypes: [],
    });
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("planning", 99)).toBeUndefined();
  });

  it("Direct Blueprint、节点默认值与Executor版本进入安全公开目录", async () => {
    const { catalog } = await getWorkflowCatalog(undefined as never);
    const { blueprints } = await getWorkflowBlueprints(undefined as never);
    const directNodes = catalog.nodes.filter((node) => node.supportedBlueprints.includes("direct"));

    expect(directNodes).toMatchObject([
      {
        nodeType: "agent.direct",
        executorKind: "composite",
        riskPolicy: "generate_candidate",
        publicConfigFields: [
          {
            name: "agentKey",
            type: "enum_select",
            defaultValue: "direct",
            options: ["direct", "project_bootstrap"],
          },
          {
            name: "agentPromptOverride",
            type: "long_text",
            defaultValue: "",
            maximumLength: 65_536,
          },
          {
            name: "capabilityMode",
            defaultValue: "pi_cli_default",
            options: ["pi_cli_default", "read_only", "project_bootstrap"],
          },
          {
            name: "promptReviewMode",
            defaultValue: "manual",
            options: ["manual", "off"],
          },
        ],
        outcomes: ["completed"],
      },
    ]);
    expect(
      blueprints.blueprints.find((blueprint) => blueprint.blueprintKey === "direct"),
    ).toMatchObject({
      title: "执行 Agent（逐次提示词审核）",
      runnerFamily: "direct-agent.v1",
      terminalNodeType: "agent.direct",
      reviewModes: ["manual", "auto_continue_if_policy_allows"],
    });
    expect(
      BUILTIN_WORKFLOW_EXECUTOR_MANIFEST.filter((entry) => entry.nodeType === "agent.direct"),
    ).toEqual([
      {
        nodeType: "agent.direct",
        schemaVersion: 1,
        executorVersion: "agent.direct.v1",
      },
    ]);
  });

  it("Direct系统定义固定为一个带内部Provider审核Hook的执行节点", () => {
    const createdAt = "2026-08-19T00:00:00.000Z";
    const direct = createSystemDirectAgentDefinition(createdAt);
    const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get("direct", 1);
    if (blueprint === undefined) throw new Error("Direct Blueprint不存在");

    expect(direct.definition).toMatchObject({
      key: "system.direct-agent",
      title: "执行 Agent（逐次提示词审核）",
      blueprintKey: "direct",
      status: "active",
    });
    expect(
      validateDefinitionAgainstBlueprint(
        direct.revision.semanticRoot,
        blueprint,
        DEFAULT_NODE_CATALOG,
      ),
    ).toEqual([]);
    expect(direct.view.nodes.map((node) => node.nodeType)).toEqual(["agent.direct"]);
    expect(direct.view.edges).toEqual([]);

    const directNode = systemDirectAgentSemanticRoot().elements[0];
    const planningLoop = systemSimplePlanningSemanticRoot().elements[0];
    if (directNode?.kind !== "composite" || planningLoop?.kind !== "bounded_loop") {
      throw new Error("系统Definition结构缺失");
    }
    expect(directNode.config).toEqual({
      capabilityMode: "pi_cli_default",
      promptReviewMode: "manual",
    });
    expect(planningLoop.maxIterations).toBe(5);

    const compiled = compileWorkflowRunSpec({
      workflowRunSpecId: "wrs_systemdirectagentv1",
      productRunId: "run_systemdirectagentv1",
      createdAt,
      definition: {
        schemaVersion: "workflow-definition-revision-input.v1",
        workflowDefinitionRevisionId: direct.revision.workflowDefinitionRevisionId,
        definitionRevision: direct.revision.definitionRevision,
        blueprintKey: direct.revision.blueprintKey,
        blueprintVersion: direct.revision.blueprintVersion,
        semanticRoot: direct.revision.semanticRoot,
        expectedSha256: direct.revision.definitionSha256,
      },
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
      principal: { principalId: "usr_systemdirectagent", capabilities: [] },
      availableResources: [],
      executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
      runner: {
        runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
        runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      },
      businessInput: { kind: "direct_agent_message" },
    });
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    expect(validateWorkflowRunSpecIntegrity(compiled.runSpec)).toEqual({
      success: true,
      runSpec: compiled.runSpec,
    });

    const withoutReview = compileWorkflowRunSpec({
      ...kernelCompilerInputFixture("sequence"),
      workflowRunSpecId: "wrs_systemdirectagentoff1",
      productRunId: "run_systemdirectagentoff1",
      definition: {
        schemaVersion: "workflow-definition-revision-input.v1",
        workflowDefinitionRevisionId: direct.revision.workflowDefinitionRevisionId,
        definitionRevision: direct.revision.definitionRevision,
        blueprintKey: direct.revision.blueprintKey,
        blueprintVersion: direct.revision.blueprintVersion,
        semanticRoot: direct.revision.semanticRoot,
        expectedSha256: direct.revision.definitionSha256,
      },
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "node_config",
            definitionNodeId: "direct.agent",
            field: "promptReviewMode",
            value: "off",
          },
        ],
      },
      principal: { principalId: "usr_systemdirectagent", capabilities: [] },
      availableResources: [],
      executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
      runner: {
        runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
        runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      },
      businessInput: { kind: "direct_agent_message" },
    });
    expect(withoutReview.success).toBe(true);
    if (withoutReview.success) {
      expect(withoutReview.runSpec.nodeResolutions[0]?.config).toMatchObject({
        capabilityMode: "pi_cli_default",
        promptReviewMode: "off",
      });
    }
  });

  it("RunSpec把Agent Version与临时配置逐字段冻结，并拒绝非Direct节点覆盖", () => {
    const createdAt = "2026-08-22T09:00:00.000Z";
    const direct = createSystemDirectAgentDefinition(createdAt);
    const compileDirect = (
      workflowRunSpecId: string,
      overrides: ReadonlyArray<Readonly<Record<string, unknown>>>,
    ) =>
      compileWorkflowRunSpec({
        workflowRunSpecId,
        productRunId: `run_${workflowRunSpecId.slice(4)}`,
        createdAt,
        definition: {
          schemaVersion: "workflow-definition-revision-input.v1",
          workflowDefinitionRevisionId: direct.revision.workflowDefinitionRevisionId,
          definitionRevision: direct.revision.definitionRevision,
          blueprintKey: direct.revision.blueprintKey,
          blueprintVersion: direct.revision.blueprintVersion,
          semanticRoot: direct.revision.semanticRoot,
          expectedSha256: direct.revision.definitionSha256,
        },
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides,
        },
        principal: { principalId: "usr_agentconfiguration", capabilities: [] },
        availableResources: [],
        executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
        runner: {
          runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
          runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
        },
        businessInput: { kind: "direct_agent_message" },
      });

    const agentVersionSha256 = "a".repeat(64);
    const version = compileDirect("wrs_agentversionfreeze1", [
      {
        kind: "node_config",
        definitionNodeId: "direct.agent",
        field: "agentPromptOverride",
        value: "历史Workflow遗留Prompt，不得覆盖显式Agent Version。",
      },
      {
        kind: "agent_configuration",
        definitionNodeId: "direct.agent",
        configurationMode: "version",
        agentVersionId: "avn_agentversionfreeze1",
        agentVersionSha256,
      },
    ]);
    expect(version.success).toBe(true);
    if (!version.success) return;
    expect(version.runSpec.nodeResolutions[0]?.config).toEqual({
      capabilityMode: "custom",
      promptReviewMode: "manual",
      agentVersionId: "avn_agentversionfreeze1",
      agentVersionSha256,
    });

    const versionBoundRoot = structuredClone(direct.revision.semanticRoot);
    const versionBoundNode = versionBoundRoot.elements[0];
    if (versionBoundNode?.kind !== "composite") throw new Error("Direct fixture缺少Agent节点");
    versionBoundNode.config = {
      ...versionBoundNode.config,
      capabilityMode: "custom",
      agentVersionId: "avn_agentversionfreeze1",
      agentVersionSha256,
    };
    const versionPromptOverride = compileWorkflowRunSpec({
      workflowRunSpecId: "wrs_agentversionpromptmix1",
      productRunId: "run_agentversionpromptmix1",
      createdAt,
      definition: {
        schemaVersion: "workflow-definition-revision-input.v1",
        workflowDefinitionRevisionId: direct.revision.workflowDefinitionRevisionId,
        definitionRevision: direct.revision.definitionRevision,
        blueprintKey: direct.revision.blueprintKey,
        blueprintVersion: direct.revision.blueprintVersion,
        semanticRoot: versionBoundRoot,
      },
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "node_config",
            definitionNodeId: "direct.agent",
            field: "agentPromptOverride",
            value: "不能替换已发布Version的System Prompt。",
          },
        ],
      },
      principal: { principalId: "usr_agentconfiguration", capabilities: [] },
      availableResources: [],
      executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
      runner: {
        runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
        runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      },
      businessInput: { kind: "direct_agent_message" },
    });
    expect(versionPromptOverride.success).toBe(false);
    if (!versionPromptOverride.success) {
      expect(versionPromptOverride.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
        "run_configuration.node_config_invalid",
      );
    }

    const temporaryConfiguration = {
      runtime: { kind: "pi_coding_agent", baseVariantKey: "pi_cli_default" },
      systemPrompt: { mode: "replace", bodyMarkdown: "只对本次Run生效的Agent身份。" },
      enabledToolNames: ["read", "bash"],
      resources: {
        contextFiles: "disabled",
        skills: "inherit_runtime_default",
        promptTemplates: "disabled",
        extensions: "inherit_runtime_default",
      },
      basedOnVersionId: "avn_agentversionfreeze1",
      basedOnVersionSha256: agentVersionSha256,
    } as const;
    const temporary = compileDirect("wrs_agenttemporary1", [
      {
        kind: "agent_configuration",
        definitionNodeId: "direct.agent",
        configurationMode: "temporary",
        ...temporaryConfiguration,
      },
    ]);
    expect(temporary.success).toBe(true);
    if (!temporary.success) return;
    expect(temporary.runSpec.nodeResolutions[0]?.config).toEqual({
      capabilityMode: "custom",
      promptReviewMode: "manual",
      enabledToolNames: temporaryConfiguration.enabledToolNames,
      resourcePolicy: temporaryConfiguration.resources,
      agentTemporaryConfiguration: temporaryConfiguration,
    });

    const ambiguousRoot = structuredClone(direct.revision.semanticRoot);
    const ambiguousNode = ambiguousRoot.elements[0];
    if (ambiguousNode?.kind !== "composite") throw new Error("Direct fixture缺少Agent节点");
    ambiguousNode.config = {
      ...ambiguousNode.config,
      capabilityMode: "custom",
      agentVersionId: "avn_agentversionfreeze1",
      agentVersionSha256,
      agentTemporaryConfiguration: temporaryConfiguration,
    };
    const ambiguous = compileWorkflowRunSpec({
      workflowRunSpecId: "wrs_agentambiguous1",
      productRunId: "run_agentambiguous1",
      createdAt,
      definition: {
        schemaVersion: "workflow-definition-revision-input.v1",
        workflowDefinitionRevisionId: direct.revision.workflowDefinitionRevisionId,
        definitionRevision: direct.revision.definitionRevision,
        blueprintKey: direct.revision.blueprintKey,
        blueprintVersion: direct.revision.blueprintVersion,
        semanticRoot: ambiguousRoot,
      },
      runConfiguration: { schemaVersion: "workflow-run-configuration.v1", overrides: [] },
      principal: { principalId: "usr_agentconfiguration", capabilities: [] },
      availableResources: [],
      executorManifest: BUILTIN_WORKFLOW_EXECUTOR_MANIFEST,
      runner: {
        runnerFamily: DIRECT_AGENT_RUNNER_FAMILY,
        runnerBundleVersion: DIRECT_AGENT_RUNNER_BUNDLE_VERSION,
      },
      businessInput: { kind: "direct_agent_message" },
    });
    expect(ambiguous.success).toBe(false);
    if (ambiguous.success) return;
    expect(ambiguous.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "agent.configuration_ambiguous",
    );

    const invalidTarget = compileWorkflowRunSpec(
      kernelCompilerInputFixture("composite", {
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "agent_configuration",
              definitionNodeId: "planning.plan",
              configurationMode: "version",
              agentVersionId: "avn_agentversionfreeze1",
              agentVersionSha256,
            },
          ],
        },
      }),
    );
    expect(invalidTarget.success).toBe(false);
    if (invalidTarget.success) return;
    expect(invalidTarget.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "run_configuration.override_not_allowed",
    );
  });

  it("Direct Blueprint拒绝复制固定节点，并允许独立Workflow关闭审核Hook", () => {
    const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get("direct", 1);
    if (blueprint === undefined) throw new Error("Direct Blueprint不存在");
    const root = systemDirectAgentSemanticRoot();
    const duplicated: WorkflowSequence = {
      ...root,
      elements: [
        ...root.elements,
        {
          kind: "composite",
          definitionNodeId: "direct.agent.second",
          nodeType: "agent.direct",
          schemaVersion: 1,
          config: { capabilityMode: "read_only", promptReviewMode: "manual" },
        },
      ],
    };
    expect(
      validateDefinitionAgainstBlueprint(duplicated, blueprint, DEFAULT_NODE_CATALOG).map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("blueprint.required_role_mismatch");

    const directNode = root.elements[0];
    if (directNode?.kind !== "composite") throw new Error("Direct节点缺失");
    const automatic: WorkflowSequence = {
      kind: "sequence",
      elements: [
        {
          ...directNode,
          config: { capabilityMode: "read_only", promptReviewMode: "off" },
        },
      ],
    };
    expect(validateDefinitionAgainstBlueprint(automatic, blueprint, DEFAULT_NODE_CATALOG)).toEqual(
      [],
    );
  });

  it("Planning发布定义不能把强制人工审核配置成自动继续", () => {
    const root: WorkflowSequence = {
      ...PLANNING_LOOP_ROOT,
      elements: PLANNING_LOOP_ROOT.elements.map((element) =>
        element.kind !== "bounded_loop"
          ? element
          : {
              ...element,
              body: {
                ...element.body,
                elements: element.body.elements.map((child) =>
                  child.kind === "task" && child.nodeType === "human.plan_review"
                    ? { ...child, config: { reviewMode: "auto_continue_if_policy_allows" } }
                    : child,
                ),
              },
            },
      ),
    };
    const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get("planning", 1);
    if (blueprint === undefined) throw new Error("Planning Blueprint不存在");
    expect(
      validateDefinitionAgainstBlueprint(root, blueprint, DEFAULT_NODE_CATALOG).map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("blueprint.mandatory_manual_review");
  });

  it("普通Planning与Memory增强Planning是两个独立发布定义，普通流程绝不含Memory节点", () => {
    const createdAt = "2026-08-18T00:00:00.000Z";
    const ordinary = createSystemPlanningDefinition(createdAt);
    const memory = createSystemMemoryPlanningDefinition(createdAt);
    const taskTypes = (root: WorkflowSequence) => {
      const types: string[] = [];
      const visit = (sequence: WorkflowSequence): void => {
        for (const element of sequence.elements) {
          if (element.kind === "task") types.push(element.nodeType);
          else if (element.kind === "bounded_loop") visit(element.body);
        }
      };
      visit(root);
      return types;
    };

    expect(ordinary.definition.workflowDefinitionId).not.toBe(
      memory.definition.workflowDefinitionId,
    );
    expect(ordinary.definition.key).toBe("system.planning");
    expect(memory.definition.key).toBe("system.memory-planning");
    expect(taskTypes(ordinary.revision.semanticRoot)).not.toContain("memory.query");
    expect(taskTypes(ordinary.revision.semanticRoot)).not.toContain("memory.write");
    expect(taskTypes(memory.revision.semanticRoot)).toEqual(
      expect.arrayContaining(["memory.query", "memory.write"]),
    );
    expect(ordinary.view.nodes.map((node) => node.nodeType)).not.toContain("memory.query");
    expect(memory.view.nodes.map((node) => node.nodeType)).toEqual(
      expect.arrayContaining(["memory.query", "memory.write"]),
    );
  });
});

describe("Definition规范化与RunSpec Compiler", () => {
  it.each(fixtureKeys)("%s Fixture完整编译并通过自身Hash校验", (key) => {
    const result = compileWorkflowRunSpec(kernelCompilerInputFixture(key));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(validateWorkflowRunSpecIntegrity(result.runSpec)).toEqual({
      success: true,
      runSpec: result.runSpec,
    });
  });

  it("不同对象键顺序与Choice分支顺序得到相同Definition/RunSpec Hash", () => {
    const first = kernelCompilerInputFixture("choice");
    const original = kernelDefinitionFixture("choice");
    const choice = original.semanticRoot.elements[2];
    if (choice?.kind !== "choice") throw new Error("Fixture错误");
    const reordered = {
      ...original,
      semanticRoot: {
        kind: "sequence" as const,
        elements: [
          ...original.semanticRoot.elements.slice(0, 2),
          { ...choice, branches: [...choice.branches].reverse() },
          ...original.semanticRoot.elements.slice(3),
        ],
      },
    };
    const second = kernelCompilerInputFixture("choice", { definition: reordered });
    const compiledFirst = compileWorkflowRunSpec(first);
    const compiledSecond = compileWorkflowRunSpec(second);
    expect(compiledFirst.success && compiledSecond.success).toBe(true);
    if (!compiledFirst.success || !compiledSecond.success) return;
    expect(compiledFirst.runSpec.definitionRef.definitionSha256).toBe(
      compiledSecond.runSpec.definitionRef.definitionSha256,
    );
    expect(compiledFirst.runSpec.sha256).toBe(compiledSecond.runSpec.sha256);
  });

  it("Node config变化改变Definition Hash；资源变化只改变RunSpec Hash", () => {
    const base = compileWorkflowRunSpec(kernelCompilerInputFixture("sequence"));
    const originalDefinition = kernelDefinitionFixture("sequence");
    const extract = originalDefinition.semanticRoot.elements[0];
    if (extract?.kind !== "task") throw new Error("Fixture错误");
    const changedDefinition = {
      ...originalDefinition,
      semanticRoot: {
        kind: "sequence" as const,
        elements: [
          { ...extract, config: { maxCharacters: 5_000 } },
          ...originalDefinition.semanticRoot.elements.slice(1),
        ],
      },
    };
    const changed = compileWorkflowRunSpec(
      kernelCompilerInputFixture("sequence", { definition: changedDefinition }),
    );
    expect(base.success && changed.success).toBe(true);
    if (!base.success || !changed.success) return;
    expect(changed.runSpec.definitionRef.definitionSha256).not.toBe(
      base.runSpec.definitionRef.definitionSha256,
    );

    const mixedBase = compileWorkflowRunSpec(kernelCompilerInputFixture("mixed"));
    const resource = {
      resourceKind: "memory" as const,
      resourceId: "mrs_selected1",
      revision: 1,
      sha256: "a".repeat(64),
      status: "active" as const,
      allowedPrincipalIds: ["usr_fixture"],
    };
    const selected = compileWorkflowRunSpec(
      kernelCompilerInputFixture("mixed", {
        availableResources: [resource],
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "resource_selection",
              definitionNodeId: "planning.memory",
              resourceKind: "memory",
              required: false,
              selections: [
                {
                  resourceId: resource.resourceId,
                  expectedRevision: resource.revision,
                  expectedSha256: resource.sha256,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(mixedBase.success && selected.success).toBe(true);
    if (!mixedBase.success || !selected.success) return;
    expect(selected.runSpec.definitionRef.definitionSha256).toBe(
      mixedBase.runSpec.definitionRef.definitionSha256,
    );
    expect(selected.runSpec.sha256).not.toBe(mixedBase.runSpec.sha256);
  });

  it("optional资源形成显式exclusion，required资源失败关闭", () => {
    const optional = compileWorkflowRunSpec(kernelCompilerInputFixture("mixed"));
    expect(optional.success).toBe(true);
    if (!optional.success) return;
    expect(
      optional.runSpec.resourceResolutions.filter(
        (resolution) =>
          resolution.resolution === "excluded" && resolution.exclusionReason === "not_selected",
      ),
    ).toHaveLength(4);

    const originalDefinition = kernelDefinitionFixture("mixed");
    const memory = originalDefinition.semanticRoot.elements[0];
    if (memory?.kind !== "task") throw new Error("Fixture错误");
    const requiredDefinition = {
      ...originalDefinition,
      semanticRoot: {
        kind: "sequence" as const,
        elements: [
          { ...memory, config: { required: true } },
          ...originalDefinition.semanticRoot.elements.slice(1),
        ],
      },
    };
    const required = compileWorkflowRunSpec(
      kernelCompilerInputFixture("mixed", { definition: requiredDefinition }),
    );
    expect(required.success).toBe(false);
    if (required.success) return;
    expect(required.diagnostics.map((entry) => entry.code)).toContain(
      "resource.required_selection_missing",
    );
  });

  it("Note审核只有具备能力并绑定精确Policy ref时才能system_policy自动继续", () => {
    const policy = {
      resourceKind: "rule" as const,
      resourceId: "rul_autoreview1",
      revision: 3,
      sha256: "b".repeat(64),
      status: "active" as const,
      allowedPrincipalIds: ["usr_fixture"],
    };
    const input = kernelCompilerInputFixture("human_review", {
      principal: {
        principalId: "usr_fixture",
        capabilities: ["workflow.review.auto"],
      },
      availableResources: [policy],
      autoContinuePolicy: {
        resourceId: policy.resourceId,
        expectedRevision: policy.revision,
        expectedSha256: policy.sha256,
      },
      runConfiguration: {
        schemaVersion: "workflow-run-configuration.v1",
        overrides: [
          {
            kind: "review_mode",
            definitionNodeId: "note.review",
            reviewMode: "auto_continue_if_policy_allows",
          },
        ],
      },
    });
    const allowed = compileWorkflowRunSpec(input);
    expect(allowed.success).toBe(true);
    if (!allowed.success) return;
    expect(allowed.runSpec.reviewResolutions[0]).toMatchObject({
      actor: "system_policy",
      policyRef: { resourceId: policy.resourceId, revision: 3 },
    });
    const denied = compileWorkflowRunSpec({
      ...input,
      principal: { principalId: "usr_fixture", capabilities: [] },
    });
    expect(denied.success).toBe(false);
    if (!denied.success) expect(denied.diagnostics[0]?.code).toBe("policy.auto_continue_denied");
  });

  it("RunSpec篡改Hash/预算失败，创建事务能发现资源并发漂移", () => {
    const resource = {
      resourceKind: "memory" as const,
      resourceId: "mrs_concurrent1",
      revision: 1,
      sha256: "c".repeat(64),
      status: "active" as const,
      allowedPrincipalIds: ["usr_fixture"],
    };
    const compiled = compileWorkflowRunSpec(
      kernelCompilerInputFixture("mixed", {
        availableResources: [resource],
        runConfiguration: {
          schemaVersion: "workflow-run-configuration.v1",
          overrides: [
            {
              kind: "resource_selection",
              definitionNodeId: "planning.memory",
              resourceKind: "memory",
              required: true,
              selections: [
                {
                  resourceId: resource.resourceId,
                  expectedRevision: 1,
                  expectedSha256: resource.sha256,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(compiled.success).toBe(true);
    if (!compiled.success) return;
    const tampered = structuredClone(compiled.runSpec);
    tampered.limits.runtime.maxNodeExecutions += 1;
    expect(validateWorkflowRunSpecIntegrity(tampered)).toMatchObject({ success: false });
    expect(
      validateRunSpecResourcesCurrent(compiled.runSpec, [
        {
          ...resource,
          revision: 2,
          sha256: "d".repeat(64),
          allowedPrincipalIds: ["usr_fixture" as never],
        },
      ]).map((entry) => entry.code),
    ).toEqual(["resource.changed_before_run_create"]);
  });

  it("未知config字段、超深Definition和旧expected hash给稳定诊断", () => {
    const originalDefinition = kernelDefinitionFixture("sequence");
    const extract = originalDefinition.semanticRoot.elements[0];
    if (extract?.kind !== "task") throw new Error("Fixture错误");
    const badConfig = {
      ...originalDefinition,
      semanticRoot: {
        kind: "sequence" as const,
        elements: [
          { ...extract, config: { provider: "forbidden" } },
          ...originalDefinition.semanticRoot.elements.slice(1),
        ],
      },
    };
    const configResult = compileWorkflowRunSpec(
      kernelCompilerInputFixture("sequence", { definition: badConfig }),
    );
    expect(configResult.success).toBe(false);
    if (!configResult.success) {
      expect(configResult.diagnostics[0]?.code).toMatch(/^config\./);
    }

    let deep: WorkflowSequence = { kind: "sequence", elements: [] };
    for (let index = 0; index < 80; index += 1) {
      deep = { kind: "sequence", elements: [deep] };
    }
    const deepResult = compileWorkflowRunSpec(
      kernelCompilerInputFixture("sequence", {
        definition: {
          ...kernelDefinitionFixture("sequence"),
          semanticRoot: deep,
        },
      }),
    );
    expect(deepResult.success).toBe(false);
    if (!deepResult.success) expect(deepResult.diagnostics[0]?.code).toContain("depth");

    const staleDefinition = {
      ...kernelDefinitionFixture("sequence"),
      expectedSha256: hashCanonical("workflow-definition.v1", { wrong: true }),
    };
    const stale = compileWorkflowRunSpec(
      kernelCompilerInputFixture("sequence", { definition: staleDefinition }),
    );
    expect(stale.success).toBe(false);
    if (!stale.success) expect(stale.diagnostics[0]?.code).toBe("definition.hash_stale");
  });

  it("Planning可选业务节点当前只允许各出现一次，拒绝设计器复制出Runner无法表达的第二份Context", () => {
    const definition = kernelDefinitionFixture("mixed");
    const memory = definition.semanticRoot.elements[0];
    if (memory?.kind !== "task" || memory.nodeType !== "context.memory") {
      throw new Error("Fixture错误");
    }
    const duplicated = compileWorkflowRunSpec(
      kernelCompilerInputFixture("mixed", {
        definition: {
          ...definition,
          semanticRoot: {
            kind: "sequence",
            elements: [
              memory,
              {
                ...memory,
                definitionNodeId: "planning.memory.second",
                config: { ...memory.config },
              },
              ...definition.semanticRoot.elements.slice(1),
            ],
          },
        },
      }),
    );
    expect(duplicated.success).toBe(false);
    if (!duplicated.success) {
      expect(duplicated.diagnostics.map((item) => item.code)).toContain(
        "blueprint.optional_node_duplicated",
      );
    }
  });
});
