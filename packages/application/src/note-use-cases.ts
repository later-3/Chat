import {
  noteCandidateSchema,
  noteDecisionSchema,
  messageSchema,
  noteRevisionSchema,
  type Note,
  type NoteCandidate,
  type NoteCandidateReviewDto,
  type NoteDecision,
  type NoteDecisionDto,
  type NoteDetailDto,
  type NoteRevisionInput,
  type PrincipalId,
  type ProductRunId,
  type SubmitNoteDecisionPayload,
  type WorkflowPolicyResolution,
} from "@chat/contracts";
import {
  assertNoteAggregateIntegrity,
  assertNoteCandidateIntegrity,
  assertNoteCandidateSuccessor,
  assertNoteCandidateTransition,
  assertNoteDecisionBinding,
  computeNoteCandidateSha256,
  computeNoteRevisionSha256,
  hashCanonical,
} from "@chat/domain";
import type { ApplicationDeps, NoteIdFactory } from "./deps.js";
import { forbidden, notFound, revisionConflict } from "./errors.js";
import {
  applyNoteLowRiskPolicy,
  assertNoteClassifyTagPolicy,
  deriveCandidateSourceRefsFromRunSpec,
  latestCandidate,
  resolveNoteReviewMode,
} from "./note-candidate-policy.js";
import {
  noteCurrentRevision,
  toCandidateReview,
  toDecisionDto,
  toNoteDetail,
} from "./note-query-use-cases.js";
import { normalizeNoteRevisionInput } from "./note-revision-helpers.js";
import {
  noteCandidateRef,
  noteDecisionRef,
  noteRevisionRef,
  projectNoteNode,
  workflowPolicyResolutionRef,
} from "./note-workflow-projection.js";
import { requireNoteCaptureRun, type NoteCaptureProductRun } from "./product-run-kind.js";

type CommandId = Parameters<ApplicationDeps["store"]["transact"]>[0]["commandId"];

function strictlyAfter(base: string, candidate: string): string {
  return Date.parse(candidate) > Date.parse(base)
    ? candidate
    : new Date(Date.parse(base) + 1).toISOString();
}

function requireNoteIds(deps: ApplicationDeps): NoteIdFactory {
  if (deps.noteIds === undefined) {
    throw new Error("NoteIdFactory未配置，不能执行Note用例");
  }
  return deps.noteIds;
}

export {
  getCurrentNoteCandidate,
  getNote,
  getNoteHistory,
  listNotes,
  prepareNoteCaptureInputForRuntime,
} from "./note-query-use-cases.js";

export { archiveNote, restoreNote, reviseNote } from "./note-management-use-cases.js";

/**
 * 规模责任审查：本模块只保留Workflow Note的Candidate、Decision与Commit事务协调。
 * Query/普通Note维护、Node投影和确定性Policy计算已经外提；以下长函数保留完整mutate
 * 闭包，是为了让Candidate/Resolution/Run/Node/Outbox或Note/Message/Run/Node整体回滚。
 * 下一安全切点是继续抽无副作用的对象构造器，而不是把一个产品事务拆成多个Service调用。
 */
