import {
  type AssignProjectActionPayload,
  type CommandId,
  type CreateProjectActionPayload,
  type PrincipalId,
  type ProjectAction,
  type ProjectWorkspaceDto,
  type SetProjectArchiveStatusPayload,
  type TransitionProjectActionPayload,
} from "@chat/contracts";
import {
  assertProjectActionTransition,
  assertProjectLifecycleTransition,
  hashCanonical,
} from "@chat/domain";
import { type ApplicationDeps } from "../deps.js";
import { forbidden, notFound, revisionConflict } from "../errors.js";
import {
  requireProjectIds,
  emitProjectTrace,
  emitProjectLifecycleTrace,
  projectTraceId,
  projectSpanId,
  assertProjectWritable,
} from "./shared.js";
import { getProjectWorkspace } from "./queries.js";

export async function createProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly payload: CreateProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const actionId = requireProjectIds(deps).action();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.create-project-action.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CreateProjectAction",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权修改Project");
      assertProjectWritable(project);
      const work = draft.entities.projectWorks[input.payload.workId];
      const owner = draft.entities.projectParticipants[input.payload.ownerParticipantId];
      if (
        work?.projectId !== project.projectId ||
        owner?.projectId !== project.projectId ||
        owner.status !== "active"
      ) {
        throw revisionConflict("Work或负责人不属于当前Project");
      }
      draft.entities.projectActions[actionId] = {
        schemaVersion: "project-action.v1",
        projectActionId: actionId,
        projectId: project.projectId,
        workId: work.projectWorkId,
        title: input.payload.title,
        ownerParticipantId: owner.projectParticipantId,
        status: "todo",
        ...(input.payload.dueAt !== undefined ? { dueAt: input.payload.dueAt } : {}),
        completedEvidenceIds: [],
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId, projectActionId: actionId } };
    },
  });
  if (!transaction.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.action.created",
      outcome: "success",
      traceId: projectTraceId(input.projectId),
      spanId: projectSpanId(input.projectId, input.commandId),
      projectId: input.projectId as never,
      projectActionId: actionId,
      projectWorkId: input.payload.workId,
      ownerParticipantId: input.payload.ownerParticipantId,
      actionRevision: 1,
      commandId: input.commandId,
    });
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}

export async function transitionProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payload: TransitionProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.transition-project-action.v1", input);
  let priorStatus: ProjectAction["status"] | undefined;
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "TransitionProjectAction",
    requestSha256,
    mutate: (draft) => {
      const action = draft.entities.projectActions[input.actionId];
      if (action === undefined) throw notFound("Project Action不存在");
      const project = draft.entities.projects[action.projectId];
      if (project?.ownerPrincipalId !== input.principalId)
        throw forbidden("无权修改Project Action");
      assertProjectWritable(project);
      if (action.revision !== input.expectedRevision)
        throw revisionConflict("Project Action revision冲突");
      priorStatus = action.status;
      assertProjectActionTransition({
        from: action.status,
        to: input.payload.status,
        ...(input.payload.blockedReason !== undefined
          ? { blockedReason: input.payload.blockedReason }
          : {}),
      });
      draft.entities.projectActions[action.projectActionId] = {
        ...action,
        status: input.payload.status,
        ...(input.payload.status === "blocked"
          ? { blockedReason: input.payload.blockedReason }
          : { blockedReason: undefined }),
        revision: action.revision + 1,
        updatedAt: now,
      } as ProjectAction;
      return { resultRefs: { projectId: action.projectId } };
    },
  });
  if (!result.replayed && priorStatus !== undefined) {
    const after = await deps.store.read({ kind: "committedSnapshot" });
    const action = after.snapshot.entities.projectActions[input.actionId];
    if (action !== undefined) {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.action.transitioned",
        outcome: "success",
        traceId: projectTraceId(action.projectId),
        spanId: projectSpanId(action.projectId, input.commandId),
        projectId: action.projectId,
        projectActionId: action.projectActionId,
        projectWorkId: action.workId,
        ownerParticipantId: action.ownerParticipantId,
        actionRevision: action.revision,
        fromStatus: priorStatus,
        toStatus: action.status,
        commandId: input.commandId,
      });
    }
  }
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: result.resultRefs.projectId ?? "",
  });
}

