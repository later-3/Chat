import {
  PRODUCT_API_SCHEMA_VERSION,
  workflowDefinitionCommandResultDtoSchema,
  workflowDefinitionDetailDtoSchema,
  workflowDefinitionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  workflowDefinitionValidationDtoSchema,
  type ChangeWorkflowDefinitionArchiveStatusPayload,
  type CreateWorkflowDefinitionCopyPayload,
  type PrincipalId,
  type ProductSnapshot,
  type PublishWorkflowDefinitionPayload,
  type SaveWorkflowDefinitionDraftPayload,
  type SaveWorkflowAgentNodeConfigurationPayload,
  type ValidateWorkflowDefinitionPayload,
  type WorkflowDefinition,
  type WorkflowDefinitionCommandResultDto,
  type WorkflowDefinitionDetailDto,
  type WorkflowDefinitionId,
  type WorkflowDefinitionRevision,
  type WorkflowDefinitionElement,
  type WorkflowDefinitionRevisionSummaryDto,
  type WorkflowDefinitionValidationDto,
} from "@chat/contracts";
import { hashCanonical, validateWorkflowStructure, type WorkflowDiagnostic } from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { DEFAULT_WORKFLOW_BLUEPRINTS } from "./workflow-blueprints.js";
import {
  deriveWorkflowDesignerPolicy,
  toWorkflowDesignerSlotDto,
} from "./workflow-designer-policy.js";
import { DEFAULT_NODE_CATALOG } from "./workflow-node-catalog.js";
import { validateDesignerRoot } from "./workflow-structure-operations.js";
import { createPublishedWorkflowView } from "./workflow-view-builder.js";
import { agentNodeBindingDescriptor } from "./prompt-assembly-use-cases.js";

type CommandId = Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];

export async function getWorkflowDefinitionDetail(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly workflowDefinitionId: WorkflowDefinitionId },
): Promise<WorkflowDefinitionDetailDto> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  return definitionDetail(snapshot, input.principalId, input.workflowDefinitionId);
}

export async function validateWorkflowDefinition(
  deps: ApplicationDeps,
  input: { readonly principalId: PrincipalId; readonly payload: ValidateWorkflowDefinitionPayload },
): Promise<WorkflowDefinitionValidationDto> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const base = requireReadableRevision(
    snapshot,
    input.principalId,
    input.payload.baseRevisionId,
    input.payload.baseDefinitionSha256,
  );
  if (
    (input.payload.workflowDefinitionId !== undefined &&
      input.payload.workflowDefinitionId !== base.workflowDefinitionId) ||
    input.payload.blueprintKey !== base.blueprintKey ||
    input.payload.blueprintVersion !== base.blueprintVersion
  ) {
    throw revisionConflict("Definition验证基线已变化");
  }
  return validationDto(input.payload.semanticRoot, base.blueprintKey, base.blueprintVersion);
}