export async function publishNoteCandidate(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly commandId: CommandId;
    readonly proposed: NoteRevisionInput;
  },
): Promise<{
  readonly candidate: NoteCandidateReviewDto;
  readonly review:
    | { readonly outcome: "waiting_human" }
    | {
        readonly outcome: "policy_denied_waiting_human" | "auto_continued";
        readonly policyResolutionRef: {
          readonly workflowPolicyResolutionId: WorkflowPolicyResolution["workflowPolicyResolutionId"];
          readonly revision: 1;
          readonly sha256: string;
        };
      };
}> {
  const ids = requireNoteIds(deps);
  const now = deps.now();
  const candidateId = ids.candidate();
  const requestSha256 = hashCanonical("command.publish-note-candidate.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "PublishNoteCandidate",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const noteRun = requireNoteCaptureRun(run);
      const workflowRunSpecId = noteRun.workflowRunSpecId;
      if (workflowRunSpecId === undefined) {
        throw revisionConflict("Note Candidate的Run缺少RunSpec");
      }
      const runSpec = draft.entities.workflowRunSpecs[workflowRunSpecId];
      if (
        runSpec === undefined ||
        runSpec.productRunId !== input.productRunId ||
        runSpec.businessInput?.kind !== "note_capture"
      ) {
        throw revisionConflict("Note Candidate的RunSpec不存在或绑定无效");
      }
      const reviewMode = resolveNoteReviewMode(runSpec);
      const sourceRefs = deriveCandidateSourceRefsFromRunSpec(draft.entities, noteRun);
      const previous = latestCandidate(draft.entities, input.productRunId, "revision_requested");
      const existingCandidates = Object.values(draft.entities.noteCandidates).filter(
        (candidate) => candidate.productRunId === input.productRunId,
      );
      if (previous === undefined) {
        if (
          noteRun.status !== "pending" ||
          noteRun.phase !== "queued" ||
          existingCandidates.length !== 0
        ) {
          throw revisionConflict("Note首个Candidate只能从queued运行创建");
        }
      } else {
        const revisionDecision = Object.values(draft.entities.noteDecisions).find(
          (decision) =>
            decision.productRunId === input.productRunId &&
            decision.noteCandidateId === previous.noteCandidateId &&
            decision.kind === "request_revision" &&
            decision.candidateRevision + 1 === previous.revision &&
            decision.candidateSha256 === previous.sha256,
        );
        if (
          noteRun.status !== "running" ||
          noteRun.phase !== "extracting" ||
          revisionDecision === undefined
        ) {
          throw revisionConflict("Note修订Candidate只能从request_revision恢复后创建");
        }
      }
      const sequence =
        Math.max(0, ...existingCandidates.map((candidate) => candidate.candidateSequence)) + 1;
      const draftInput = normalizeNoteRevisionInput(input.proposed);
      // Workflow Step的同名校验只是早失败；Application必须从RunSpec重读冻结配置，
      // 防止恶意或旧Runtime直接调用私有命令绕过allowCustomTags。
      assertNoteClassifyTagPolicy(runSpec, draftInput.tags);
      const immutable = {
        noteCandidateId: candidateId,
        productRunId: input.productRunId,
        candidateSequence: sequence,
        ...(previous === undefined ? {} : { supersedesCandidateId: previous.noteCandidateId }),
        proposed: draftInput,
        sourceRefs,
      };
      const candidate = noteCandidateSchema.parse({
        schemaVersion: "note-candidate.v1",
        ...immutable,
        sha256: computeNoteCandidateSha256(immutable),
        status: "under_review",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      assertNoteCandidateIntegrity(candidate);
      if (previous !== undefined)
        assertNoteCandidateSuccessor({ current: previous, next: candidate });
      if (reviewMode.mode === "manual") {
        draft.entities.noteCandidates[candidateId] = candidate;
        const waitingRun: NoteCaptureProductRun = {
          ...noteRun,
          status: "waiting_human",
          phase: "note_review",
          revision: noteRun.revision + 1,
          updatedAt: now,
        };
        draft.entities.runs[input.productRunId] = waitingRun;
        projectNoteNode(draft, {
          run: waitingRun,
          nodeType: "human.note_review",
          iteration: candidate.candidateSequence,
          toStatus: "waiting_human",
          publicSummary: "等待人工审核Note候选",
          inputSlots: [{ name: "candidate", refs: [noteCandidateRef(candidate)] }],
          outputSlots: [],
          relatedProductRef: noteCandidateRef(candidate),
          at: now,
        });
        return { resultRefs: { noteCandidateId: candidateId, productRunId: input.productRunId } };
      }

      const policyAt = strictlyAfter(candidate.updatedAt, deps.now());
      const { policyCandidate, resolution } = applyNoteLowRiskPolicy({
        candidate,
        runSpec,
        definitionNodeId: reviewMode.definitionNodeId,
        policyAt,
      });
      const { workflowPolicyResolutionId } = resolution;
      const policyAllowed = resolution.outcome === "allowed";
      const existingResolution =
        draft.entities.workflowPolicyResolutions[workflowPolicyResolutionId];
      if (existingResolution !== undefined && existingResolution.sha256 !== resolution.sha256) {
        throw revisionConflict("Workflow Policy Resolution稳定身份发生Hash冲突");
      }
      draft.entities.noteCandidates[candidateId] = policyCandidate;
      draft.entities.workflowPolicyResolutions[workflowPolicyResolutionId] =
        existingResolution ?? resolution;
      const policyRef = workflowPolicyResolutionRef(resolution);
      const policyRun: NoteCaptureProductRun = {
        ...noteRun,
        ...(policyAllowed
          ? { status: "running" as const, phase: "committing" as const }
          : { status: "waiting_human" as const, phase: "note_review" as const }),
        revision: noteRun.revision + 1,
        updatedAt: policyAt,
      };
      draft.entities.runs[input.productRunId] = policyRun;
      projectNoteNode(draft, {
        run: policyRun,
        nodeType: "human.note_review",
        iteration: policyCandidate.candidateSequence,
        toStatus: policyAllowed ? "succeeded" : "waiting_human",
        ...(policyAllowed ? { outcomeCode: "approved" } : {}),
        publicSummary: policyAllowed
          ? "系统低风险策略允许自动继续"
          : "系统策略要求人工审核Note候选",
        inputSlots: [{ name: "candidate", refs: [noteCandidateRef(policyCandidate)] }],
        outputSlots: [{ name: "policy_resolution", refs: [policyRef] }],
        relatedProductRef: policyAllowed ? policyRef : noteCandidateRef(policyCandidate),
        at: policyAt,
      });
      return {
        resultRefs: {
          noteCandidateId: candidateId,
          productRunId: input.productRunId,
          workflowPolicyResolutionId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const candidate = snapshot.entities.noteCandidates[result.resultRefs["noteCandidateId"] ?? ""];
  if (candidate === undefined) throw notFound("Note Candidate不存在");
  const resolutionId = result.resultRefs["workflowPolicyResolutionId"];
  if (resolutionId === undefined) {
    return { candidate: toCandidateReview(candidate), review: { outcome: "waiting_human" } };
  }
  const resolution = snapshot.entities.workflowPolicyResolutions[resolutionId];
  if (resolution === undefined) throw notFound("Workflow Policy Resolution不存在");
  const policyResolutionRef = {
    workflowPolicyResolutionId: resolution.workflowPolicyResolutionId,
    revision: resolution.revision,
    sha256: resolution.sha256,
  };
  return {
    candidate: toCandidateReview(candidate),
    review:
      resolution.outcome === "allowed"
        ? { outcome: "auto_continued", policyResolutionRef }
        : { outcome: "policy_denied_waiting_human", policyResolutionRef },
  };
}

export async function submitNoteDecision(
  deps: ApplicationDeps,
  input: {
    readonly principalId: PrincipalId;
    readonly commandId: CommandId;
    readonly expectedRunRevision: number;
    readonly payload: SubmitNoteDecisionPayload;
  },
): Promise<{ readonly decision: NoteDecisionDto; readonly candidate: NoteCandidateReviewDto }> {
  const ids = requireNoteIds(deps);
  const now = deps.now();
  const decidedAt = strictlyAfter(now, deps.now());
  const decisionId = ids.decision();
  const successorId = ids.candidate();
  const outboxId = deps.ids.outbox();
  const requestSha256 = hashCanonical("command.submit-note-decision.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "SubmitNoteDecision",
    requestSha256,
    traceContext: { productRunId: input.payload.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.payload.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const noteRun = requireNoteCaptureRun(run);
      if (noteRun.workflowRunSpecId === undefined) {
        throw revisionConflict("Note Capture Run缺少Workflow RunSpec");
      }
      if (noteRun.revision !== input.expectedRunRevision) {
        throw revisionConflict("Note Run已变化，请刷新后重试");
      }
      if (noteRun.status !== "waiting_human" || noteRun.phase !== "note_review") {
        throw revisionConflict("Note Run当前不在人工审核阶段");
      }
      const session = draft.entities.sessions[noteRun.sessionId];
      if (session?.ownerPrincipalId !== input.principalId) throw forbidden("无权决定该Note候选");
      const current = draft.entities.noteCandidates[input.payload.noteCandidateId];
      if (current === undefined || current.productRunId !== input.payload.productRunId) {
        throw notFound("Note Candidate不存在");
      }
      const currentUnderReview = latestCandidate(
        draft.entities,
        input.payload.productRunId,
        "under_review",
      );
      if (currentUnderReview?.noteCandidateId !== current.noteCandidateId) {
        throw revisionConflict("Note Candidate不是当前待审核候选");
      }
      if (
        current.revision !== input.payload.candidateRevision ||
        current.sha256 !== input.payload.candidateSha256
      ) {
        throw revisionConflict("Note Candidate已变化，请刷新后重试");
      }
      let decisionAt = strictlyAfter(current.updatedAt, decidedAt);
      let target = current;
      if (input.payload.kind === "confirm" && input.payload.editedProposal !== undefined) {
        const successorCreatedAt = decisionAt;
        decisionAt = strictlyAfter(successorCreatedAt, decisionAt);
        const draftInput = normalizeNoteRevisionInput(input.payload.editedProposal);
        const immutable = {
          noteCandidateId: successorId,
          productRunId: current.productRunId,
          candidateSequence: current.candidateSequence + 1,
          supersedesCandidateId: current.noteCandidateId,
          proposed: draftInput,
          sourceRefs: current.sourceRefs.map((ref) => ({ ...ref })),
        };
        const successor = noteCandidateSchema.parse({
          schemaVersion: "note-candidate.v1",
          ...immutable,
          sha256: computeNoteCandidateSha256(immutable),
          status: "under_review",
          revision: 1,
          createdAt: successorCreatedAt,
          updatedAt: successorCreatedAt,
        });
        const requested: NoteCandidate = {
          ...current,
          status: "revision_requested",
          revision: current.revision + 1,
          updatedAt: successorCreatedAt,
        };
        assertNoteCandidateTransition({ current, next: requested });
        assertNoteCandidateSuccessor({ current: requested, next: successor });
        draft.entities.noteCandidates[current.noteCandidateId] = requested;
        draft.entities.noteCandidates[successorId] = successor;
        target = successor;
      }
      const decision = noteDecisionSchema.parse({
        schemaVersion: "note-decision.v1",
        noteDecisionId: decisionId,
        productRunId: target.productRunId,
        noteCandidateId: target.noteCandidateId,
        candidateRevision: target.revision,
        candidateSha256: target.sha256,
        kind: input.payload.kind,
        ...(input.payload.kind === "request_revision"
          ? { revisionInstruction: input.payload.revisionInstruction }
          : {}),
        ...(input.payload.kind === "reject" && input.payload.reason !== undefined
          ? { reason: input.payload.reason }
          : {}),
        principalId: input.principalId,
        commandId: input.commandId,
        revision: 1,
        createdAt: decisionAt,
      });
      assertNoteDecisionBinding({ candidate: target, decision });
      const nextStatus =
        decision.kind === "confirm"
          ? "confirmed"
          : decision.kind === "request_revision"
            ? "revision_requested"
            : "rejected";
      const decided: NoteCandidate = {
        ...target,
        status: nextStatus,
        revision: target.revision + 1,
        updatedAt: decisionAt,
      };
      assertNoteCandidateTransition({ current: target, next: decided });
      draft.entities.noteDecisions[decisionId] = decision;
      draft.entities.noteCandidates[target.noteCandidateId] = decided;
      const resumedRun =
        decision.kind === "confirm"
          ? { status: "running" as const, phase: "committing" as const }
          : decision.kind === "request_revision"
            ? { status: "running" as const, phase: "extracting" as const }
            : { status: "cancelled" as const, phase: "rejected" as const };
      const decidedRun: NoteCaptureProductRun = {
        ...noteRun,
        ...resumedRun,
        revision: noteRun.revision + 1,
        updatedAt: decisionAt,
      };
      draft.entities.runs[input.payload.productRunId] = decidedRun;
      const policyResolution = Object.values(draft.entities.workflowPolicyResolutions).find(
        (resolution) =>
          resolution.productRunId === input.payload.productRunId &&
          resolution.noteCandidateId === current.noteCandidateId &&
          resolution.outcome === "denied",
      );
      projectNoteNode(draft, {
        run: decidedRun,
        nodeType: "human.note_review",
        iteration: current.candidateSequence,
        toStatus: decision.kind === "reject" ? "cancelled" : "succeeded",
        outcomeCode:
          decision.kind === "confirm"
            ? "approved"
            : decision.kind === "request_revision"
              ? "request_revision"
              : "rejected",
        publicSummary:
          decision.kind === "confirm"
            ? "Note候选已确认"
            : decision.kind === "request_revision"
              ? "Note候选需要修订"
              : "Note候选已拒绝",
        // Manifest是进入审核时的不可变证据：edited confirm产生的successor只能由Decision
        // 关联，不能覆盖原来等待审核的Candidate输入。
        inputSlots: [{ name: "candidate", refs: [noteCandidateRef(current)] }],
        outputSlots:
          policyResolution === undefined
            ? [{ name: "decision", refs: [noteDecisionRef(decision)] }]
            : [
                {
                  name: "policy_resolution",
                  refs: [workflowPolicyResolutionRef(policyResolution)],
                },
              ],
        relatedProductRef: noteDecisionRef(decision),
        at: decisionAt,
      });
      draft.outbox[outboxId] = {
        schemaVersion: "outbox-entry.v1",
        outboxId,
        kind: "workflow_resume",
        status: "pending",
        productRunId: noteRun.productRunId,
        hookNoteCandidateId: current.noteCandidateId,
        noteCandidateId: target.noteCandidateId,
        noteDecisionId: decisionId,
        workflowRunSpecId: noteRun.workflowRunSpecId,
        runnerFamily: noteRun.runnerFamily,
        runnerBundleVersion: noteRun.runnerBundleVersion,
        dispatchAttempts: 0,
        revision: 1,
        createdAt: decisionAt,
        updatedAt: decisionAt,
      };
      return {
        resultRefs: { noteDecisionId: decisionId, noteCandidateId: target.noteCandidateId },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const decision = snapshot.entities.noteDecisions[result.resultRefs["noteDecisionId"] ?? ""];
  const candidate = snapshot.entities.noteCandidates[result.resultRefs["noteCandidateId"] ?? ""];
  if (decision === undefined || candidate === undefined) throw notFound("Note Decision不存在");
  return { decision: toDecisionDto(decision), candidate: toCandidateReview(candidate) };
}

export async function loadNoteDecisionForRuntime(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly workflowRunSpecId: NonNullable<NoteCaptureProductRun["workflowRunSpecId"]>;
    readonly noteCandidateId: NoteCandidate["noteCandidateId"];
    readonly noteDecisionId: NoteDecision["noteDecisionId"];
  },
): Promise<{ readonly decision: NoteDecisionDto; readonly candidate: NoteCandidateReviewDto }> {
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const run = snapshot.entities.runs[input.productRunId];
  if (run === undefined) throw notFound("Product Run不存在");
  const noteRun = requireNoteCaptureRun(run);
  if (noteRun.workflowRunSpecId !== input.workflowRunSpecId) {
    throw revisionConflict("Note Decision加载的RunSpec与Run绑定不一致");
  }
  const runSpec = snapshot.entities.workflowRunSpecs[input.workflowRunSpecId];
  if (
    runSpec === undefined ||
    runSpec.productRunId !== input.productRunId ||
    runSpec.businessInput?.kind !== "note_capture"
  ) {
    throw revisionConflict("Note Decision加载的RunSpec无效");
  }
  const candidate = snapshot.entities.noteCandidates[input.noteCandidateId];
  if (candidate === undefined || candidate.productRunId !== input.productRunId) {
    throw notFound("Note Candidate不存在");
  }
  const decision = snapshot.entities.noteDecisions[input.noteDecisionId];
  if (decision === undefined || decision.productRunId !== input.productRunId) {
    throw notFound("Note Decision不存在");
  }
  if (
    decision.noteCandidateId !== candidate.noteCandidateId ||
    decision.candidateSha256 !== candidate.sha256 ||
    decision.candidateRevision + 1 !== candidate.revision
  ) {
    throw revisionConflict("Note Decision与Candidate当前事实不一致");
  }
  return { decision: toDecisionDto(decision), candidate: toCandidateReview(candidate) };
}

export async function commitConfirmedNote(
  deps: ApplicationDeps,
  input: {
    readonly productRunId: ProductRunId;
    readonly noteCandidateId: NoteCandidate["noteCandidateId"];
    readonly commandId: CommandId;
  },
): Promise<{ readonly note: NoteDetailDto }> {
  const ids = requireNoteIds(deps);
  const now = deps.now();
  const noteId = ids.note();
  const revisionId = ids.revision();
  const finalMessageId = deps.ids.message();
  const requestSha256 = hashCanonical("command.commit-confirmed-note.v1", input);
  const result = await deps.store.transact({
    commandId: input.commandId,
    commandType: "CommitConfirmedNote",
    requestSha256,
    traceContext: { productRunId: input.productRunId },
    mutate: (draft) => {
      const run = draft.entities.runs[input.productRunId];
      if (run === undefined) throw notFound("Product Run不存在");
      const noteRun = requireNoteCaptureRun(run);
      if (noteRun.status !== "running" || noteRun.phase !== "committing") {
        throw revisionConflict("Note Run当前不在提交阶段");
      }
      const session = draft.entities.sessions[noteRun.sessionId];
      if (session === undefined) throw notFound("Session不存在");
      const candidate = draft.entities.noteCandidates[input.noteCandidateId];
      if (candidate === undefined || candidate.productRunId !== input.productRunId) {
        throw notFound("Note Candidate不存在");
      }
      if (candidate.status !== "confirmed")
        throw revisionConflict("未确认的Note Candidate不能提交");
      const currentConfirmed = latestCandidate(draft.entities, input.productRunId, "confirmed");
      if (currentConfirmed?.noteCandidateId !== candidate.noteCandidateId) {
        throw revisionConflict("Note Candidate不是当前已确认候选");
      }
      const confirmDecision = Object.values(draft.entities.noteDecisions).find(
        (decision) =>
          decision.productRunId === input.productRunId &&
          decision.noteCandidateId === candidate.noteCandidateId &&
          decision.kind === "confirm" &&
          decision.candidateRevision + 1 === candidate.revision &&
          decision.candidateSha256 === candidate.sha256,
      );
      const policyResolution = Object.values(draft.entities.workflowPolicyResolutions).find(
        (resolution) =>
          resolution.productRunId === input.productRunId &&
          resolution.noteCandidateId === candidate.noteCandidateId &&
          resolution.candidateRevision === candidate.revision &&
          resolution.candidateSha256 === candidate.sha256 &&
          resolution.outcome === "allowed",
      );
      if (confirmDecision === undefined && policyResolution === undefined) {
        throw revisionConflict("Note Candidate缺少精确Confirm Decision或允许的Policy Resolution");
      }
      if (
        Object.values(draft.entities.notes).some(
          (note) => note.sourceCandidateId === candidate.noteCandidateId,
        )
      ) {
        throw revisionConflict("Note Candidate已提交，请重新读取");
      }
      const revision = noteRevisionSchema.parse({
        schemaVersion: "note-revision.v1",
        noteRevisionId: revisionId,
        noteId,
        noteRevision: 1,
        ...candidate.proposed,
        sourceRefs: candidate.sourceRefs.map((ref) => ({ ...ref })),
        createdByPrincipalId: session.ownerPrincipalId,
        sha256: computeNoteRevisionSha256({
          noteId,
          noteRevision: 1,
          ...candidate.proposed,
          sourceRefs: candidate.sourceRefs,
          createdByPrincipalId: session.ownerPrincipalId,
        }),
        createdAt: now,
      });
      const note: Note = {
        schemaVersion: "note.v1",
        noteId,
        ownerPrincipalId: session.ownerPrincipalId,
        sourceCandidateId: candidate.noteCandidateId,
        currentRevisionId: revisionId,
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      assertNoteAggregateIntegrity({ note, revisions: [revision] });
      const finalMessage = messageSchema.parse({
        schemaVersion: "message.v1",
        messageId: finalMessageId,
        sessionId: noteRun.sessionId,
        sessionSequence: session.lastMessageSequence + 1,
        role: "assistant",
        content: {
          format: "markdown",
          text: `已保存笔记：${candidate.proposed.title}`,
        },
        sourceRunId: input.productRunId,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
      draft.entities.noteRevisions[revisionId] = revision;
      draft.entities.notes[noteId] = note;
      draft.entities.messages[finalMessageId] = finalMessage;
      draft.entities.sessions[noteRun.sessionId] = {
        ...session,
        lastMessageSequence: finalMessage.sessionSequence,
        revision: session.revision + 1,
        updatedAt: now,
      };
      const completedRun: NoteCaptureProductRun = {
        ...noteRun,
        status: "succeeded",
        phase: "completed",
        finalMessageId,
        revision: noteRun.revision + 1,
        updatedAt: now,
      };
      draft.entities.runs[input.productRunId] = completedRun;
      projectNoteNode(draft, {
        run: completedRun,
        nodeType: "note.commit",
        iteration: candidate.candidateSequence,
        toStatus: "succeeded",
        outcomeCode: "committed",
        publicSummary: "Note已保存",
        inputSlots: [{ name: "candidate", refs: [noteCandidateRef(candidate)] }],
        outputSlots: [{ name: "note", refs: [noteRevisionRef(revision)] }],
        relatedProductRef: noteRevisionRef(revision),
        at: now,
      });
      return {
        resultRefs: {
          noteId,
          noteRevisionId: revisionId,
          productRunId: input.productRunId,
          finalMessageId,
        },
      };
    },
  });
  const { snapshot } = await deps.store.read({ kind: "committedSnapshot" });
  const note = snapshot.entities.notes[result.resultRefs["noteId"] ?? ""];
  if (note === undefined) throw notFound("Note不存在");
  return { note: toNoteDetail(note, noteCurrentRevision(snapshot, note)) };
}
