import { useState } from "react";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { DecisionRequest, NoteDecisionRequest } from "../contracts.ts";
import type { LifeosProjection } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";

export interface LifeosDockInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  decide: (request: DecisionRequest) => Promise<boolean>;
  decideNote: (request: NoteDecisionRequest) => Promise<boolean>;
}

export type LifeosDockProps = PropsRuntime<"conversation.input.dock"> &
  InjectFace<LifeosDockInjected>;

const PHASE_LABEL: Record<string, string> = {
  queued: "已接收",
  planning: "正在规划",
  plan_review: "等待你审核",
  note_review: "等待你审核笔记",
  executing: "正在执行",
  validating: "正在验证",
  completed: "已完成",
  rejected: "已拒绝",
};

const NOTE_KIND_LABEL: Record<string, string> = {
  idea: "想法",
  project_idea: "项目想法",
  learning: "学习",
  general: "通用",
};

/** 审核Dock是临时命令表面；只有当前版本仍可决定时才展示计划审核。 */
export function hasActionablePlanReview(projection: LifeosProjection | null): boolean {
  const run = projection?.run;
  const plan = projection?.plan;
  const approval = projection?.approval;
  return (
    approval?.status === "open" &&
    run?.status === "waiting_human" &&
    run.phase === "plan_review" &&
    plan !== null &&
    plan !== undefined &&
    plan.planId === approval.planId &&
    plan.planRevision === approval.planRevision &&
    plan.sha256 === approval.planSha256
  );
}

/** Note审核同样只展示当前仍可操作的候选，终态历史由对话和Trajectory承载。 */
export function hasActionableNoteReview(projection: LifeosProjection | null): boolean {
  const run = projection?.run;
  const noteCandidate = projection?.noteCandidate;
  return (
    noteCandidate?.status === "under_review" &&
    run?.status === "waiting_human" &&
    run.phase === "note_review" &&
    noteCandidate.productRunId === run.productRunId
  );
}

export function shouldShowLifeosReviewDock(projection: LifeosProjection | null): boolean {
  return (
    hasActionablePlanReview(projection) ||
    hasActionableNoteReview(projection) ||
    projection?.pendingDecision != null ||
    projection?.pendingNoteDecision != null
  );
}

