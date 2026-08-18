import type { ApplicationDeps } from "@chat/application";
import { SYSTEM_PLANNING_WORKFLOW_REVISION_ID } from "@chat/application/workflow-system-definitions";
import {
  workflowDefinitionIdSchema,
  workflowDefinitionRevisionIdSchema,
  workflowDefinitionRevisionSchema,
  workflowDefinitionSchema,
  type CommandId,
  type PrincipalId,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";

/**
 * 旧context.memory只保留历史回放/兼容测试，不重新成为系统默认Definition。
 * 夹具把冻结的v2语义复制成测试Principal自己的已发布Definition。
 */
export async function installLegacyPlanningDefinition(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly suffix: string;
  },
) {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const sourceRevision =
    snapshot.entities.workflowDefinitionRevisions[SYSTEM_PLANNING_WORKFLOW_REVISION_ID];
  if (sourceRevision === undefined) throw new Error("fixture缺少当前Planning Definition");
  const sourceDefinition =
    snapshot.entities.workflowDefinitions[sourceRevision.workflowDefinitionId];
  if (sourceDefinition === undefined) throw new Error("fixture缺少历史Planning Definition owner");
  const workflowDefinitionId = workflowDefinitionIdSchema.parse(`wfd_legacy${input.suffix}`);
  const workflowDefinitionRevisionId = workflowDefinitionRevisionIdSchema.parse(
    `wfr_legacy${input.suffix}`,
  );
  const now = deps.now();
  const definition = workflowDefinitionSchema.parse({
    ...sourceDefinition,
    workflowDefinitionId,
    ownerKind: "principal",
    ownerPrincipalId: input.principalId,
    key: `test.legacy-${input.suffix}`,
    title: "历史Memory兼容测试工作流",
    publishedRevisionId: workflowDefinitionRevisionId,
    currentDraftRevisionId: undefined,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  const semanticRoot = {
    ...sourceRevision.semanticRoot,
    elements: [
      {
        kind: "task" as const,
        definitionNodeId: "planning.memory",
        nodeType: "context.memory",
        schemaVersion: 1,
        config: { required: false, maxItems: 8 },
        defaultActivation: "enabled" as const,
      },
      ...sourceRevision.semanticRoot.elements,
    ],
  };
  const revision = workflowDefinitionRevisionSchema.parse({
    ...sourceRevision,
    workflowDefinitionRevisionId,
    workflowDefinitionId,
    definitionRevision: 1,
    state: "published",
    title: definition.title,
    semanticRoot,
    definitionSha256: hashCanonical("workflow-definition.v1", semanticRoot),
    basedOnRevisionId: sourceRevision.workflowDefinitionRevisionId,
    publishedAt: now,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  await deps.store.transact({
    commandId: input.commandId,
    commandType: "CopyWorkflowDefinition",
    requestSha256: hashCanonical("test.install-legacy-planning-definition.v1", {
      principalId: input.principalId,
      workflowDefinitionId,
      workflowDefinitionRevisionId,
    }),
    mutate: (draft) => {
      draft.entities.workflowDefinitions[workflowDefinitionId] = definition;
      draft.entities.workflowDefinitionRevisions[workflowDefinitionRevisionId] = revision;
      return { resultRefs: { workflowDefinitionId, workflowDefinitionRevisionId } };
    },
  });
  return revision;
}
