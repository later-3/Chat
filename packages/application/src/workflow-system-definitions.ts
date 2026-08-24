import {
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  workflowViewDefinitionSchema,
  type WorkflowDefinition,
  type WorkflowDefinitionRevision,
  type WorkflowViewDefinition,
} from "@chat/contracts";
import {
  computeWorkflowViewDefinitionSha256,
  type WorkflowSequence,
  type WorkflowViewEdgeShape,
  type WorkflowViewNodeShape,
} from "@chat/domain";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import { normalizeWorkflowDefinition } from "./workflow-definition-normalize.js";

export const SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemplanningv1" as const;
export const LEGACY_SYSTEM_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemplanningv1" as const;
export const LEGACY_SYSTEM_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemplanningv1" as const;
export const SYSTEM_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemplanningv2" as const;
export const SYSTEM_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemplanningv2" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemsimpleplanningv1" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemsimpleplanningv1" as const;
export const SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemsimpleplanningv1" as const;
export const SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID = "wfd_systemmemoryplanningv1" as const;
export const SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID = "wfr_systemmemoryplanningv1" as const;
export const SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID = "wvd_systemmemoryplanningv1" as const;
export const SYSTEM_NOTE_WORKFLOW_DEFINITION_ID = "wfd_systemnotev1" as const;
export const SYSTEM_NOTE_WORKFLOW_REVISION_ID = "wfr_systemnotev1" as const;
export const SYSTEM_NOTE_WORKFLOW_VIEW_ID = "wvd_systemnotev1" as const;
export const SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID = "wfd_systemdirectagentv1" as const;
export const LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID = "wfr_systemdirectagentv1" as const;
export const LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID = "wvd_systemdirectagentv1" as const;
export const SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID = "wfr_systemdirectagentv2" as const;
export const SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID = "wvd_systemdirectagentv2" as const;
export const SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID = "wfd_systemmemorydirectv1" as const;
export const SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID = "wfr_systemmemorydirectv1" as const;
export const SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID = "wvd_systemmemorydirectv1" as const;
export const SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID =
  "wfd_systemmemoryagentdirectv1" as const;
export const SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID =
  "wfr_systemmemoryagentdirectv1" as const;
export const SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID = "wvd_systemmemoryagentdirectv1" as const;
export const SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID =
  "wfd_systemmemoryreaddirectv1" as const;
export const SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID =
  "wfr_systemmemoryreaddirectv1" as const;
export const SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID = "wvd_systemmemoryreaddirectv1" as const;
export const SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID =
  "wfd_systemmemorywritedirectv1" as const;
export const SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID =
  "wfr_systemmemorywritedirectv1" as const;
export const SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID = "wvd_systemmemorywritedirectv1" as const;
export const CONFIGURABLE_PLANNING_RUNNER_FAMILY = "configurable-planning.v1" as const;
export const CONFIGURABLE_PLANNING_RUNNER_BUNDLE_VERSION =
  "configurable-planning.bundle.v1" as const;
export const NOTE_CAPTURE_RUNNER_FAMILY = "note-capture.v1" as const;
export const NOTE_CAPTURE_RUNNER_BUNDLE_VERSION = "note-capture.bundle.v1" as const;
export const DIRECT_AGENT_RUNNER_FAMILY = "direct-agent.v1" as const;
export const DIRECT_AGENT_RUNNER_BUNDLE_VERSION = "direct-agent.bundle.v1" as const;
export const MEMORY_DIRECT_RUNNER_FAMILY = "memory-direct.v1" as const;
export const MEMORY_DIRECT_RUNNER_BUNDLE_VERSION = "memory-direct.bundle.v1" as const;
export const MEMORY_AGENT_DIRECT_RUNNER_FAMILY = "memory-agent-direct.v1" as const;
export const MEMORY_AGENT_DIRECT_RUNNER_BUNDLE_VERSION = "memory-agent-direct.bundle.v1" as const;
export const LEGACY_PLANNING_RUNNER_FAMILY = "legacy-planning.v1" as const;
export const LEGACY_PLANNING_RUNNER_BUNDLE_VERSION = "legacy-planning.bundle.v1" as const;

