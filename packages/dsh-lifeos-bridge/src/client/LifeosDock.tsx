import { useState } from "react";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  DecisionRequest,
  DshSendReviewDecisionRequest,
  NoteDecisionRequest,
  PromptReviewDecisionRequest,
  ProjectBootstrapDecisionRequest,
} from "../contracts.ts";
import type { LifeosProjection } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";
import { BridgeSendPreview } from "./DshBridgeSendPreview.tsx";

export interface LifeosDockInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  decide: (request: DecisionRequest) => Promise<boolean>;
  decideNote: (request: NoteDecisionRequest) => Promise<boolean>;
  decidePromptReview: (request: PromptReviewDecisionRequest) => Promise<boolean>;
  decideDshSendReview: (request: DshSendReviewDecisionRequest) => Promise<boolean>;
  decideProjectBootstrap: (request: ProjectBootstrapDecisionRequest) => Promise<boolean>;
  openProjectWorkspace: (cwd: string) => Promise<void>;
  openPlaneProject: (url: string) => void;
}

export type LifeosDockProps = PropsRuntime<"conversation.input.dock"> &
  InjectFace<LifeosDockInjected>;

const PHASE_LABEL: Record<string, string> = {
  plan_review: "等待你审核",
  note_review: "等待你审核笔记",
  prompt_review: "等待你审核发送内容",
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

/** 执行Agent的Provider请求只有在当前Product Review仍open时才可批准或拒绝。 */
export function hasActionablePromptReview(projection: LifeosProjection | null): boolean {
  const run = projection?.run;
  const review = projection?.promptReview;
  return (
    review?.status === "open" &&
    run?.status === "waiting_human" &&
    run.phase === "prompt_review" &&
    review.productRunId === run.productRunId
  );
}

export function shouldShowLifeosReviewDock(projection: LifeosProjection | null): boolean {
  return (
    hasActionablePlanReview(projection) ||
    hasActionableNoteReview(projection) ||
    hasActionablePromptReview(projection) ||
    projection?.dshSendReview != null ||
    projection?.pendingDecision != null ||
    projection?.pendingNoteDecision != null ||
    projection?.pendingPromptReviewDecision != null ||
    projection?.projectBootstrap != null
  );
}

export function LifeosDock({
  useLifeos,
  decide,
  decideNote,
  decidePromptReview,
  decideDshSendReview,
  decideProjectBootstrap,
  openProjectWorkspace,
  openPlaneProject,
}: LifeosDockProps) {
  const state = useLifeos((value) => value);
  const [explanation, setExplanation] = useState("");
  const [promptView, setPromptView] = useState<"readable" | "raw">("readable");
  const projection = state.projection;
  const run = projection?.run;
  const plan = projection?.plan;
  const approval = projection?.approval;
  const noteCandidate = projection?.noteCandidate;
  const canReviewPlan = hasActionablePlanReview(projection);
  const canReviewNote = hasActionableNoteReview(projection);
  const canReviewPrompt = hasActionablePromptReview(projection);
  const promptReview = projection?.promptReview ?? null;
  const dshSendReview = projection?.dshSendReview ?? null;
  const reviewableNoteCandidate =
    canReviewNote && noteCandidate?.status === "under_review" ? noteCandidate : null;
  const projectBootstrap = projection?.projectBootstrap ?? null;
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
  const submitPromptReview = async (kind: PromptReviewDecisionRequest["kind"]): Promise<void> => {
    if (!canReviewPrompt || promptReview === null || run === null || run === undefined) return;
    const trimmed = explanation.trim();
    const request: PromptReviewDecisionRequest = {
      kind,
      ...(kind === "reject" && trimmed !== "" ? { explanation: trimmed } : {}),
      binding: {
        productRunId: run.productRunId,
        runRevision: run.revision,
        promptReviewRequestId: promptReview.promptReviewRequestId,
        requestRevision: promptReview.requestRevision,
        reviewSha256: promptReview.reviewSha256,
        payloadSha256: promptReview.payloadSha256,
      },
    };
    if (await decidePromptReview(request)) setExplanation("");
  };

  if (dshSendReview !== null) {
    return (
      <section
        className="lifeos-card lifeos-dsh-send-review-card"
        data-testid="lifeos-dsh-send-review-card"
        aria-label="DSH发送前审核"
      >
        <header className="lifeos-header">
          <strong>DSH → Bridge 发送前审核</strong>
          <span className="lifeos-status">等待你确认</span>
        </header>
        <BridgeSendPreview preview={dshSendReview.preview} />
        <div className="lifeos-review" data-testid="lifeos-dsh-send-review-actions">
          <div className="lifeos-actions">
            <button
              type="button"
              disabled={state.submitting}
              onClick={() =>
                void decideDshSendReview({ reviewId: dshSendReview.reviewId, kind: "reject" })
              }
            >
              取消本次发送
            </button>
            <button
              type="button"
              className="lifeos-primary"
              disabled={state.submitting}
              onClick={() =>
                void decideDshSendReview({ reviewId: dshSendReview.reviewId, kind: "approve" })
              }
            >
              批准并进入 Bridge
            </button>
          </div>
        </div>
        {state.error === null ? null : (
          <p className="lifeos-error" role="alert">
            {state.error}
          </p>
        )}
      </section>
    );
  }

  if (promptReview !== null || projection?.pendingPromptReviewDecision != null) {
    return (
      <section
        className="lifeos-card lifeos-prompt-review-card"
        data-testid="lifeos-prompt-review-card"
        aria-label="执行 Agent 发送前提示词审核"
      >
        <header className="lifeos-header">
          <strong>执行 Agent · 第 {promptReview?.requestIndex ?? "—"} 次发送审核</strong>
          <span className="lifeos-status" aria-live="polite" data-testid="lifeos-run-status">
            {run === null || run === undefined ? "连接失败" : (PHASE_LABEL[run.phase] ?? run.phase)}
          </span>
        </header>

        {promptReview !== null ? (
          <>
            <div className="lifeos-prompt-meta" aria-label="模型请求摘要">
              <span>Provider：{promptReview.providerId}</span>
              <span>模型：{promptReview.modelId}</span>
              <span>目标：{promptReview.endpointHost}</span>
              <span>类型：{promptReview.requestKind}</span>
            </div>
            <div className="lifeos-prompt-tabs" role="tablist" aria-label="提示词展示方式">
              <button
                type="button"
                role="tab"
                aria-selected={promptView === "readable"}
                className={promptView === "readable" ? "lifeos-prompt-tab-active" : undefined}
                onClick={() => setPromptView("readable")}
              >
                易读视图
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={promptView === "raw"}
                className={promptView === "raw" ? "lifeos-prompt-tab-active" : undefined}
                onClick={() => setPromptView("raw")}
              >
                原始请求
              </button>
            </div>
            <div className="lifeos-prompt-body" role="tabpanel">
              <div className="lifeos-prompt-caption">
                {promptView === "raw"
                  ? "发送前冻结的原始请求正文（凭据不会进入审核数据）"
                  : "每段正文都来自原始请求；来源定位是审核界面注释，不会发送给模型"}
              </div>
              {promptView === "raw" ? (
                <pre data-testid="lifeos-prompt-raw">{promptReview.canonicalPayloadJson}</pre>
              ) : (
                <div className="lifeos-prompt-sections" data-testid="lifeos-prompt-readable">
                  {promptReview.readableSections.map((section) => (
                    <section key={section.sectionId} className="lifeos-prompt-section">
                      <header>
                        <strong>{section.title}</strong>
                        <code>{section.payloadJsonPointer}</code>
                      </header>
                      <aside aria-label={`${section.title}来源定位`}>
                        <strong>来源定位 · 仅界面注释，不发送</strong>
                        {section.sources.map((source, index) => (
                          <div key={`${section.sectionId}-source-${String(index)}`}>
                            <span>{source.addedBy}</span>
                            <p>{source.explanation}</p>
                            <div>
                              {source.sourceFiles.map((file) => (
                                <code key={file}>{file}</code>
                              ))}
                            </div>
                          </div>
                        ))}
                      </aside>
                      <div className="lifeos-prompt-real-label">真实请求内容</div>
                      <pre>{section.content}</pre>
                      {section.otherFieldsJson === undefined ? null : (
                        <>
                          <div className="lifeos-prompt-real-label">该区域的其他真实字段</div>
                          <pre>{section.otherFieldsJson}</pre>
                        </>
                      )}
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : null}

        {projection?.pendingPromptReviewDecision != null ? (
          <div className="lifeos-warning" data-testid="lifeos-pending-prompt-review-decision">
            <p>上一提示词决定结果仍未知；只能原样重试。</p>
            <button
              type="button"
              disabled={state.submitting}
              onClick={() => void decidePromptReview(projection.pendingPromptReviewDecision!)}
            >
              重试上一决定
            </button>
          </div>
        ) : null}

        {canReviewPrompt &&
        promptReview !== null &&
        projection?.pendingPromptReviewDecision === null ? (
          <div className="lifeos-review" data-testid="lifeos-prompt-review-actions">
            <textarea
              aria-label="拒绝原因"
              value={explanation}
              maxLength={2_000}
              placeholder="拒绝时可填写原因（可选）"
              onChange={(event) => setExplanation(event.currentTarget.value)}
            />
            <div className="lifeos-actions">
              <button
                type="button"
                data-testid="lifeos-reject-prompt"
                disabled={state.submitting || !promptReview.allowedActions.includes("reject")}
                onClick={() => void submitPromptReview("reject")}
              >
                拒绝并停止
              </button>
              <button
                type="button"
                className="lifeos-primary"
                data-testid="lifeos-approve-prompt"
                disabled={state.submitting || !promptReview.allowedActions.includes("approve")}
                onClick={() => void submitPromptReview("approve")}
              >
                批准并发送
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

  if (projectBootstrap !== null) {
    const candidate = projectBootstrap.candidate;
    const statusLabel =
      candidate.status === "prepared"
        ? "等待你确认"
        : candidate.status === "ready"
          ? "初始化完成"
          : candidate.status === "outcome_unknown"
            ? "结果未知，等待对账"
            : candidate.status === "needs_attention"
              ? "需要处理"
              : "正在初始化";
    const submitProjectBootstrap = async (
      kind: ProjectBootstrapDecisionRequest["kind"],
    ): Promise<void> => {
      const trimmed = explanation.trim();
      const request: ProjectBootstrapDecisionRequest = {
        kind,
        ...(kind === "reject" && trimmed !== "" ? { explanation: trimmed } : {}),
        binding: {
          projectBootstrapCandidateId: candidate.projectBootstrapCandidateId,
          candidateRevision: candidate.revision,
          candidateSha256: candidate.sha256,
        },
      };
      if (await decideProjectBootstrap(request)) setExplanation("");
    };
    return (
      <section
        className="lifeos-card lifeos-project-bootstrap-card"
        data-testid="lifeos-project-bootstrap-card"
        aria-label="项目初始化审核"
      >
        <header className="lifeos-header">
          <strong>创建项目 · {candidate.proposal.name}</strong>
          <span className="lifeos-status">{statusLabel}</span>
        </header>
        <div className="lifeos-plan">
          <div className="lifeos-objective">{candidate.proposal.objective}</div>
          <ul>
            <li>Plane：{candidate.preview.planeProjectLabel}</li>
            <li>Workspace：{candidate.preview.workspaceLabel}</li>
            <li>Git：初始化 main 分支仓库</li>
          </ul>
          {candidate.preview.initialModules.length === 0 ? null : (
            <div className="lifeos-note-tags" aria-label="初始项目模块">
              {candidate.preview.initialModules.map((module) => (
                <span key={module}>{module}</span>
              ))}
            </div>
          )}
        </div>
        {candidate.status === "prepared" ? (
          <div className="lifeos-review" data-testid="lifeos-project-bootstrap-review">
            <textarea
              aria-label="拒绝原因"
              value={explanation}
              maxLength={1_000}
              placeholder="拒绝时可填写原因（可选）"
              onChange={(event) => setExplanation(event.currentTarget.value)}
            />
            <div className="lifeos-actions">
              <button
                type="button"
                disabled={state.submitting}
                onClick={() => void submitProjectBootstrap("reject")}
              >
                取消创建
              </button>
              <button
                type="button"
                className="lifeos-primary"
                data-testid="lifeos-confirm-project-bootstrap"
                disabled={state.submitting}
                onClick={() => void submitProjectBootstrap("confirm")}
              >
                确认并创建
              </button>
            </div>
          </div>
        ) : null}
        {["needs_attention", "outcome_unknown"].includes(candidate.status) ? (
          <div className="lifeos-warning">
            <p>{projectBootstrap.operation?.errorCode ?? "初始化未完成，可重新对账。"}</p>
            <button
              type="button"
              disabled={state.submitting}
              onClick={() => void submitProjectBootstrap("retry")}
            >
              重新对账并继续
            </button>
          </div>
        ) : null}
        {projectBootstrap.binding === undefined ? null : (
          <div className="lifeos-warning" data-testid="lifeos-project-bootstrap-ready">
            <p>Plane项目与本地Git Workspace均已验证，项目绑定已生效。</p>
            <div className="lifeos-actions">
              {projection?.projectBootstrapTargets?.workspaceCwd === undefined ? null : (
                <button
                  type="button"
                  className="lifeos-primary"
                  data-testid="lifeos-enter-project-workspace"
                  onClick={() =>
                    void openProjectWorkspace(projection.projectBootstrapTargets!.workspaceCwd!)
                  }
                >
                  进入 Workspace
                </button>
              )}
              {projection?.projectBootstrapTargets?.planeUrl === undefined ? null : (
                <button
                  type="button"
                  data-testid="lifeos-open-plane-project"
                  onClick={() => openPlaneProject(projection.projectBootstrapTargets!.planeUrl!)}
                >
                  打开 Plane
                </button>
              )}
            </div>
          </div>
        )}
        {state.error === null ? null : (
          <p className="lifeos-error" role="alert">
            {state.error}
          </p>
        )}
      </section>
    );
  }

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