export async function assignProjectAction(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly actionId: string;
    readonly expectedRevision: number;
    readonly payload: AssignProjectActionPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const requestSha256 = hashCanonical("command.assign-project-action.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "AssignProjectAction",
    requestSha256,
    mutate: (draft) => {
      const action = draft.entities.projectActions[input.actionId];
      if (action === undefined) throw notFound("Project Action不存在");
      const project = draft.entities.projects[action.projectId];
      if (project?.ownerPrincipalId !== input.principalId)
        throw forbidden("无权分派Project Action");
      assertProjectWritable(project);
      if (action.revision !== input.expectedRevision)
        throw revisionConflict("Project Action revision冲突");
      const owner = draft.entities.projectParticipants[input.payload.ownerParticipantId];
      if (owner?.projectId !== project.projectId || owner.status !== "active") {
        throw revisionConflict("负责人不属于当前Project或已停用");
      }
      draft.entities.projectActions[action.projectActionId] = {
        ...action,
        ownerParticipantId: owner.projectParticipantId,
        revision: action.revision + 1,
        updatedAt: now,
      };
      return { resultRefs: { projectId: project.projectId } };
    },
  });
  if (!result.replayed) {
    const after = await deps.store.read({ kind: "committedSnapshot" });
    const action = after.snapshot.entities.projectActions[input.actionId];
    if (action !== undefined) {
      emitProjectTrace(deps, {
        level: "info",
        eventName: "project.action.assigned",
        outcome: "success",
        traceId: projectTraceId(action.projectId),
        spanId: projectSpanId(action.projectId, input.commandId),
        projectId: action.projectId,
        projectActionId: action.projectActionId,
        projectWorkId: action.workId,
        ownerParticipantId: action.ownerParticipantId,
        actionRevision: action.revision,
        commandId: input.commandId,
      });
    }
  }
  return getProjectWorkspace(deps, {
    principalId: input.principalId,
    projectId: result.resultRefs.projectId ?? "",
  });
}

export async function setProjectArchiveStatus(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectId: string;
    readonly expectedRevision: number;
    readonly payload: SetProjectArchiveStatusPayload;
  },
): Promise<{ project: ProjectWorkspaceDto }> {
  const ids = requireProjectIds(deps);
  const decisionId = ids.decision();
  const transitionId = ids.stateTransition();
  const now = deps.now();
  const requestSha256 = hashCanonical("command.set-project-archive-status.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SetProjectArchiveStatus",
    requestSha256,
    mutate: (draft) => {
      const project = draft.entities.projects[input.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权归档Project");
      if (project.revision !== input.expectedRevision)
        throw revisionConflict("Project revision冲突");
      if (project.status === input.payload.status) throw revisionConflict("Project状态没有变化");
      const actor = Object.values(draft.entities.projectParticipants).find(
        (participant) =>
          participant.projectId === project.projectId &&
          participant.kind === "human" &&
          participant.principalId === input.principalId &&
          participant.status === "active",
      );
      if (actor === undefined) throw forbidden("Project缺少可确认生命周期转换的所有者Participant");
      assertProjectLifecycleTransition({
        from: project.status,
        to: input.payload.status,
        evidenceIds: [],
      });
      const reason =
        input.payload.status === "archived" ? "用户显式归档Project" : "用户显式恢复Project";
      draft.entities.projectDecisions[decisionId] = {
        schemaVersion: "project-decision.v2",
        projectDecisionId: decisionId,
        projectId: project.projectId,
        question: `是否把Project从${project.status}转换为${input.payload.status}？`,
        options: [input.payload.status],
        choice: input.payload.status,
        rationale: reason,
        decidedByParticipantId: actor.projectParticipantId,
        boundProjectRevision: project.revision,
        payloadSha256: hashCanonical("project-decision-payload.v1", {
          projectId: project.projectId,
          boundProjectRevision: project.revision,
          question: `是否把Project从${project.status}转换为${input.payload.status}？`,
          options: [input.payload.status],
          choice: input.payload.status,
          rationale: reason,
        }) as never,
        status: "active",
        commandId: input.commandId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      const nextProject = {
        ...project,
        status: input.payload.status,
        revision: project.revision + 1,
        updatedAt: now,
      };
      draft.entities.projects[project.projectId] = {
        ...nextProject,
      };
      draft.entities.projectStateTransitions[transitionId] = {
        schemaVersion: "project-state-transition.v1",
        projectStateTransitionId: transitionId,
        projectId: project.projectId,
        objectType: "project",
        objectId: project.projectId,
        from: project.status,
        to: input.payload.status,
        actorParticipantId: actor.projectParticipantId,
        commandId: input.commandId,
        beforeRevision: project.revision,
        afterRevision: nextProject.revision,
        reason,
        decisionId,
        evidenceIds: [],
        occurredAt: now,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return {
        resultRefs: {
          projectId: project.projectId,
          projectDecisionId: decisionId,
          projectStateTransitionId: transitionId,
        },
      };
    },
  });
  if (!transaction.replayed) {
    await emitProjectLifecycleTrace(deps, transitionId, input.commandId);
  }
  return getProjectWorkspace(deps, { principalId: input.principalId, projectId: input.projectId });
}