/**
 * 已退役的系统Definition只为历史Run、迁移与证据解析保留稳定身份。
 * 它们不得再进入公开目录；底层身份继续支持历史恢复与兼容调用。
 */
export const RETIRED_SYSTEM_WORKFLOW_DEFINITION_IDS = new Set<string>([
  SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
  SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
]);

export function systemPlanningSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("planning.memory", "context.memory"),
      systemTask("planning.project", "context.project"),
      systemTask("planning.rules", "policy.rules"),
      systemTask("planning.skills", "capability.skills"),
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("planning.plan", "agent.plan"),
            systemTask("planning.review", "human.plan_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail",
      },
      {
        kind: "composite",
        definitionNodeId: "planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: {},
      },
      systemTask("planning.validate", "result.validate"),
      systemTask("planning.commit", "product.commit"),
    ],
  };
}

/** 当前常规对话使用的最小Planning流程；不声明任何Memory或其他可选资源节点。 */
export function systemSimplePlanningSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("planning.plan", "agent.plan"),
            systemTask("planning.review", "human.plan_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail",
      },
      {
        kind: "composite",
        definitionNodeId: "planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: {},
      },
      systemTask("planning.validate", "result.validate"),
      systemTask("planning.commit", "product.commit"),
    ],
  };
}

/** Memory增强流程是独立发布的选择项，绝不修改或隐式包裹常规Simple Planning。 */
export function systemMemoryPlanningSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("memory-planning.query", "memory.query", {
        providerId: "mbk_tencentmemorycore",
        required: true,
        querySource: "source_message",
        maxResults: 8,
        maxContextCharacters: 8_000,
      }),
      systemTask("memory-planning.write", "memory.write", {
        providerId: "mbk_tencentmemorycore",
        source: "source_message",
        contentType: "conversation_turn",
      }),
      systemTask("memory-planning.project", "context.project"),
      systemTask("memory-planning.rules", "policy.rules"),
      systemTask("memory-planning.skills", "capability.skills"),
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("memory-planning.plan", "agent.plan"),
            systemTask("memory-planning.review", "human.plan_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "memory-planning.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 5,
        exceededPolicy: "fail",
      },
      {
        kind: "composite",
        definitionNodeId: "memory-planning.execute",
        nodeType: "execute.plan",
        schemaVersion: 1,
        config: {},
      },
      systemTask("memory-planning.validate", "result.validate"),
      systemTask("memory-planning.commit", "product.commit"),
    ],
  };
}

export function systemNoteSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "bounded_loop",
        body: {
          kind: "sequence",
          elements: [
            systemTask("note.extract", "note.extract"),
            systemTask("note.classify", "note.classify"),
            systemTask("note.review", "human.note_review"),
          ],
        },
        outcomeFromDefinitionNodeId: "note.review",
        continueOutcomes: ["request_revision"],
        exitOutcomes: ["approved", "rejected"],
        maxIterations: 2,
        exceededPolicy: "fail",
      },
      systemTask("note.commit", "note.commit"),
    ],
  };
}

/** Direct Execution Agent只有一个业务节点；Prompt Review是节点内部可选Provider Gate。 */
export function systemDirectAgentSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
    ],
  };
}

/** 独立Memory Direct只增加查询和写回，不修改或包裹现有Direct Definition。 */
export function systemMemoryDirectSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("memory-direct.query", "memory.query", {
        providerId: "mbk_memmy",
        required: true,
        querySource: "source_message",
        maxResults: 8,
        maxContextCharacters: 8_000,
      }),
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
      systemTask(
        "memory-direct.write",
        "memory.write",
        {
          providerId: "mbk_memmy",
          source: "source_message",
          contentType: "conversation_turn",
          required: false,
        },
        2,
      ),
    ],
  };
}

/**
 * Agent化Memory流程独立发布：检索Agent只采用Provider原始结果引用；写入Agent只形成
 * 待审核候选。它不会替换Direct@1，也不会改变直接Query/Write的Direct@2。
 */
export function systemMemoryAgentDirectSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("memory-agent.retrieve", "agent.memory_retrieve", {
        providerId: "mbk_memmy",
        required: true,
        maxResults: 8,
        maxContextCharacters: 8_000,
      }),
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
      systemTask("memory-agent.write", "agent.memory_write", {
        providerId: "mbk_memmy",
        required: false,
        maxSourceMessages: 20,
        maxItems: 6,
        reviewMode: "manual",
      }),
    ],
  };
}

/** 只读取并筛选Memory，随后把冻结上下文交给Direct Agent；本流程没有任何Memory写入。 */
export function systemMemoryReadDirectSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      systemTask("memory-agent.retrieve", "agent.memory_retrieve", {
        providerId: "mbk_memmy",
        required: true,
        maxResults: 8,
        maxContextCharacters: 8_000,
      }),
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
    ],
  };
}

/** 先完成当前回答，再只生成待审核Memory候选；本流程不会在回答前查询Memory。 */
export function systemMemoryWriteDirectSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "pi_cli_default", promptReviewMode: "manual" },
      },
      systemTask("memory-agent.write", "agent.memory_write", {
        providerId: "mbk_memmy",
        required: false,
        maxSourceMessages: 20,
        maxItems: 6,
        reviewMode: "manual",
      }),
    ],
  };
}

/** 只为v13-v17历史迁移与旧Run回放保留；新会话不得再把它当默认Agent。 */
export function legacySystemDirectAgentSemanticRoot(): WorkflowSequence {
  return {
    kind: "sequence",
    elements: [
      {
        kind: "composite",
        definitionNodeId: "direct.agent",
        nodeType: "agent.direct",
        schemaVersion: 1,
        config: { capabilityMode: "read_only", promptReviewMode: "manual" },
      },
    ],
  };
}