export async function createWorkflowDefinitionCopy(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: CreateWorkflowDefinitionCopyPayload;
  },
): Promise<WorkflowDefinitionCommandResultDto> {
  const now = deps.now();
  const workflowDefinitionId = derivedDefinitionId(input.commandId);
  const workflowDefinitionRevisionId = derivedRevisionId(input.commandId, workflowDefinitionId);
  const requestSha256 = hashCanonical("command.copy-workflow-definition.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CopyWorkflowDefinition",
    requestSha256,
    traceContext: {},
    mutate: (draft) => {
      const source = requireReadableRevision(
        draft,
        input.principalId,
        input.payload.sourceWorkflowDefinitionRevisionId,
        input.payload.sourceDefinitionSha256,
      );
      if (source.state !== "published") {
        throw revisionConflict("只能复制已发布Workflow Definition");
      }
      const validated = validateDesignerRootFor(source.semanticRoot, source);
      if (!validated.success) throw invalidDefinition(validated.diagnostics);
      const definition = workflowDefinitionSchema.parse({
        schemaVersion: "workflow-definition.v1",
        workflowDefinitionId,
        ownerKind: "principal",
        ownerPrincipalId: input.principalId,
        key: `user.${hashCanonical("workflow-definition-key.v1", {
          workflowDefinitionId,
        }).slice(0, 20)}`,
        title: input.payload.title,
        description: input.payload.description,
        blueprintKey: source.blueprintKey,
        blueprintVersion: source.blueprintVersion,
        status: "active",
        currentDraftRevisionId: workflowDefinitionRevisionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      const revision = workflowDefinitionRevisionSchema.parse({
        schemaVersion: "workflow-definition-revision.v1",
        workflowDefinitionRevisionId,
        workflowDefinitionId,
        definitionRevision: 1,
        state: "draft",
        blueprintKey: source.blueprintKey,
        blueprintVersion: source.blueprintVersion,
        title: definition.title,
        semanticRoot: validated.semanticRoot,
        definitionSha256: validated.definitionSha256,
        basedOnRevisionId: source.workflowDefinitionRevisionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.workflowDefinitions[workflowDefinitionId] = definition;
      draft.entities.workflowDefinitionRevisions[workflowDefinitionRevisionId] = revision;
      return { resultRefs: { workflowDefinitionId, workflowDefinitionRevisionId } };
    },
  });
  return commandResult(deps, input.principalId, transaction.resultRefs);
}

export async function saveWorkflowAgentNodeConfiguration(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: SaveWorkflowAgentNodeConfigurationPayload;
  },
): Promise<WorkflowDefinitionCommandResultDto> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.save-workflow-agent-node-configuration.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SaveWorkflowAgentNodeConfiguration",
    requestSha256,
    traceContext: {},
    mutate: (draft) => {
      const source = requireReadableRevision(
        draft,
        input.principalId,
        input.payload.sourceWorkflowDefinitionRevisionId,
        input.payload.sourceDefinitionSha256,
      );
      if (source.state !== "published") {
        throw revisionConflict("只能配置已发布Workflow Definition");
      }
      const sourceDefinition = draft.entities.workflowDefinitions[source.workflowDefinitionId];
      if (sourceDefinition === undefined) throw notFound("Workflow Definition不存在");
      const semanticRoot = configureAgentNode(source.semanticRoot, input.payload);
      const validated = validateDesignerRootFor(semanticRoot, source);
      if (!validated.success) throw invalidDefinition(validated.diagnostics);

      const workflowDefinitionId =
        sourceDefinition.ownerKind === "system"
          ? workflowDefinitionIdSchema.parse(
              `wfd_${hashCanonical("id.workflow-agent-configured-definition.v1", {
                commandId: input.commandId,
              }).slice(0, 32)}`,
            )
          : source.workflowDefinitionId;
      const workflowDefinitionRevisionId = derivedRevisionId(input.commandId, workflowDefinitionId);
      const definitionRevision =
        sourceDefinition.ownerKind === "system"
          ? 1
          : nextDefinitionRevision(draft, workflowDefinitionId);
      const title =
        sourceDefinition.ownerKind === "system"
          ? `${source.title.slice(0, 152)} · 我的配置`
          : sourceDefinition.title;
      const revision = workflowDefinitionRevisionSchema.parse({
        schemaVersion: "workflow-definition-revision.v1",
        workflowDefinitionRevisionId,
        workflowDefinitionId,
        definitionRevision,
        state: "published",
        blueprintKey: source.blueprintKey,
        blueprintVersion: source.blueprintVersion,
        title,
        semanticRoot: validated.semanticRoot,
        definitionSha256: validated.definitionSha256,
        basedOnRevisionId: source.workflowDefinitionRevisionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        publishedAt: now,
      });

      if (sourceDefinition.ownerKind === "system") {
        draft.entities.workflowDefinitions[workflowDefinitionId] = workflowDefinitionSchema.parse({
          schemaVersion: "workflow-definition.v1",
          workflowDefinitionId,
          ownerKind: "principal",
          ownerPrincipalId: input.principalId,
          key: `user.${hashCanonical("workflow-definition-key.v1", {
            workflowDefinitionId,
          }).slice(0, 20)}`,
          title,
          description: sourceDefinition.description,
          blueprintKey: source.blueprintKey,
          blueprintVersion: source.blueprintVersion,
          status: "active",
          publishedRevisionId: workflowDefinitionRevisionId,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        });
      } else {
        const owned = requireOwnedDefinition(draft, input.principalId, workflowDefinitionId);
        if (
          owned.status !== "active" ||
          owned.publishedRevisionId !== source.workflowDefinitionRevisionId
        ) {
          throw revisionConflict("Workflow已变化，请刷新后重试");
        }
        if (owned.currentDraftRevisionId !== undefined) {
          throw revisionConflict("Workflow存在未发布草稿，请先处理草稿");
        }
        draft.entities.workflowDefinitionRevisions[source.workflowDefinitionRevisionId] =
          workflowDefinitionRevisionSchema.parse({
            ...source,
            state: "superseded",
            supersededAt: now,
            updatedAt: now,
          });
        draft.entities.workflowDefinitions[workflowDefinitionId] = workflowDefinitionSchema.parse({
          ...owned,
          publishedRevisionId: workflowDefinitionRevisionId,
          revision: owned.revision + 1,
          updatedAt: now,
        });
      }

      draft.entities.workflowDefinitionRevisions[workflowDefinitionRevisionId] = revision;
      const view = createPublishedWorkflowView({ revision, createdAt: now });
      draft.entities.workflowViewDefinitions[view.workflowViewDefinitionId] = view;
      return { resultRefs: { workflowDefinitionId, workflowDefinitionRevisionId } };
    },
  });
  return commandResult(deps, input.principalId, transaction.resultRefs);
}

