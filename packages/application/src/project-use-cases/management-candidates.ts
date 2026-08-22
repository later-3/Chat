import {
  type BeginProjectManagementCandidatePayload,
  type CommandId,
  type PrincipalId,
  type Project,
  type ProjectCandidate,
  type ProjectCandidateDto,
  type ProjectManagementCandidateDecisionPayload,
  type ProjectManagementProposal,
  type ProjectWorkspaceDto,
} from "@chat/contracts";
import { computeProjectManagementCandidateSha256, hashCanonical } from "@chat/domain";
import { type ApplicationDeps, type ProjectIdFactory } from "../deps.js";
import { forbidden, notFound, revisionConflict } from "../errors.js";
import {
  type Snapshot,
  requireProjectIds,
  emitProjectTrace,
  projectTraceId,
  projectSpanId,
  assertProjectWritable,
  toCandidateDto,
  projectWorkspace,
} from "./shared.js";

function managementText(
  kind: BeginProjectManagementCandidatePayload["kind"],
  text: string,
): string {
  const prefixes: Record<BeginProjectManagementCandidatePayload["kind"], RegExp> = {
    action: /^\s*(?:新增待办|安排待办|待办)\s*[:：]?\s*/u,
    decision: /^\s*(?:记录决定|决定)\s*[:：]?\s*/u,
    contribution: /^\s*(?:记录贡献|贡献)\s*[:：]?\s*/u,
  };
  return text.replace(prefixes[kind], "").trim() || text.trim();
}

function compileManagementProposal(input: {
  readonly snapshot: Snapshot;
  readonly projectId: string;
  readonly kind: BeginProjectManagementCandidatePayload["kind"];
  readonly text: string;
  readonly now: string;
}): ProjectManagementProposal {
  const participant = Object.values(input.snapshot.entities.projectParticipants).find(
    (item) => item.projectId === input.projectId && item.status === "active",
  );
  if (participant === undefined) throw revisionConflict("Project没有可用参与者");
  const work = Object.values(input.snapshot.entities.projectWorks).find(
    (item) =>
      item.projectId === input.projectId && item.status !== "done" && item.status !== "cancelled",
  );
  const text = managementText(input.kind, input.text);
  if (input.kind === "action") {
    if (work === undefined) throw revisionConflict("Project没有可承接待办的活动Work");
    return {
      kind: "action",
      workId: work.projectWorkId,
      title: text.slice(0, 240),
      ownerParticipantId: participant.projectParticipantId,
    };
  }
  if (input.kind === "decision") {
    return {
      kind: "decision",
      question: "是否采用本次对话提出的项目决定？",
      options: [text.slice(0, 1_000)],
      choice: text.slice(0, 1_000),
      rationale: "用户通过显式项目管理模式提出，确认后进入Decision Register。",
      decidedByParticipantId: participant.projectParticipantId,
    };
  }
  return {
    kind: "contribution",
    participantId: participant.projectParticipantId,
    ...(work !== undefined ? { workId: work.projectWorkId } : {}),
    contributionKind: "coordination",
    summary: text.slice(0, 2_000),
    evidenceIds: [],
    occurredAt: input.now,
  };
}