export function LifeosDock({ useLifeos, decide, decideNote }: LifeosDockProps) {
  const state = useLifeos((value) => value);
  const [explanation, setExplanation] = useState("");
  const projection = state.projection;
  const run = projection?.run;
  const plan = projection?.plan;
  const approval = projection?.approval;
  const noteCandidate = projection?.noteCandidate;
  const canReviewPlan = hasActionablePlanReview(projection);
  const canReviewNote = hasActionableNoteReview(projection);
  const reviewableNoteCandidate =
    canReviewNote && noteCandidate?.status === "under_review" ? noteCandidate : null;
  if (!shouldShowLifeosReviewDock(projection)) return null;

  const submitPlan = async (kind: DecisionRequest["kind"]): Promise<void> => {
    if (
      !canReviewPlan ||
      run === null ||
      run === undefined ||
      approval === null ||
      approval === undefined
    ) {
      return;
    }
    const trimmed = explanation.trim();
    const request: DecisionRequest = {
      kind,
      ...(kind !== "approve" && trimmed !== "" ? { explanation: trimmed } : {}),
      binding: {
        productRunId: run.productRunId,
        runRevision: run.revision,
        approvalRequestId: approval.approvalRequestId,
        planId: approval.planId,
        planRevision: approval.planRevision,
        planSha256: approval.planSha256,
      },
    };
    if (await decide(request)) setExplanation("");
  };
  const submitNote = async (kind: NoteDecisionRequest["kind"]): Promise<void> => {
    if (reviewableNoteCandidate === null || run === null || run === undefined) return;
    const trimmed = explanation.trim();
    const request: NoteDecisionRequest = {
      kind,
      ...(kind !== "confirm" && trimmed !== "" ? { explanation: trimmed } : {}),
      binding: {
        productRunId: run.productRunId,
        runRevision: run.revision,
        noteCandidateId: reviewableNoteCandidate.noteCandidateId,
        candidateRevision: reviewableNoteCandidate.revision,
        candidateSha256: reviewableNoteCandidate.sha256,
      },
    };
    if (await decideNote(request)) setExplanation("");
  };

  return (
    <section
      className="lifeos-card"
      data-testid={
        noteCandidate === null || noteCandidate === undefined
          ? "lifeos-plan-card"
          : "lifeos-note-card"
      }
      aria-label={
        noteCandidate === null || noteCandidate === undefined
          ? "LifeOS 计划与审批"
          : "LifeOS 笔记候选审核"
      }
    >
      <header className="lifeos-header">
        <strong>
          {noteCandidate === null || noteCandidate === undefined
            ? `LifeOS 计划${plan === null || plan === undefined ? "" : ` v${plan.planRevision}`}`
            : `LifeOS 笔记候选 v${noteCandidate.revision}`}
        </strong>
        <span className="lifeos-status" aria-live="polite" data-testid="lifeos-run-status">
          {run === null || run === undefined ? "连接失败" : (PHASE_LABEL[run.phase] ?? run.phase)}
        </span>
      </header>

      {plan !== null && plan !== undefined ? (
        <div className="lifeos-plan">
          <div className="lifeos-objective">{plan.content.objective}</div>
          <div className="lifeos-summary">{plan.content.summary}</div>
          <ol>
            {plan.content.steps.map((step) => (
              <li key={step.stepId}>
                <span>{step.title}</span>
                <small>{step.purpose}</small>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {noteCandidate !== null && noteCandidate !== undefined ? (
        <article className="lifeos-note" data-testid="lifeos-note-candidate">
          <div className="lifeos-note-heading">
            <strong>{noteCandidate.proposed.title}</strong>
            <span>
              {NOTE_KIND_LABEL[noteCandidate.proposed.kind] ?? noteCandidate.proposed.kind}
            </span>
          </div>
          {noteCandidate.proposed.tags.length > 0 ? (
            <div className="lifeos-note-tags" aria-label="笔记标签">
              {noteCandidate.proposed.tags.map((tag) => (
                <span key={tag.key}>{tag.label}</span>
              ))}
            </div>
          ) : null}
          <div className="lifeos-note-content">{noteCandidate.proposed.contentMarkdown}</div>
          <small className="lifeos-note-sources">来源 {noteCandidate.sourceRefs.length} 项</small>
        </article>
      ) : null}

      {projection?.pendingDecision !== null && projection?.pendingDecision !== undefined ? (
        <div className="lifeos-warning" data-testid="lifeos-pending-decision">
          <p>上一决定结果仍未知；只能原样重试。</p>
          <button
            type="button"
            data-testid="lifeos-retry-decision"
            disabled={state.submitting}
            onClick={() => void decide(projection.pendingDecision!)}
          >
            重试上一决定
          </button>
        </div>
      ) : null}

      {projection?.pendingNoteDecision !== null && projection?.pendingNoteDecision !== undefined ? (
        <div className="lifeos-warning" data-testid="lifeos-pending-note-decision">
          <p>上一笔记决定结果仍未知；只能原样重试。</p>
          <button
            type="button"
            data-testid="lifeos-retry-note-decision"
            disabled={state.submitting}
            onClick={() => void decideNote(projection.pendingNoteDecision!)}
          >
            重试上一决定
          </button>
        </div>
      ) : null}

      {canReviewPlan && projection?.pendingDecision === null ? (
        <div className="lifeos-review" data-testid="lifeos-approval-card">
          <textarea
            aria-label="修订要求或拒绝原因"
            value={explanation}
            maxLength={2_000}
            placeholder="需要修改时填写修订要求；拒绝时可填写原因"
            onChange={(event) => {
              setExplanation(event.currentTarget.value);
            }}
          />
          <div className="lifeos-actions">
            <button
              type="button"
              data-testid="lifeos-request-revision"
              disabled={
                state.submitting ||
                explanation.trim() === "" ||
                run === null ||
                run === undefined ||
                !run.allowedActions.includes("request_revision")
              }
              onClick={() => void submitPlan("request_revision")}
            >
              要求修订
            </button>
            <button
              type="button"
              data-testid="lifeos-reject"
              disabled={
                state.submitting ||
                run === null ||
                run === undefined ||
                !run.allowedActions.includes("reject")
              }
              onClick={() => void submitPlan("reject")}
            >
              拒绝
            </button>
            <button
              type="button"
              className="lifeos-primary"
              data-testid="lifeos-approve"
              disabled={
                state.submitting ||
                run === null ||
                run === undefined ||
                !run.allowedActions.includes("approve")
              }
              onClick={() => void submitPlan("approve")}
            >
              批准并执行
            </button>
          </div>
        </div>
      ) : null}

      {reviewableNoteCandidate !== null && projection?.pendingNoteDecision === null ? (
        <div className="lifeos-review" data-testid="lifeos-note-review-card">
          <textarea
            aria-label="笔记修订要求或拒绝原因"
            value={explanation}
            maxLength={2_000}
            placeholder="要求修订时填写说明；拒绝时可填写原因"
            onChange={(event) => {
              setExplanation(event.currentTarget.value);
            }}
          />
          <div className="lifeos-actions">
            <button
              type="button"
              data-testid="lifeos-request-note-revision"
              disabled={
                state.submitting ||
                explanation.trim() === "" ||
                !reviewableNoteCandidate.allowedActions.includes("request_revision")
              }
              onClick={() => void submitNote("request_revision")}
            >
              要求修订
            </button>
            <button
              type="button"
              data-testid="lifeos-reject-note"
              disabled={
                state.submitting || !reviewableNoteCandidate.allowedActions.includes("reject")
              }
              onClick={() => void submitNote("reject")}
            >
              拒绝
            </button>
            <button
              type="button"
              className="lifeos-primary"
              data-testid="lifeos-confirm-note"
              disabled={
                state.submitting || !reviewableNoteCandidate.allowedActions.includes("confirm")
              }
              onClick={() => void submitNote("confirm")}
            >
              确认笔记
            </button>
          </div>
        </div>
      ) : null}

      {state.error !== null ? (
        <p className="lifeos-error" role="alert" data-testid="lifeos-error">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