function configureAgentNode(
  root: WorkflowDefinitionRevision["semanticRoot"],
  payload: SaveWorkflowAgentNodeConfigurationPayload,
): WorkflowDefinitionRevision["semanticRoot"] {
  let matches = 0;
  const visit = (element: WorkflowDefinitionElement): WorkflowDefinitionElement => {
    if (element.kind === "task" || element.kind === "composite") {
      if (element.definitionNodeId !== payload.definitionNodeId) return element;
      matches += 1;
      const supported = AGENT_NODE_SUPPORT[element.nodeType];
      if (supported === undefined || !supported.includes(payload.agentKey)) {
        throw revisionConflict(`Agent ${payload.agentKey}不支持节点${element.nodeType}`);
      }
      const currentBinding = agentNodeBindingDescriptor(
        element.nodeType as "agent.plan" | "agent.direct" | "execute.plan" | "note.extract",
        element.config,
      );
      const currentOverride =
        typeof element.config["agentPromptOverride"] === "string"
          ? element.config["agentPromptOverride"]
          : "";
      const requestedOverride = payload.promptOverrideMarkdown?.trim()
        ? payload.promptOverrideMarkdown
        : "";
      if (currentBinding.agentKey === payload.agentKey && currentOverride === requestedOverride) {
        throw revisionConflict("Workflow Agent节点配置没有变化");
      }
      const config: Record<string, unknown> = { ...element.config, agentKey: payload.agentKey };
      if (requestedOverride !== "") {
        config["agentPromptOverride"] = requestedOverride;
      } else {
        delete config["agentPromptOverride"];
      }
      return { ...element, config };
    }
    if (element.kind === "sequence") {
      return { ...element, elements: element.elements.map(visit) };
    }
    if (element.kind === "choice") {
      return {
        ...element,
        branches: element.branches.map((branch) => ({
          ...branch,
          body: visit(branch.body) as WorkflowDefinitionRevision["semanticRoot"],
        })),
      };
    }
    return {
      ...element,
      body: visit(element.body) as WorkflowDefinitionRevision["semanticRoot"],
    };
  };
  const semanticRoot = visit(root) as WorkflowDefinitionRevision["semanticRoot"];
  if (matches !== 1) throw notFound("Workflow Agent节点不存在");
  return semanticRoot;
}