export function createSystemPlanningDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemPlanningSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system planning definition invalid:${normalized.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.planning",
    title: "默认规划工作流",
    description: "读取上下文、生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 2,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemPlanningWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemSimplePlanningDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemSimplePlanningSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system simple planning definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.simple-planning",
    title: "规划执行工作流",
    description: "生成计划、人工审核、执行、验证并提交结果的系统内置流程。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemSimplePlanningWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemMemoryPlanningDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemMemoryPlanningSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system memory planning definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.memory-planning",
    title: "Memory 增强规划与执行",
    description: "显式查询既有记忆、保存本次用户输入，再规划、审核、执行并提交结果。",
    blueprintKey: "planning",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "planning",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemMemoryPlanningWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemNoteDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(systemNoteSemanticRoot(), DEFAULT_NODE_CATALOG);
  if (!normalized.success) {
    throw new Error(
      `system note definition invalid:${normalized.diagnostics.map((item) => item.code).join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.note-capture",
    title: "默认笔记工作流",
    description: "从本次消息或选区抽取笔记、分类、人工审核并保存为正式Note。",
    blueprintKey: "note",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_NOTE_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_NOTE_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "note",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemNoteWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemDirectAgentDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemDirectAgentSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system direct agent definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.direct-agent",
    title: "执行 Agent（逐次提示词审核）",
    description: "单节点推进Pi AgentSession，并在每次Provider请求发送前进入节点内人工审核。",
    blueprintKey: "direct",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    revision: 2,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 2,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemDirectAgentWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemMemoryDirectDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemMemoryDirectSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system memory direct definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.memory-direct",
    title: "Memory 增强执行 Agent",
    description: "先查询并冻结相关记忆，再执行Direct Agent，成功后按配置写回本次输入。",
    blueprintKey: "direct",
    blueprintVersion: 2,
    status: "active",
    publishedRevisionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 2,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemMemoryDirectWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemMemoryAgentDirectDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemMemoryAgentDirectSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system memory agent direct definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.memory-agent-direct",
    title: "Memory Agent 增强执行",
    description: "检索Agent筛选上下文，执行Agent完成任务，写入Agent生成待人工采用的记忆候选。",
    blueprintKey: "direct",
    blueprintVersion: 3,
    status: "active",
    publishedRevisionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 3,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemMemoryAgentDirectWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemMemoryReadDirectDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemMemoryReadDirectSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system memory read direct definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.memory-read-direct",
    title: "只查询 Memory 后回答",
    description: "Memory检索Agent筛选相关记忆，执行Agent使用冻结上下文回答；不会写入Memory。",
    blueprintKey: "direct",
    blueprintVersion: 4,
    status: "active",
    publishedRevisionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 4,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemMemoryReadDirectWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createSystemMemoryWriteDirectDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    systemMemoryWriteDirectSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) {
    throw new Error(
      `system memory write direct definition invalid:${normalized.diagnostics
        .map((item) => item.code)
        .join(",")}`,
    );
  }
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.memory-write-direct",
    title: "只整理为 Memory 候选",
    description: "执行Agent完成当前回答，写入Agent只生成待审核候选；批准后才写入Memory。",
    blueprintKey: "direct",
    blueprintVersion: 5,
    status: "active",
    publishedRevisionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 5,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemMemoryWriteDirectWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
    }),
  };
}

export function createLegacySystemDirectAgentDefinition(createdAt: string): {
  readonly definition: WorkflowDefinition;
  readonly revision: WorkflowDefinitionRevision;
  readonly view: WorkflowViewDefinition;
} {
  const normalized = normalizeWorkflowDefinition(
    legacySystemDirectAgentSemanticRoot(),
    DEFAULT_NODE_CATALOG,
  );
  if (!normalized.success) throw new Error("legacy system direct agent definition invalid");
  const definition = workflowDefinitionSchema.parse({
    schemaVersion: "workflow-definition.v1",
    workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
    ownerKind: "system",
    key: "system.direct-agent",
    title: "执行 Agent（逐次提示词审核）",
    description: "单节点推进Pi AgentSession，并在每次Provider请求发送前进入节点内人工审核。",
    blueprintKey: "direct",
    blueprintVersion: 1,
    status: "active",
    publishedRevisionId: LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
  });
  const revision = workflowDefinitionRevisionSchema.parse({
    schemaVersion: "workflow-definition-revision.v1",
    workflowDefinitionRevisionId: LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_REVISION_ID,
    workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
    definitionRevision: 1,
    state: "published",
    blueprintKey: "direct",
    blueprintVersion: 1,
    title: definition.title,
    semanticRoot: normalized.normalized.semanticRoot,
    definitionSha256: normalized.normalized.definitionSha256,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    publishedAt: createdAt,
  });
  return {
    definition,
    revision,
    view: createSystemDirectAgentWorkflowView({
      createdAt,
      definitionSha256: revision.definitionSha256,
      legacy: true,
    }),
  };
}

function createSystemPlanningWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("planning.memory", "context.memory", "读取记忆", "task", true),
    viewNode("planning.project", "context.project", "读取项目上下文", "task", true),
    viewNode("planning.rules", "policy.rules", "解析规则", "task", true),
    viewNode("planning.skills", "capability.skills", "解析技能", "task", true),
    viewNode("planning.plan", "agent.plan", "生成计划", "task", false),
    viewNode("planning.review", "human.plan_review", "审核计划", "human_review", false),
    viewNode("planning.execute", "execute.plan", "执行计划", "composite", false),
    viewNode("planning.validate", "result.validate", "验证结果", "task", false),
    viewNode("planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("planning.memory", "planning.project", "control"),
    edge("planning.project", "planning.rules", "control"),
    edge("planning.rules", "planning.skills", "control"),
    edge("planning.skills", "planning.plan", "control"),
    edge("planning.plan", "planning.review", "control"),
    edge("planning.review", "planning.plan", "loop_back", "request_revision"),
    edge("planning.review", "planning.execute", "outcome", "approved"),
    edge("planning.execute", "planning.validate", "control"),
    edge("planning.validate", "planning.commit", "control"),
  ];
  const content = {
    title: "默认规划工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_PLANNING_WORKFLOW_DEFINITION_ID,
      definitionRevision: 2,
      definitionSha256: input.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemSimplePlanningWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("planning.plan", "agent.plan", "生成计划", "task", false),
    viewNode("planning.review", "human.plan_review", "审核计划", "human_review", false),
    viewNode("planning.execute", "execute.plan", "执行计划", "composite", false),
    viewNode("planning.validate", "result.validate", "验证结果", "task", false),
    viewNode("planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("planning.plan", "planning.review", "control"),
    edge("planning.review", "planning.plan", "loop_back", "request_revision"),
    edge("planning.review", "planning.execute", "outcome", "approved"),
    edge("planning.execute", "planning.validate", "control"),
    edge("planning.validate", "planning.commit", "control"),
  ];
  const content = {
    title: "规划执行工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_SIMPLE_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemMemoryPlanningWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("memory-planning.query", "memory.query", "查询记忆", "task", false),
    viewNode("memory-planning.write", "memory.write", "保存本次输入", "task", false),
    viewNode("memory-planning.project", "context.project", "读取项目上下文", "task", true),
    viewNode("memory-planning.rules", "policy.rules", "解析规则", "task", true),
    viewNode("memory-planning.skills", "capability.skills", "解析技能", "task", true),
    viewNode("memory-planning.plan", "agent.plan", "生成计划", "task", false),
    viewNode("memory-planning.review", "human.plan_review", "审核计划", "human_review", false),
    viewNode("memory-planning.execute", "execute.plan", "执行计划", "composite", false),
    viewNode("memory-planning.validate", "result.validate", "验证结果", "task", false),
    viewNode("memory-planning.commit", "product.commit", "提交结果", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("memory-planning.query", "memory-planning.write", "control"),
    edge("memory-planning.write", "memory-planning.project", "control"),
    edge("memory-planning.project", "memory-planning.rules", "control"),
    edge("memory-planning.rules", "memory-planning.skills", "control"),
    edge("memory-planning.skills", "memory-planning.plan", "control"),
    edge("memory-planning.plan", "memory-planning.review", "control"),
    edge("memory-planning.review", "memory-planning.plan", "loop_back", "request_revision"),
    edge("memory-planning.review", "memory-planning.execute", "outcome", "approved"),
    edge("memory-planning.execute", "memory-planning.validate", "control"),
    edge("memory-planning.validate", "memory-planning.commit", "control"),
  ];
  const content = {
    title: "Memory 增强规划与执行",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "planning",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_MEMORY_PLANNING_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemNoteWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("note.extract", "note.extract", "提取笔记", "task", false),
    viewNode("note.classify", "note.classify", "分类笔记", "task", false),
    viewNode("note.review", "human.note_review", "审核笔记", "human_review", true),
    viewNode("note.commit", "note.commit", "保存笔记", "product_commit", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("note.extract", "note.classify", "control"),
    edge("note.classify", "note.review", "control"),
    edge("note.review", "note.extract", "loop_back", "request_revision"),
    edge("note.review", "note.commit", "outcome", "approved"),
  ];
  const content = {
    title: "默认笔记工作流",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_NOTE_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "note",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_NOTE_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemDirectAgentWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
  readonly legacy?: boolean | undefined;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("direct.agent", "agent.direct", "执行 Agent · 提示词审核", "composite", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [];
  const content = {
    title: "执行 Agent（逐次提示词审核）",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_DIRECT_AGENT_WORKFLOW_DEFINITION_ID,
      definitionRevision: input.legacy === true ? 1 : 2,
      definitionSha256: input.definitionSha256,
      blueprintKey: "direct",
      blueprintVersion: "1",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId:
      input.legacy === true
        ? LEGACY_SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID
        : SYSTEM_DIRECT_AGENT_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemMemoryDirectWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("memory-direct.query", "memory.query", "查询并冻结记忆", "task", false),
    viewNode("direct.agent", "agent.direct", "执行 Agent · 提示词审核", "composite", false),
    viewNode("memory-direct.write", "memory.write", "写回本次输入", "task", false, "2"),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("memory-direct.query", "direct.agent", "control"),
    edge("direct.agent", "memory-direct.write", "control"),
  ];
  const content = {
    title: "Memory 增强执行 Agent",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "direct",
      blueprintVersion: "2",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_MEMORY_DIRECT_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemMemoryAgentDirectWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("memory-agent.retrieve", "agent.memory_retrieve", "Memory 检索 Agent", "task", false),
    viewNode("direct.agent", "agent.direct", "执行 Agent · 提示词审核", "composite", false),
    viewNode("memory-agent.write", "agent.memory_write", "Memory 写入候选 Agent", "task", false),
  ];
  const edges: readonly WorkflowViewEdgeShape[] = [
    edge("memory-agent.retrieve", "direct.agent", "control"),
    edge("direct.agent", "memory-agent.write", "control"),
  ];
  const content = {
    title: "Memory Agent 增强执行",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "direct",
      blueprintVersion: "3",
    },
    nodes,
    edges,
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_MEMORY_AGENT_DIRECT_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemMemoryReadDirectWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("memory-agent.retrieve", "agent.memory_retrieve", "查询并筛选 Memory", "task", false),
    viewNode("direct.agent", "agent.direct", "使用 Memory 回答", "composite", false),
  ];
  const content = {
    title: "只查询 Memory 后回答",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "direct",
      blueprintVersion: "4",
    },
    nodes,
    edges: [edge("memory-agent.retrieve", "direct.agent", "control")],
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_MEMORY_READ_DIRECT_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function createSystemMemoryWriteDirectWorkflowView(input: {
  readonly createdAt: string;
  readonly definitionSha256: string;
}): WorkflowViewDefinition {
  const nodes: readonly WorkflowViewNodeShape[] = [
    viewNode("direct.agent", "agent.direct", "完成当前回答", "composite", false),
    viewNode("memory-agent.write", "agent.memory_write", "整理待审核 Memory 候选", "task", false),
  ];
  const content = {
    title: "只整理为 Memory 候选",
    source: {
      kind: "published_definition" as const,
      workflowDefinitionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_DEFINITION_ID,
      definitionRevision: 1,
      definitionSha256: input.definitionSha256,
      blueprintKey: "direct",
      blueprintVersion: "5",
    },
    nodes,
    edges: [edge("direct.agent", "memory-agent.write", "control")],
  };
  return workflowViewDefinitionSchema.parse({
    schemaVersion: "workflow-view-definition.v1",
    workflowViewDefinitionId: SYSTEM_MEMORY_WRITE_DIRECT_WORKFLOW_VIEW_ID,
    ...content,
    sha256: computeWorkflowViewDefinitionSha256(content),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function viewNode(
  definitionNodeId: string,
  nodeType: string,
  title: string,
  kind: WorkflowViewNodeShape["kind"],
  optional: boolean,
  nodeSchemaVersion = "1",
): WorkflowViewNodeShape {
  return { definitionNodeId, nodeType, nodeSchemaVersion, title, kind, optional };
}

function edge(
  from: string,
  to: string,
  kind: WorkflowViewEdgeShape["kind"],
  outcomeCode?: string,
): WorkflowViewEdgeShape {
  return outcomeCode === undefined ? { from, to, kind } : { from, to, kind, outcomeCode };
}

function systemTask(
  definitionNodeId: string,
  nodeType:
    | "memory.query"
    | "memory.write"
    | "agent.memory_retrieve"
    | "agent.memory_write"
    | "context.memory"
    | "context.project"
    | "policy.rules"
    | "capability.skills"
    | "agent.research"
    | "agent.plan"
    | "human.plan_review"
    | "human.prompt_review"
    | "result.validate"
    | "product.commit"
    | "note.extract"
    | "note.classify"
    | "human.note_review"
    | "note.commit",
  config: Record<string, unknown> = {},
  schemaVersion: 1 | 2 = 1,
) {
  return { kind: "task" as const, definitionNodeId, nodeType, schemaVersion, config };
}
