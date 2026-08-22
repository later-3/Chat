import {
  type BeginProjectIntakePayload,
  type CommandId,
  type PrincipalId,
  type ProjectCandidateDto,
  type ProjectRootDto,
} from "@chat/contracts";
import { PROJECT_API_SCHEMA_VERSION } from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { type ApplicationDeps } from "../deps.js";
import { ApplicationError, forbidden, notFound, revisionConflict } from "../errors.js";
import {
  requireProjectRoots,
  requireProjectIds,
  emitProjectTrace,
  projectTraceId,
  projectSpanId,
  toCandidateDto,
} from "./shared.js";

export async function listProjectRoots(
  deps: ApplicationDeps,
): Promise<{ roots: ProjectRootDto[] }> {
  return {
    roots: requireProjectRoots(deps)
      .list()
      .map((root) => ({
        schemaVersion: PROJECT_API_SCHEMA_VERSION,
        rootId: root.rootId,
        displayName: root.displayName,
        enabledAdapters: [...root.enabledAdapters],
      })),
  };
}

export async function beginProjectIntake(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly payload: BeginProjectIntakePayload;
  },
): Promise<{ candidate: ProjectCandidateDto }> {
  const descriptor = requireProjectRoots(deps)
    .list()
    .find((root) => root.rootId === input.payload.rootId);
  if (descriptor === undefined) {
    throw new ApplicationError({
      code: "validation_failed",
      httpStatus: 400,
      message: "所选Project Root不存在",
    });
  }
  const now = deps.now();
  const messageId = deps.ids.message();
  const candidateId = requireProjectIds(deps).candidate();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.begin-project-intake.v1", {
    principalId: input.principalId,
    payload: input.payload,
  });
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "BeginProjectIntake",
    requestSha256,
    traceContext: { productSessionId: input.payload.sessionId },
    mutate: (draft) => {
      const session = draft.entities.sessions[input.payload.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      if (session.ownerPrincipalId !== input.principalId) throw forbidden("无权在该Session建项");
      if (session.status !== "active") throw revisionConflict("已归档Session不能建项");
      const active = Object.values(draft.entities.projectCandidates).some(
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          (candidate.status === "queued" || candidate.status === "under_review"),
      );
      if (active) throw revisionConflict("当前Session已有未决定的建项方案");
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
        candidateKind: "intake",
        rootId: input.payload.rootId,
        status: "queued",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "project_intake_start",
        status: "pending",
        projectCandidateId: candidateId,
        expectedCandidateRevision: 1,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      return { resultRefs: { projectCandidateId: candidateId, messageId } };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.projectCandidates[result.resultRefs.projectCandidateId ?? ""];
  if (candidate === undefined) throw notFound("建项方案不存在");
  if (!result.replayed) {
    emitProjectTrace(deps, {
      level: "info",
      eventName: "project.intake.started",
      outcome: "unknown",
      traceId: projectTraceId(candidate.projectCandidateId),
      spanId: projectSpanId(candidate.projectCandidateId, input.commandId),
      projectCandidateId: candidate.projectCandidateId,
      productSessionId: candidate.sessionId,
      commandId: input.commandId,
      candidateRevision: candidate.revision,
    });
  }
  return { candidate: toCandidateDto(candidate) };
}