const AGENT_NODE_SUPPORT: Readonly<Record<string, readonly string[]>> = {
  "agent.plan": ["planner"],
  "agent.direct": ["direct", "project_bootstrap"],
  "execute.plan": ["coding_executor"],
  "note.extract": ["note_extractor"],
};

export async function saveWorkflowDefinitionDraft(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly workflowDefinitionId: WorkflowDefinitionId;
    readonly expectedRevision: number;
    readonly payload: SaveWorkflowDefinitionDraftPayload;
  },
): Promise<WorkflowDefinitionCommandResultDto> {
  const now = deps.now();
  const nextRevisionId = derivedRevisionId(input.commandId, input.workflowDefinitionId);
  const requestSha256 = hashCanonical("command.save-workflow-definition-draft.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SaveWorkflowDefinitionDraft",
    requestSha256,
    traceContext: {},
    mutate: (draft) => {
      const definition = requireOwnedDefinition(
        draft,
        input.principalId,
        input.workflowDefinitionId,
      );
      if (definition.status !== "active") throw revisionConflict("归档Definition不能保存草稿");
      if (definition.revision !== input.expectedRevision) {
        throw revisionConflict("Workflow Definition revision已变化");
      }
      const base = requireEditableBase(
        draft,
        definition,
        input.payload.baseRevisionId,
        input.payload.baseDefinitionSha256,
      );
      const validated = validateDesignerRootFor(input.payload.semanticRoot, base);
      if (!validated.success) throw invalidDefinition(validated.diagnostics);
      const existingDraft =
        definition.currentDraftRevisionId === undefined
          ? undefined
          : draft.entities.workflowDefinitionRevisions[definition.currentDraftRevisionId];
      if (existingDraft !== undefined) {
        draft.entities.workflowDefinitionRevisions[existingDraft.workflowDefinitionRevisionId] =
          workflowDefinitionRevisionSchema.parse({
            ...existingDraft,
            state: "superseded",
            supersededAt: now,
            updatedAt: now,
          });
      }
      const definitionRevision = nextDefinitionRevision(draft, definition.workflowDefinitionId);
      const revision = workflowDefinitionRevisionSchema.parse({
        schemaVersion: "workflow-definition-revision.v1",
        workflowDefinitionRevisionId: nextRevisionId,
        workflowDefinitionId: definition.workflowDefinitionId,
        definitionRevision,
        state: "draft",
        blueprintKey: definition.blueprintKey,
        blueprintVersion: definition.blueprintVersion,
        title: definition.title,
        semanticRoot: validated.semanticRoot,
        definitionSha256: validated.definitionSha256,
        basedOnRevisionId: base.workflowDefinitionRevisionId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.workflowDefinitionRevisions[nextRevisionId] = revision;
      draft.entities.workflowDefinitions[definition.workflowDefinitionId] =
        workflowDefinitionSchema.parse({
          ...definition,
          currentDraftRevisionId: nextRevisionId,
          revision: definition.revision + 1,
          updatedAt: now,
        });
      return {
        resultRefs: {
          workflowDefinitionId: definition.workflowDefinitionId,
          workflowDefinitionRevisionId: nextRevisionId,
        },
      };
    },
  });
  return commandResult(deps, input.principalId, transaction.resultRefs);
}

export async function publishWorkflowDefinition(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly workflowDefinitionId: WorkflowDefinitionId;
    readonly expectedRevision: number;
    readonly payload: PublishWorkflowDefinitionPayload;
  },
): Promise<WorkflowDefinitionCommandResultDto> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.publish-workflow-definition.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PublishWorkflowDefinition",
    requestSha256,
    traceContext: {},
    mutate: (draft) => {
      const definition = requireOwnedDefinition(
        draft,
        input.principalId,
        input.workflowDefinitionId,
      );
      if (definition.status !== "active") throw revisionConflict("归档Definition不能发布");
      if (definition.revision !== input.expectedRevision) {
        throw revisionConflict("Workflow Definition revision已变化");
      }
      if (definition.currentDraftRevisionId !== input.payload.draftRevisionId) {
        throw revisionConflict("发布目标不是当前Draft");
      }
      const draftRevision =
        draft.entities.workflowDefinitionRevisions[input.payload.draftRevisionId];
      if (
        draftRevision === undefined ||
        draftRevision.workflowDefinitionId !== definition.workflowDefinitionId ||
        draftRevision.state !== "draft" ||
        draftRevision.definitionSha256 !== input.payload.draftDefinitionSha256
      ) {
        throw revisionConflict("Draft Revision或Hash已变化");
      }
      const validated = validateDesignerRootFor(draftRevision.semanticRoot, draftRevision);
      if (!validated.success || validated.definitionSha256 !== draftRevision.definitionSha256) {
        throw invalidDefinition(validated.success ? [] : validated.diagnostics);
      }
      if (definition.publishedRevisionId !== undefined) {
        const previous = draft.entities.workflowDefinitionRevisions[definition.publishedRevisionId];
        if (previous === undefined) throw notFound("Published Revision不存在");
        draft.entities.workflowDefinitionRevisions[previous.workflowDefinitionRevisionId] =
          workflowDefinitionRevisionSchema.parse({
            ...previous,
            state: "superseded",
            supersededAt: now,
            updatedAt: now,
          });
      }
      const published = workflowDefinitionRevisionSchema.parse({
        ...draftRevision,
        state: "published",
        publishedAt: now,
        updatedAt: now,
      });
      draft.entities.workflowDefinitionRevisions[published.workflowDefinitionRevisionId] =
        published;
      const updated = { ...definition };
      delete updated.currentDraftRevisionId;
      draft.entities.workflowDefinitions[definition.workflowDefinitionId] =
        workflowDefinitionSchema.parse({
          ...updated,
          publishedRevisionId: published.workflowDefinitionRevisionId,
          revision: definition.revision + 1,
          updatedAt: now,
        });
      const view = createPublishedWorkflowView({ revision: published, createdAt: now });
      const existingView = draft.entities.workflowViewDefinitions[view.workflowViewDefinitionId];
      if (existingView !== undefined && existingView.sha256 !== view.sha256) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "Published Workflow View身份冲突",
          recoveryAction: "contact_support",
        });
      }
      draft.entities.workflowViewDefinitions[view.workflowViewDefinitionId] = existingView ?? view;
      return {
        resultRefs: {
          workflowDefinitionId: definition.workflowDefinitionId,
          workflowDefinitionRevisionId: published.workflowDefinitionRevisionId,
        },
      };
    },
  });
  return commandResult(deps, input.principalId, transaction.resultRefs);
}

