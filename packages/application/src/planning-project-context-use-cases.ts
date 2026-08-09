import {
  planningProjectContextIdSchema,
  planningProjectContextSchema,
  projectIdSchema,
  type PlanningProjectContext,
  type PlanningProjectSourceRef,
  type PreparePlanningProjectContextRequest,
  type ProductEntities,
  type ProductRunId,
  type WorkflowRunSpecId,
} from "@chat/contracts";
import {
  computePlanningProjectContextSha256,
  computePlanningProjectSourceRefSha256,
  computeWorkflowProjectResourceSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps } from "./deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "./errors.js";
import { commitPlanningContextNodeFact } from "./planning-context-node-facts.js";
import { requirePlanningRun } from "./product-run-kind.js";
import { validateWorkflowRunSpecIntegrity } from "./workflow-run-spec-compiler.js";

export type PreparePlanningProjectContextResult =
  | { readonly status: "none" }
  | {
      readonly status: "ready";
      readonly contextRef: {
        readonly planningProjectContextId: PlanningProjectContext["planningProjectContextId"];
        readonly revision: 1;
        readonly sha256: string;
      };
    };

/**
 * context.project的唯一Application写边界。
 *
 * RunSpec先冻结可授权的Project聚合引用；本命令在第一次真正读取时复核该引用，
 * 随后把模型需要的有限Project正文投影成不可变Snapshot。Planning修订只携带Snapshot ref，
 * 不会再次读取已经变化的Project，也不会把Project正文复制进Workflow checkpoint或Trace。
 */
