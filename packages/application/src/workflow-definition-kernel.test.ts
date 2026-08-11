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
import {
  compileWorkflowRunSpec,
  validateRunSpecResourcesCurrent,
  validateWorkflowRunSpecIntegrity,
} from "./workflow-run-spec-compiler.js";

const fixtureKeys = [
  "sequence",
  "choice",
  "bounded_loop",
  "human_review",
  "composite",
  "mixed",
] as const;

describe("Node Catalog与Blueprint一致性", () => {
  it("首批14种能力全部使用strict parser且默认配置/公开默认值一致", () => {
    expect(DEFAULT_NODE_CATALOG.list()).toHaveLength(14);
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

  it("Planning与Note Blueprint都能从权威Registry按版本读取", () => {
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("planning", 1)?.terminalNodeType).toBe("product.commit");
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("note", 1)?.terminalNodeType).toBe("note.commit");
    expect(DEFAULT_WORKFLOW_BLUEPRINTS.get("planning", 99)).toBeUndefined();
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