export async function changeWorkflowDefinitionArchiveStatus(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly workflowDefinitionId: WorkflowDefinitionId;
    readonly expectedRevision: number;
    readonly payload: ChangeWorkflowDefinitionArchiveStatusPayload;
  },
): Promise<WorkflowDefinitionCommandResultDto> {
  const now = deps.now();
  const requestSha256 = hashCanonical(
    "command.change-workflow-definition-archive-status.v1",
    input,
  );
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "ChangeWorkflowDefinitionArchiveStatus",
    requestSha256,
    traceContext: {},
    mutate: (draft) => {
      const definition = requireOwnedDefinition(
        draft,
        input.principalId,
        input.workflowDefinitionId,
      );
      if (definition.revision !== input.expectedRevision) {
        throw revisionConflict("Workflow Definition revision已变化");
      }
      const published =
        definition.publishedRevisionId === undefined
          ? undefined
          : draft.entities.workflowDefinitionRevisions[definition.publishedRevisionId];
      if (
        published === undefined ||
        published.workflowDefinitionRevisionId !== input.payload.publishedRevisionId ||
        published.definitionSha256 !== input.payload.publishedDefinitionSha256
      ) {
        throw revisionConflict("Published Revision或Hash已变化");
      }
      if (definition.status !== input.payload.targetStatus) {
        draft.entities.workflowDefinitions[definition.workflowDefinitionId] =
          workflowDefinitionSchema.parse({
            ...definition,
            status: input.payload.targetStatus,
            revision: definition.revision + 1,
            updatedAt: now,
          });
      }
      return {
        resultRefs: {
          workflowDefinitionId: definition.workflowDefinitionId,
          workflowDefinitionRevisionId: published.workflowDefinitionRevisionId,
        },
      };
    },
  });
  return commandResult(deps, input.principalId, transaction.resultRefs);
}