/** 显式“管理项目”消息只生成可审核Candidate，不直接改Project账本。 */
export async function beginProjectManagementCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: BeginProjectManagementCandidatePayload;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const now = deps.now();
  const messageId = deps.ids.message();
  const candidateId = requireProjectIds(deps).candidate();
  const requestSha256 = hashCanonical("command.begin-project-management-candidate.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginProjectManagementCandidate",
    requestSha256,
    traceContext: { productSessionId: input.payload.sessionId },
    mutate: (draft) => {
      const session = draft.entities.sessions[input.payload.sessionId];
      const project = draft.entities.projects[input.payload.projectId];
      if (session === undefined || project === undefined) throw notFound("Session或Project不存在");
      if (
        session.ownerPrincipalId !== input.principalId ||
        project.ownerPrincipalId !== input.principalId
      ) {
        throw forbidden("无权管理该Project");
      }
      assertProjectWritable(project);
      if (
        Object.values(draft.entities.projectCandidates).some(
          (candidate) =>
            candidate.sessionId === session.sessionId &&
            (candidate.status === "queued" || candidate.status === "under_review"),
        )
      ) {
        throw revisionConflict("当前Session已有未决定的Project Candidate");
      }
      const proposal = compileManagementProposal({
        snapshot: draft,
        projectId: project.projectId,
        kind: input.payload.kind,
        text: input.payload.text,
        now,
      });
      const candidateSha256 = computeProjectManagementCandidateSha256({
        projectId: project.projectId,
        boundProjectRevision: project.revision,
        sourceMessageId: messageId,
        proposal,
      });
      const sequence = session.lastMessageSequence + 1;
      draft.entities.messages[messageId] = {
        schemaVersion: "message.v1",
        messageId,
        sessionId: session.sessionId,
        sessionSequence: sequence,
        role: "user",
        content: { format: "markdown", text: input.payload.text },
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.entities.sessions[session.sessionId] = {
        ...session,
        lastMessageSequence: sequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      draft.entities.projectCandidates[candidateId] = {
        schemaVersion: "project-candidate.v1",
        projectCandidateId: candidateId,
        sessionId: session.sessionId,
        sourceMessageId: messageId,
        requestedByPrincipalId: input.principalId,
        candidateKind: "management",
        projectId: project.projectId,
        boundProjectRevision: project.revision,
        proposal,
        candidateSha256: candidateSha256 as never,
        status: "under_review",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectCandidateId: candidateId, messageId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate =
    snapshot.entities.projectCandidates[transaction.resultRefs.projectCandidateId ?? ""];
  if (candidate === undefined || candidate.candidateKind !== "management") {
    throw notFound("Project管理Candidate不存在");
  }
  if (!transaction.replayed) emitManagementCandidateTrace(deps, candidate);
  return { candidate: toCandidateDto(candidate) };
}

function emitManagementCandidateTrace(
  deps: ApplicationDeps,
  candidate: Extract<ProjectCandidate, { candidateKind: "management" }>,
): void {
  const common = {
    traceId: projectTraceId(candidate.projectId),
    spanId: projectSpanId(candidate.projectCandidateId, String(candidate.revision)),
    projectId: candidate.projectId,
    projectCandidateId: candidate.projectCandidateId,
    candidateRevision: candidate.revision,
    candidateSha256: candidate.candidateSha256,
  } as const;
  if (candidate.proposal.kind === "decision") {
    emitProjectTrace(deps, {
      ...common,
      level: "info",
      eventName: "project.decision.candidate",
      outcome: "unknown",
      boundProjectRevision: candidate.boundProjectRevision,
    });
  } else if (candidate.proposal.kind === "contribution") {
    emitProjectTrace(deps, {
      ...common,
      level: "info",
      eventName: "project.contribution.candidate",
      outcome: "unknown",
    });
  }
}

export async function decideProjectManagementCandidate(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly projectCandidateId: string;
    readonly expectedRevision: number;
    readonly payload: ProjectManagementCandidateDecisionPayload;
  },
): Promise<{ candidate: ProjectCandidateDto; project: ProjectWorkspaceDto }> {
  const now = deps.now();
  const ids = requireProjectIds(deps);
  const actionId = ids.action();
  const decisionId = ids.decision();
  const contributionId = ids.contribution();
  const requestSha256 = hashCanonical("command.decide-project-management-candidate.v1", input);
  const transaction = await deps.store.transact({
    commandId: input.commandId,
    commandType: "DecideProjectManagementCandidate",
    requestSha256,
    mutate: (draft) => {
      const candidate = draft.entities.projectCandidates[input.projectCandidateId];
      if (
        candidate === undefined ||
        candidate.candidateKind !== "management" ||
        candidate.status !== "under_review"
      ) {
        throw revisionConflict("Project管理Candidate当前不可决定");
      }
      if (candidate.requestedByPrincipalId !== input.principalId)
        throw forbidden("无权决定Candidate");
      if (candidate.revision !== input.expectedRevision)
        throw revisionConflict("Candidate revision冲突");
      if (candidate.candidateSha256 !== input.payload.candidateSha256) {
        throw revisionConflict("Candidate Hash已变化");
      }
      const project = draft.entities.projects[candidate.projectId];
      if (project === undefined) throw notFound("Project不存在");
      if (project.ownerPrincipalId !== input.principalId) throw forbidden("无权管理Project");
      // Project变化后旧Candidate不能再修改或确认，但拒绝只关闭候选，不写Project事实；
      // 必须始终允许用户清理陈旧候选，否则该Session会永久被未决Candidate阻塞。
      if (input.payload.kind === "reject") {
        draft.entities.projectCandidates[candidate.projectCandidateId] = {
          ...candidate,
          status: "rejected",
          ...(input.payload.reason !== undefined ? { rejectionReason: input.payload.reason } : {}),
          decidedByCommandId: input.commandId,
          revision: candidate.revision + 1,
          updatedAt: now,
        };
        return {
          resultRefs: {
            projectCandidateId: candidate.projectCandidateId,
            projectId: project.projectId,
          },
        };
      }
      assertProjectWritable(project);
      if (project.revision !== candidate.boundProjectRevision) {
        throw revisionConflict("Candidate绑定的Project revision已过期");
      }
      if (input.payload.kind === "revise") {
        if (input.payload.proposal.kind !== candidate.proposal.kind) {
          throw revisionConflict("Candidate修改不能改变命令类型");
        }
        assertManagementProposalReferences(draft, project.projectId, input.payload.proposal);
        const candidateSha256 = computeProjectManagementCandidateSha256({
          projectId: project.projectId,
          boundProjectRevision: candidate.boundProjectRevision,
          sourceMessageId: candidate.sourceMessageId,
          proposal: input.payload.proposal,
        });
        draft.entities.projectCandidates[candidate.projectCandidateId] = {
          ...candidate,
          proposal: input.payload.proposal,
          candidateSha256: candidateSha256 as never,
          revision: candidate.revision + 1,
          updatedAt: now,
        } as ProjectCandidate;
        return {
          resultRefs: {
            projectCandidateId: candidate.projectCandidateId,
            projectId: project.projectId,
          },
        };
      }
      assertManagementProposalReferences(draft, project.projectId, candidate.proposal);
      const committedObjectId = commitManagementProposal({
        draft,
        project,
        proposal: candidate.proposal,
        commandId: input.commandId,
        now,
        ids: { actionId, decisionId, contributionId },
      });
      draft.entities.projectCandidates[candidate.projectCandidateId] = {
        ...candidate,
        status: "confirmed",
        committedObjectId,
        decidedByCommandId: input.commandId,
        revision: candidate.revision + 1,
        updatedAt: now,
      };
      return {
        resultRefs: {
          projectCandidateId: candidate.projectCandidateId,
          projectId: project.projectId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.projectCandidates[input.projectCandidateId];
  if (candidate === undefined || candidate.candidateKind !== "management") {
    throw notFound("Project管理Candidate不存在");
  }
  if (!transaction.replayed) {
    if (input.payload.kind === "revise" && candidate.status === "under_review") {
      emitManagementCandidateTrace(deps, candidate);
    } else if (input.payload.kind === "reject" && candidate.status === "rejected") {
      emitManagementRejectedTrace(deps, candidate, input.commandId);
    } else if (input.payload.kind === "confirm" && candidate.status === "confirmed") {
      emitManagementCommittedTrace(deps, candidate, input.commandId);
    }
  }
  return {
    candidate: toCandidateDto(candidate),
    project: projectWorkspace(snapshot, candidate.projectId, input.principalId),
  };
}

function assertManagementProposalReferences(
  draft: Snapshot,
  projectId: string,
  proposal: ProjectManagementProposal,
): void {
  if (proposal.kind === "action") {
    if (
      draft.entities.projectWorks[proposal.workId]?.projectId !== projectId ||
      draft.entities.projectParticipants[proposal.ownerParticipantId]?.projectId !== projectId ||
      draft.entities.projectParticipants[proposal.ownerParticipantId]?.status !== "active"
    ) {
      throw revisionConflict("待办的Work或负责人不属于当前Project");
    }
    return;
  }
  if (proposal.kind === "decision") {
    if (
      draft.entities.projectParticipants[proposal.decidedByParticipantId]?.projectId !==
        projectId ||
      draft.entities.projectParticipants[proposal.decidedByParticipantId]?.status !== "active"
    ) {
      throw revisionConflict("决策者不属于当前Project");
    }
    return;
  }
  if (
    draft.entities.projectParticipants[proposal.participantId]?.projectId !== projectId ||
    (proposal.workId !== undefined &&
      draft.entities.projectWorks[proposal.workId]?.projectId !== projectId) ||
    (proposal.actionId !== undefined &&
      draft.entities.projectActions[proposal.actionId]?.projectId !== projectId) ||
    proposal.evidenceIds.some((id) => draft.entities.projectEvidence[id]?.projectId !== projectId)
  ) {
    throw revisionConflict("贡献的参与者、工作、待办或Evidence不属于当前Project");
  }
}

function commitManagementProposal(input: {
  readonly draft: Snapshot;
  readonly project: Project;
  readonly proposal: ProjectManagementProposal;
  readonly commandId: CommandId;
  readonly now: string;
  readonly ids: {
    readonly actionId: ReturnType<ProjectIdFactory["action"]>;
    readonly decisionId: ReturnType<ProjectIdFactory["decision"]>;
    readonly contributionId: ReturnType<ProjectIdFactory["contribution"]>;
  };
}): string {
  if (input.proposal.kind === "action") {
    input.draft.entities.projectActions[input.ids.actionId] = {
      schemaVersion: "project-action.v1",
      projectActionId: input.ids.actionId,
      projectId: input.project.projectId,
      workId: input.proposal.workId,
      title: input.proposal.title,
      ownerParticipantId: input.proposal.ownerParticipantId,
      status: "todo",
      ...(input.proposal.dueAt !== undefined ? { dueAt: input.proposal.dueAt } : {}),
      completedEvidenceIds: [],
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return input.ids.actionId;
  }
  if (input.proposal.kind === "decision") {
    input.draft.entities.projectDecisions[input.ids.decisionId] = {
      schemaVersion: "project-decision.v1",
      projectDecisionId: input.ids.decisionId,
      projectId: input.project.projectId,
      question: input.proposal.question,
      options: input.proposal.options,
      choice: input.proposal.choice,
      rationale: input.proposal.rationale,
      decidedByParticipantId: input.proposal.decidedByParticipantId,
      boundProjectRevision: input.project.revision,
      status: "active",
      commandId: input.commandId,
      revision: 1,
      createdAt: input.now,
      updatedAt: input.now,
    };
    return input.ids.decisionId;
  }
  input.draft.entities.projectContributions[input.ids.contributionId] = {
    schemaVersion: "project-contribution.v1",
    projectContributionId: input.ids.contributionId,
    projectId: input.project.projectId,
    participantId: input.proposal.participantId,
    ...(input.proposal.workId !== undefined ? { workId: input.proposal.workId } : {}),
    ...(input.proposal.actionId !== undefined ? { actionId: input.proposal.actionId } : {}),
    kind: input.proposal.contributionKind,
    summary: input.proposal.summary,
    evidenceStatus: input.proposal.evidenceIds.length > 0 ? "verified" : "reported",
    evidenceIds: input.proposal.evidenceIds,
    occurredAt: input.proposal.occurredAt,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  return input.ids.contributionId;
}

function emitManagementRejectedTrace(
  deps: ApplicationDeps,
  candidate: Extract<ProjectCandidate, { candidateKind: "management"; status: "rejected" }>,
  commandId: CommandId,
): void {
  const common = {
    level: "info" as const,
    outcome: "rejected" as const,
    traceId: projectTraceId(candidate.projectId),
    spanId: projectSpanId(candidate.projectCandidateId, commandId),
    projectId: candidate.projectId,
    projectCandidateId: candidate.projectCandidateId,
    candidateRevision: candidate.revision,
    candidateSha256: candidate.candidateSha256,
    commandId,
  };
  if (candidate.proposal.kind === "decision") {
    emitProjectTrace(deps, { ...common, eventName: "project.decision.rejected" });
  } else if (candidate.proposal.kind === "contribution") {
    emitProjectTrace(deps, { ...common, eventName: "project.contribution.rejected" });
  }
}

function emitManagementCommittedTrace(
  deps: ApplicationDeps,
  candidate: Extract<ProjectCandidate, { candidateKind: "management"; status: "confirmed" }>,
  commandId: CommandId,
): void {
  const common = {
    level: "info" as const,
    outcome: "success" as const,
    traceId: projectTraceId(candidate.projectId),
    spanId: projectSpanId(candidate.projectCandidateId, commandId),
    projectId: candidate.projectId,
    commandId,
  };
  if (candidate.proposal.kind === "action") {
    emitProjectTrace(deps, {
      ...common,
      eventName: "project.action.created",
      projectActionId: candidate.committedObjectId as never,
      projectWorkId: candidate.proposal.workId,
      ownerParticipantId: candidate.proposal.ownerParticipantId,
      actionRevision: 1,
    });
  } else if (candidate.proposal.kind === "decision") {
    emitProjectTrace(deps, {
      ...common,
      eventName: "project.decision.committed",
      projectDecisionId: candidate.committedObjectId as never,
      decidedByParticipantId: candidate.proposal.decidedByParticipantId,
      boundProjectRevision: candidate.boundProjectRevision,
      decisionRevision: 1,
    });
  } else {
    emitProjectTrace(deps, {
      ...common,
      eventName: "project.contribution.committed",
      projectContributionId: candidate.committedObjectId as never,
      participantId: candidate.proposal.participantId,
      contributionRevision: 1,
      evidenceStatus: candidate.proposal.evidenceIds.length > 0 ? "verified" : "reported",
      evidenceCount: candidate.proposal.evidenceIds.length,
    });
  }
}

/** Workflow耐久Step调用；模型理解和资源观察都发生在事务外。 */