export async function preparePlanningProjectContext(
  deps: ApplicationDeps,
  input: Omit<PreparePlanningProjectContextRequest, "schemaVersion">,
): Promise<PreparePlanningProjectContextResult> {
  const requestSha256 = hashCanonical("command.prepare-planning-project-context.v1", input);
  const now = deps.now();
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PreparePlanningProjectContext",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Planning Run不存在");
      const planningRun = requirePlanningRun(run);
      const rawRunSpec = draft.entities.workflowRunSpecs[input.workflowRunSpecId];
      const validated =
        rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
      if (
        rawRunSpec === undefined ||
        rawRunSpec.productRunId !== input.productRunId ||
        planningRun.workflowRunSpecId !== input.workflowRunSpecId ||
        validated === undefined ||
        !validated.success
      ) {
        throw revisionConflict("Project Context的RunSpec不存在、损坏或绑定无效");
      }
      const runSpec = validated.runSpec;
      const currentSelection = resolveSelectedProject(draft.entities, input);
      if (currentSelection === undefined) {
        const nodeRun = commitPlanningContextNodeFact(draft, {
          run: planningRun,
          runSpec,
          definitionNodeId: input.definitionNodeId,
          nodeType: "context.project",
          executionPath: input.executionPath,
          attemptNumber: input.attemptNumber,
          terminal: "skipped",
          outcomeCode: "optional_unavailable",
          publicSummary: "本轮未选择Project Context",
          inputSlots: [],
          outputSlots: [],
          at: now,
        });
        return {
          resultRefs: {
            productRunId: input.productRunId,
            workflowNodeRunId: nodeRun.workflowNodeRunId,
          },
        };
      }
      const planningProjectContextId = planningProjectContextIdSchema.parse(
        `pcx_${hashCanonical("id.planning-project-context.v1", {
          productRunId: input.productRunId,
          definitionNodeId: input.definitionNodeId,
          projectId: currentSelection.projectId,
        }).slice(0, 32)}`,
      );
      const context = buildPlanningProjectContext({
        entities: draft.entities,
        productRunId: input.productRunId,
        projectId: currentSelection.projectId,
        expectedRevision: currentSelection.expectedRevision,
        expectedSha256: currentSelection.expectedSha256,
        planningProjectContextId,
        createdAt: now,
      });
      const existing = draft.entities.planningProjectContexts[planningProjectContextId];
      if (existing !== undefined && existing.sha256 !== context.sha256) {
        throw new ApplicationError({
          code: "store_corrupted",
          httpStatus: 500,
          message: "Planning Project Context稳定身份发生Hash冲突",
          recoveryAction: "contact_support",
        });
      }
      draft.entities.planningProjectContexts[planningProjectContextId] = existing ?? context;
      const projectRef = {
        kind: "project" as const,
        id: context.projectId,
        revision: context.projectRevision,
        sha256: context.projectSha256,
        label: context.snapshot.name,
      };
      const contextRef = {
        kind: "planning_project_context" as const,
        id: context.planningProjectContextId,
        revision: context.revision,
        sha256: context.sha256,
        label: `${context.snapshot.name}规划上下文`,
      };
      const nodeRun = commitPlanningContextNodeFact(draft, {
        run: planningRun,
        runSpec,
        definitionNodeId: input.definitionNodeId,
        nodeType: "context.project",
        executionPath: input.executionPath,
        attemptNumber: input.attemptNumber,
        terminal: "succeeded",
        outcomeCode: "success",
        publicSummary: `已冻结Project Context：${context.snapshot.name}`,
        inputSlots: [{ name: "project", refs: [projectRef] }],
        outputSlots: [{ name: "context", refs: [contextRef] }],
        relatedProductRef: contextRef,
        at: now,
      });
      return {
        resultRefs: {
          planningProjectContextId,
          productRunId: input.productRunId,
          workflowNodeRunId: nodeRun.workflowNodeRunId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const committedContextId = result.resultRefs["planningProjectContextId"];
  if (committedContextId === undefined) return { status: "none" };
  const context = snapshot.entities.planningProjectContexts[committedContextId];
  if (context === undefined) throw notFound("Planning Project Context不存在");
  return {
    status: "ready",
    contextRef: {
      planningProjectContextId: context.planningProjectContextId,
      revision: context.revision,
      sha256: context.sha256,
    },
  };
}

function resolveSelectedProject(
  entities: ProductEntities,
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: WorkflowRunSpecId;
    readonly definitionNodeId: string;
  },
):
  | {
      readonly projectId: PlanningProjectContext["projectId"];
      readonly expectedRevision: number;
      readonly expectedSha256: string;
    }
  | undefined {
  const run = entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const planningRun = requirePlanningRun(run);
  if (planningRun.workflowRunSpecId !== input.workflowRunSpecId) {
    throw revisionConflict("Project Context的RunSpec与Run绑定不一致");
  }
  const rawRunSpec = entities.workflowRunSpecs[input.workflowRunSpecId];
  const validated =
    rawRunSpec === undefined ? undefined : validateWorkflowRunSpecIntegrity(rawRunSpec);
  if (
    rawRunSpec === undefined ||
    rawRunSpec.productRunId !== input.productRunId ||
    validated === undefined ||
    !validated.success
  ) {
    throw revisionConflict("Project Context的RunSpec不存在或绑定无效");
  }
  const runSpec = validated.runSpec;
  const node = runSpec.nodeResolutions.find(
    (candidate) => candidate.definitionNodeId === input.definitionNodeId,
  );
  if (node?.nodeType !== "context.project") {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "指定节点不是Project Context节点",
    });
  }
  const included = runSpec.resourceResolutions.filter(
    (resource) =>
      resource.definitionNodeId === input.definitionNodeId &&
      resource.resourceKind === "project" &&
      resource.resolution === "included",
  );
  if (included.length === 0) return undefined;
  if (included.length !== 1) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 422,
      message: "Project Context节点每次运行只能冻结一个Project",
    });
  }
  const resource = included[0];
  if (resource === undefined || !("resourceId" in resource)) return undefined;
  return {
    projectId: projectIdSchema.parse(resource.resourceId),
    expectedRevision: resource.expectedRevision,
    expectedSha256: resource.expectedSha256,
  };
}