function requireReadableRevision(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
  revisionId: WorkflowDefinitionRevision["workflowDefinitionRevisionId"],
  expectedHash: string,
): WorkflowDefinitionRevision {
  const revision = snapshot.entities.workflowDefinitionRevisions[revisionId];
  if (revision === undefined) throw notFound("Workflow Definition Revision不存在");
  const definition = snapshot.entities.workflowDefinitions[revision.workflowDefinitionId];
  if (definition === undefined) throw notFound("Workflow Definition不存在");
  assertDefinitionReadable(definition, principalId);
  if (revision.definitionSha256 !== expectedHash) {
    throw revisionConflict("Workflow Definition Hash已变化");
  }
  return revision;
}

function requireOwnedDefinition(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
  definitionId: WorkflowDefinitionId,
): WorkflowDefinition {
  const definition = snapshot.entities.workflowDefinitions[definitionId];
  if (definition === undefined) throw notFound("Workflow Definition不存在");
  if (definition.ownerKind !== "principal" || definition.ownerPrincipalId !== principalId) {
    throw forbidden("System或其他用户的Definition不可编辑");
  }
  return definition;
}

function assertDefinitionReadable(definition: WorkflowDefinition, principalId: PrincipalId): void {
  if (definition.ownerKind === "principal" && definition.ownerPrincipalId !== principalId) {
    throw forbidden("无权读取该Workflow Definition");
  }
}

function requireEditableBase(
  snapshot: ProductSnapshot,
  definition: WorkflowDefinition,
  revisionId: WorkflowDefinitionRevision["workflowDefinitionRevisionId"],
  expectedHash: string,
): WorkflowDefinitionRevision {
  const allowed = new Set(
    [definition.currentDraftRevisionId, definition.publishedRevisionId].filter(
      (value): value is WorkflowDefinitionRevision["workflowDefinitionRevisionId"] =>
        value !== undefined,
    ),
  );
  const revision = snapshot.entities.workflowDefinitionRevisions[revisionId];
  if (
    revision === undefined ||
    revision.workflowDefinitionId !== definition.workflowDefinitionId ||
    !allowed.has(revisionId) ||
    revision.definitionSha256 !== expectedHash
  ) {
    throw revisionConflict("Definition保存基线已变化");
  }
  return revision;
}

function definitionDetail(
  snapshot: ProductSnapshot,
  principalId: PrincipalId,
  definitionId: WorkflowDefinitionId,
): WorkflowDefinitionDetailDto {
  const definition = snapshot.entities.workflowDefinitions[definitionId];
  if (definition === undefined) throw notFound("Workflow Definition不存在");
  assertDefinitionReadable(definition, principalId);
  const published = revisionById(snapshot, definition.publishedRevisionId);
  const draft = revisionById(snapshot, definition.currentDraftRevisionId);
  const base = draft ?? published;
  if (base === undefined) throw notFound("Workflow Definition没有可读Revision");
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    definition.blueprintKey,
    definition.blueprintVersion,
  );
  const common = {
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    workflowDefinitionId: definition.workflowDefinitionId,
    ownerKind: definition.ownerKind,
    ...(definition.ownerPrincipalId === undefined
      ? {}
      : { ownerPrincipalId: definition.ownerPrincipalId }),
    key: definition.key,
    title: definition.title,
    description: definition.description,
    blueprintKey: definition.blueprintKey,
    blueprintVersion: definition.blueprintVersion,
    status: definition.status,
    revision: definition.revision,
    ...(published === undefined ? {} : { publishedRevision: revisionSummary(published) }),
    ...(draft === undefined ? {} : { currentDraftRevision: revisionSummary(draft) }),
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  } as const;
  if (blueprint === undefined) {
    return workflowDefinitionDetailDtoSchema.parse({
      ...common,
      compatibility: "read_only_incompatible",
      safeStructureSummary: {
        nodeCount: countNodes(base.semanticRoot),
        nodeTypes: [...new Set(flattenNodeTypes(base.semanticRoot))].sort(),
      },
      incompatibilityCode: "definition.blueprint_version_unsupported",
      slots: [],
      allowedChoiceSourceTypes: [],
      allowedActions: [],
    });
  }
  const policy = deriveWorkflowDesignerPolicy(base.semanticRoot, blueprint);
  const allowedActions =
    definition.ownerKind === "system"
      ? (["copy"] as const)
      : definition.status === "archived"
        ? (["copy", "restore"] as const)
        : ([
            "copy",
            "save",
            "validate",
            ...(draft === undefined ? [] : (["publish"] as const)),
            ...(published === undefined ? [] : (["archive"] as const)),
          ] as const);
  return workflowDefinitionDetailDtoSchema.parse({
    ...common,
    compatibility: "editable",
    semanticRoot: base.semanticRoot,
    baseRevisionId: base.workflowDefinitionRevisionId,
    baseDefinitionSha256: base.definitionSha256,
    slots: policy.slots.map((slot) => toWorkflowDesignerSlotDto(slot, slotLabel(slot.slotId))),
    allowedChoiceSourceTypes: policy.allowedChoiceSourceTypes,
    allowedActions,
  });
}

function validationDto(
  semanticRoot: WorkflowDefinitionRevision["semanticRoot"],
  blueprintKey: WorkflowDefinitionRevision["blueprintKey"],
  blueprintVersion: number,
): WorkflowDefinitionValidationDto {
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(blueprintKey, blueprintVersion);
  if (blueprint === undefined) {
    return workflowDefinitionValidationDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      valid: false,
      diagnostics: [
        {
          family: "definition_invalid",
          code: "definition.blueprint_version_unsupported",
          path: "$",
          severity: "error",
          params: {},
        },
      ],
    });
  }
  const result = validateDesignerRoot(semanticRoot, blueprint, DEFAULT_NODE_CATALOG);
  if (!result.success) {
    return workflowDefinitionValidationDtoSchema.parse({
      schemaVersion: PRODUCT_API_SCHEMA_VERSION,
      valid: false,
      diagnostics: result.diagnostics.map(publicDiagnostic),
    });
  }
  return workflowDefinitionValidationDtoSchema.parse({
    schemaVersion: PRODUCT_API_SCHEMA_VERSION,
    valid: true,
    diagnostics: [],
    normalized: {
      semanticRoot: result.semanticRoot,
      definitionSha256: result.definitionSha256,
      nodeCount: countNodes(result.semanticRoot),
    },
  });
}

function validateDesignerRootFor(
  semanticRoot: WorkflowDefinitionRevision["semanticRoot"],
  reference: Pick<WorkflowDefinitionRevision, "blueprintKey" | "blueprintVersion">,
) {
  const blueprint = DEFAULT_WORKFLOW_BLUEPRINTS.get(
    reference.blueprintKey,
    reference.blueprintVersion,
  );
  if (blueprint === undefined) {
    return {
      success: false as const,
      diagnostics: [
        {
          family: "definition_invalid" as const,
          code: "definition.blueprint_version_unsupported",
          path: "$",
          params: {},
        },
      ],
    };
  }
  return validateDesignerRoot(semanticRoot, blueprint, DEFAULT_NODE_CATALOG);
}