function buildPlanningProjectContext(input: {
  readonly entities: ProductEntities;
  readonly productRunId: ProductRunId;
  readonly projectId: PlanningProjectContext["projectId"];
  readonly expectedRevision: number;
  readonly expectedSha256: string;
  readonly planningProjectContextId: PlanningProjectContext["planningProjectContextId"];
  readonly createdAt: string;
}): PlanningProjectContext {
  const project = input.entities.projects[input.projectId];
  if (project === undefined) throw notFound("Project不存在");
  const run = input.entities.runs[input.productRunId];
  const session = run === undefined ? undefined : input.entities.sessions[run.sessionId];
  if (session === undefined) throw notFound("Project Context所属Session不存在");
  if (project.ownerPrincipalId !== session.ownerPrincipalId) {
    throw forbidden("无权读取该Project Context");
  }
  const currentResourceSha256 = computeWorkflowProjectResourceSha256(project);
  if (
    project.revision !== input.expectedRevision ||
    currentResourceSha256 !== input.expectedSha256
  ) {
    throw revisionConflict("Project revision/hash已变化");
  }
  const method = input.entities.projectMethodSnapshots[project.methodSnapshotId];
  const stage = input.entities.projectStages[project.currentStageId];
  if (
    method === undefined ||
    stage === undefined ||
    method.projectId !== project.projectId ||
    stage.projectId !== project.projectId ||
    stage.methodSnapshotId !== method.projectMethodSnapshotId
  ) {
    throw new ApplicationError({
      code: "store_corrupted",
      httpStatus: 500,
      message: "Project当前Method/Stage引用损坏",
      recoveryAction: "contact_support",
    });
  }
  const milestones = Object.values(input.entities.projectMilestones)
    .filter((item) => item.projectId === project.projectId)
    .sort((left, right) =>
      `${left.status}:${left.targetAt ?? left.createdAt}:${left.projectMilestoneId}`.localeCompare(
        `${right.status}:${right.targetAt ?? right.createdAt}:${right.projectMilestoneId}`,
      ),
    )
    .slice(0, 20);
  const latestUpdate = Object.values(input.entities.projectUpdates)
    .filter((item) => item.projectId === project.projectId)
    .sort((left, right) =>
      right.publishedAt === left.publishedAt
        ? left.projectUpdateId.localeCompare(right.projectUpdateId)
        : right.publishedAt.localeCompare(left.publishedAt),
    )[0];
  const works = Object.values(input.entities.projectWorks)
    .filter(
      (item) =>
        item.projectId === project.projectId &&
        item.stageId === stage.projectStageId &&
        item.status !== "done" &&
        item.status !== "cancelled",
    )
    .sort((left, right) =>
      left.createdAt === right.createdAt
        ? left.projectWorkId.localeCompare(right.projectWorkId)
        : left.createdAt.localeCompare(right.createdAt),
    )
    .slice(0, 30);
  // sourceRefs合同上限为100：3个根引用 + 20个Milestone + 1个Update + 30个Work后，
  // Action使用全局40条预算，而不是每个Work各取30条导致合法大Project无法冻结。
  let remainingActionBudget = 40;
  const actionsByWork = new Map(
    works.map((work) => {
      const actions = Object.values(input.entities.projectActions)
        .filter(
          (action) =>
            action.projectId === project.projectId && action.workId === work.projectWorkId,
        )
        .sort((left, right) => left.projectActionId.localeCompare(right.projectActionId))
        .slice(0, remainingActionBudget);
      remainingActionBudget -= actions.length;
      return [work.projectWorkId, actions] as const;
    }),
  );
  const stageSha256 = sourceSha256("stage", stage);
  const sourceRefs: PlanningProjectSourceRef[] = [
    {
      kind: "project",
      objectId: project.projectId,
      revision: project.revision,
      sha256: currentResourceSha256,
    },
    {
      kind: "method",
      objectId: method.projectMethodSnapshotId,
      revision: method.revision,
      sha256: method.sha256,
    },
    {
      kind: "stage",
      objectId: stage.projectStageId,
      revision: stage.revision,
      sha256: stageSha256,
    },
    ...milestones.map((milestone): PlanningProjectSourceRef => ({
      kind: "milestone",
      objectId: milestone.projectMilestoneId,
      revision: milestone.revision,
      sha256: sourceSha256("milestone", milestone),
    })),
    ...(latestUpdate === undefined
      ? []
      : [
          {
            kind: "update" as const,
            objectId: latestUpdate.projectUpdateId,
            revision: latestUpdate.revision,
            sha256: sourceSha256("update", latestUpdate),
          },
        ]),
    ...works.flatMap((work): PlanningProjectSourceRef[] => [
      {
        kind: "work",
        objectId: work.projectWorkId,
        revision: work.revision,
        sha256: sourceSha256("work", work),
      },
      ...(actionsByWork.get(work.projectWorkId) ?? []).map((action): PlanningProjectSourceRef => ({
        kind: "action",
        objectId: action.projectActionId,
        revision: action.revision,
        sha256: sourceSha256("action", action),
      })),
    ]),
  ];
  const snapshot = {
    name: project.name,
    summary: project.summary,
    goal: project.goal,
    scopeIn: [...project.scopeIn],
    scopeOut: [...project.scopeOut],
    successCriteria: [...project.successCriteria],
    status: project.status,
    methodProfileId: method.profileId,
    stage: {
      key: stage.key,
      name: stage.name,
      goal: stage.goal,
      successCriteria: [...stage.successCriteria],
      status: stage.status,
    },
    milestones: milestones.map((milestone) => ({
      projectMilestoneId: milestone.projectMilestoneId,
      outcome: milestone.outcome,
      acceptanceCriteria: [...milestone.acceptanceCriteria],
      status: milestone.status,
      ...(milestone.targetAt !== undefined ? { targetAt: milestone.targetAt } : {}),
    })),
    ...(latestUpdate !== undefined
      ? {
          latestUpdate: {
            projectUpdateId: latestUpdate.projectUpdateId,
            health: latestUpdate.health,
            narrative: latestUpdate.narrative,
            blockers: [...latestUpdate.blockers],
            nextFocus: [...latestUpdate.nextFocus],
            publishedAt: latestUpdate.publishedAt,
          },
        }
      : {}),
    activeWorks: works.map((work) => ({
      projectWorkId: work.projectWorkId,
      title: work.title,
      status: work.status,
      actions: (actionsByWork.get(work.projectWorkId) ?? []).map((action) => ({
        projectActionId: action.projectActionId,
        title: action.title,
        status: action.status,
        ...(action.blockedReason !== undefined ? { blockedReason: action.blockedReason } : {}),
      })),
    })),
  };
  const hashInput = {
    productRunId: input.productRunId,
    projectId: project.projectId,
    projectRevision: project.revision,
    projectSha256: currentResourceSha256,
    methodRef: {
      projectMethodSnapshotId: method.projectMethodSnapshotId,
      revision: method.revision,
      sha256: method.sha256,
    },
    stageRef: {
      projectStageId: stage.projectStageId,
      revision: stage.revision,
      sha256: stageSha256,
    },
    snapshot,
    sourceRefs,
  };
  return planningProjectContextSchema.parse({
    schemaVersion: "planning-project-context.v1",
    planningProjectContextId: input.planningProjectContextId,
    ...hashInput,
    sha256: computePlanningProjectContextSha256(hashInput),
    revision: 1,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

function sourceSha256(
  kind: Exclude<PlanningProjectSourceRef["kind"], "project" | "method">,
  value: object,
): string {
  return computePlanningProjectSourceRefSha256({
    kind,
    entity: value,
  });
}