async function commandResult(
  deps: ApplicationDeps,
  principalId: PrincipalId,
  resultRefs: Readonly<Record<string, string>>,
): Promise<WorkflowDefinitionCommandResultDto> {
  const definitionId = workflowDefinitionIdSchema.parse(resultRefs["workflowDefinitionId"]);
  const revisionId = workflowDefinitionRevisionIdSchema.parse(
    resultRefs["workflowDefinitionRevisionId"],
  );
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const affected = snapshot.entities.workflowDefinitionRevisions[revisionId];
  if (affected === undefined) throw notFound("Workflow Definition Revision不存在");
  return workflowDefinitionCommandResultDtoSchema.parse({
    definition: definitionDetail(snapshot, principalId, definitionId),
    affectedRevision: revisionSummary(affected),
  });
}

function revisionById(
  snapshot: ProductSnapshot,
  id: WorkflowDefinitionRevision["workflowDefinitionRevisionId"] | undefined,
): WorkflowDefinitionRevision | undefined {
  return id === undefined ? undefined : snapshot.entities.workflowDefinitionRevisions[id];
}

function revisionSummary(
  revision: WorkflowDefinitionRevision,
): WorkflowDefinitionRevisionSummaryDto {
  return {
    workflowDefinitionRevisionId: revision.workflowDefinitionRevisionId,
    definitionRevision: revision.definitionRevision,
    state: revision.state,
    definitionSha256: revision.definitionSha256,
    createdAt: revision.createdAt,
    ...(revision.publishedAt === undefined ? {} : { publishedAt: revision.publishedAt }),
  };
}

function derivedDefinitionId(commandId: CommandId): WorkflowDefinitionId {
  return workflowDefinitionIdSchema.parse(
    `wfd_${hashCanonical("id.workflow-definition-copy.v1", { commandId }).slice(0, 32)}`,
  );
}

function derivedRevisionId(commandId: CommandId, definitionId: WorkflowDefinitionId) {
  return workflowDefinitionRevisionIdSchema.parse(
    `wfr_${hashCanonical("id.workflow-definition-revision.v1", {
      commandId,
      definitionId,
    }).slice(0, 32)}`,
  );
}

function nextDefinitionRevision(snapshot: ProductSnapshot, definitionId: WorkflowDefinitionId) {
  return (
    Math.max(
      0,
      ...Object.values(snapshot.entities.workflowDefinitionRevisions)
        .filter((revision) => revision.workflowDefinitionId === definitionId)
        .map((revision) => revision.definitionRevision),
    ) + 1
  );
}

function publicDiagnostic(diagnostic: WorkflowDiagnostic) {
  return { ...diagnostic, severity: "error" as const };
}

function invalidDefinition(diagnostics: readonly WorkflowDiagnostic[]): ApplicationError {
  return new ApplicationError({
    code: "validation_failed",
    httpStatus: 422,
    message:
      diagnostics.length === 0
        ? "Workflow Definition Hash或规范化结果不一致"
        : `Workflow Definition非法:${diagnostics[0]?.code ?? "unknown"}`,
  });
}

function countNodes(root: WorkflowDefinitionRevision["semanticRoot"]): number {
  return validateWorkflowStructure(root, {
    outcomesFor: (nodeType, version) => DEFAULT_NODE_CATALOG.get(nodeType, version)?.outcomes,
  }).facts.nodeCount;
}

function flattenNodeTypes(root: WorkflowDefinitionRevision["semanticRoot"]): string[] {
  const types: string[] = [];
  const stack = [...root.elements];
  while (stack.length > 0) {
    const element = stack.pop();
    if (element === undefined) continue;
    if (element.kind === "task" || element.kind === "composite") types.push(element.nodeType);
    else if (element.kind === "sequence") stack.push(...element.elements);
    else if (element.kind === "choice") {
      for (const branch of element.branches) stack.push(...branch.body.elements);
    } else stack.push(...element.body.elements);
  }
  return types;
}

function slotLabel(slotId: string): string {
  return slotId === "planning.context" ? "规划上下文" : "笔记审核";
}
