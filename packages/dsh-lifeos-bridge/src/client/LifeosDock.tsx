import { useState, type ReactNode } from "react";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {
  BridgeChatDispatchPlan,
  BridgeChatDispatchReviewDecisionRequest,
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
  decideBridgeDispatchReview: (
    request: BridgeChatDispatchReviewDecisionRequest,
  ) => Promise<boolean>;
  decideProjectBootstrap: (request: ProjectBootstrapDecisionRequest) => Promise<boolean>;
  openProjectWorkspace: (cwd: string) => Promise<void>;
  openPlaneProject: (url: string) => void;
}

export type LifeosDockProps = PropsRuntime<"conversation.input.dock"> &
  InjectFace<LifeosDockInjected>;

function PromptAuditSurface({
  title,
  status,
  ariaLabel,
  testId,
  className,
  children,
  footer,
}: {
  readonly title: string;
  readonly status: ReactNode;
  readonly ariaLabel: string;
  readonly testId: string;
  readonly className: string;
  readonly children: ReactNode;
  readonly footer: ReactNode;
}) {
  return (
    <div className="lifeos-prompt-audit-root">
      <div className="lifeos-prompt-audit-backdrop" aria-hidden="true" />
      <section
        className={`lifeos-card lifeos-scroll-review-card lifeos-prompt-audit-surface ${className}`}
        data-testid={testId}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        <header className="lifeos-prompt-audit-toolbar">
          <div>
            <small>Prompt 审查</small>
            <strong>{title}</strong>
          </div>
          <span className="lifeos-status">{status}</span>
        </header>
        <div className="lifeos-prompt-audit-scroll">{children}</div>
        <footer className="lifeos-prompt-audit-footer">{footer}</footer>
      </section>
    </div>
  );
}

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

interface DispatchCommand {
  readonly method: "POST";
  readonly path: string;
  readonly bodyJson: string;
  readonly bodySha256: string;
}

function jsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function prettyJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function DispatchRawCommand({ title, command }: { title: string; command: DispatchCommand }) {
  return (
    <section className="lifeos-bridge-dispatch-command">
      <header>
        <strong>{title}</strong>
        <code>
          {command.method} {command.path}
        </code>
      </header>
      <dl>
        <div>
          <dt>Body SHA-256</dt>
          <dd>
            <code>{command.bodySha256}</code>
          </dd>
        </div>
      </dl>
      <div className="lifeos-prompt-real-label">实际HTTP Request Body</div>
      <pre>{command.bodyJson}</pre>
    </section>
  );
}

function BridgeDispatchRaw({ plan }: { plan: BridgeChatDispatchPlan }) {
  return (
    <div className="lifeos-bridge-dispatch-commands" data-testid="lifeos-bridge-dispatch-raw">
      <DispatchRawCommand
        title={
          plan.productSessionId === null
            ? "1 · 提交首轮用户消息（Chat后端创建Session）"
            : "1 · 向已有Chat Session提交用户消息"
        }
        command={plan.submitMessage}
      />
    </div>
  );
}

const PAYLOAD_FIELD: Record<string, { label: string; source: string }> = {
  text: {
    label: "用户输入",
    source: "DSH当前用户Message，经Bridge提取并保留；对应原始Command /payload/text。",
  },
  workflowSelection: {
    label: "Workflow选择",
    source: "当前DSH会话在Bridge中冻结的Workflow Revision与Hash。",
  },
  promptSelection: {
    label: "Prompt区域选择",
    source: "Direct工作流下，由Prompt Composer冻结的Region模式与Revision选择。",
  },
  context: {
    label: "Workspace上下文",
    source: "非Direct工作流下，Bridge政策筛选后保留的Workspace instructions。",
  },
};

function ReadableRawField({
  title,
  pointer,
  source,
  value,
}: {
  title: string;
  pointer: string;
  source: string;
  value: unknown;
}) {
  return (
    <section className="lifeos-prompt-section">
      <header>
        <strong>{title}</strong>
        <code>{pointer}</code>
      </header>
      <aside aria-label={`${title}来源定位`}>
        <strong>来源定位 · 仅界面注释，不发送</strong>
        <div>
          <span>Bridge发送计划</span>
          <p>{source}</p>
          <div>
            <code>packages/dsh-lifeos-bridge/src/bridge-chat-dispatch.ts</code>
          </div>
        </div>
      </aside>
      <div className="lifeos-prompt-real-label">原始Command中的真实字段值</div>
      <pre>{prettyJson(value)}</pre>
    </section>
  );
}

function BridgeDispatchReadable({ plan }: { plan: BridgeChatDispatchPlan }) {
  const submitBody = jsonRecord(plan.submitMessage.bodyJson);
  const submitPayload =
    typeof submitBody?.payload === "object" && submitBody.payload !== null
      ? (submitBody.payload as Record<string, unknown>)
      : null;

  return (
    <div className="lifeos-prompt-sections" data-testid="lifeos-bridge-dispatch-readable">
      <section className="lifeos-bridge-dispatch-ui-note">
        <strong>审核界面元数据</strong>
        <p>
          requestKey、Product Session绑定、Plan SHA-256、字段标题、来源说明和JSON
          Pointer只用于审核与一致性校验，均不在下面的HTTP bodyJson中，也不会发送给Chat后端。
        </p>
      </section>
      {plan.productSessionId !== null ? null : (
        <section className="lifeos-bridge-dispatch-ui-note" data-testid="lifeos-first-turn-note">
          <strong>首轮只有1个Bridge → Chat命令</strong>
          <p>
            Bridge只提交submitMessage.payload。Chat Application在同一事务内创建Product
            Session、从首条正式User Message派生标题，并提交Message、Run与Outbox。
          </p>
        </section>
      )}
      <ReadableRawField
        title="提交消息 · 幂等命令身份"
        pointer="submitMessage.bodyJson#/commandId"
        source="Bridge为本次DSH请求生成并冻结；重试必须原样复用。"
        value={submitBody?.commandId}
      />
      {submitPayload === null
        ? null
        : Object.entries(submitPayload).map(([key, value]) => {
            const description = PAYLOAD_FIELD[key];
            return (
              <ReadableRawField
                key={key}
                title={description?.label ?? `提交消息 · ${key}`}
                pointer={`submitMessage.bodyJson#/payload/${key}`}
                source={description?.source ?? "Bridge发送政策保留的Command payload字段。"}
                value={value}
              />
            );
          })}
    </div>
  );
}

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
    projection?.bridgeDispatchReview != null ||
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
  decideBridgeDispatchReview,
  decideProjectBootstrap,
  openProjectWorkspace,
  openPlaneProject,
}: LifeosDockProps) {
  const state = useLifeos((value) => value);
  const [explanation, setExplanation] = useState("");
  const [promptView, setPromptView] = useState<"readable" | "raw">("readable");
  const [bridgeDispatchView, setBridgeDispatchView] = useState<"readable" | "raw">("readable");
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
  const bridgeDispatchReview = projection?.bridgeDispatchReview ?? null;
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
      <PromptAuditSurface
        title="DSH → Bridge 发送前审核"
        status="等待你确认"
        ariaLabel="DSH发送前审核"
        testId="lifeos-dsh-send-review-card"
        className="lifeos-dsh-send-review-card"
        footer={
          <>
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
          </>
        }
      >
        <BridgeSendPreview preview={dshSendReview.preview} />
      </PromptAuditSurface>
    );
  }

  if (bridgeDispatchReview !== null) {
    const plan = bridgeDispatchReview.plan;
    return (
      <PromptAuditSurface
        title="Bridge → Chat后端 发送前审核"
        status="等待你确认"
        ariaLabel="Bridge发送到Chat后端前审核"
        testId="lifeos-bridge-dispatch-review-card"
        className="lifeos-bridge-dispatch-review-card"
        footer={
          <>
            <div className="lifeos-review" data-testid="lifeos-bridge-dispatch-review-actions">
              <div className="lifeos-actions">
                <button
                  type="button"
                  disabled={state.submitting}
                  onClick={() =>
                    void decideBridgeDispatchReview({
                      reviewId: bridgeDispatchReview.reviewId,
                      planSha256: plan.planSha256,
                      kind: "reject",
                    })
                  }
                >
                  取消本次发送
                </button>
                <button
                  type="button"
                  className="lifeos-primary"
                  disabled={state.submitting}
                  onClick={() =>
                    void decideBridgeDispatchReview({
                      reviewId: bridgeDispatchReview.reviewId,
                      planSha256: plan.planSha256,
                      kind: "approve",
                    })
                  }
                >
                  批准并发送到Chat后端
                </button>
              </div>
            </div>
            {state.error === null ? null : (
              <p className="lifeos-error" role="alert">
                {state.error}
              </p>
            )}
          </>
        }
      >
        <div className="lifeos-prompt-meta" aria-label="Bridge发送计划摘要">
          <span>请求：{plan.requestKey}</span>
          <span>
            Chat Product Session：
            {plan.productSessionId ?? "批准后由Chat Application在首轮Message事务内创建"}
          </span>
          <span>HTTP操作：1</span>
          <span>Plan SHA-256：{plan.planSha256}</span>
        </div>
        <div className="lifeos-prompt-tabs" role="tablist" aria-label="Bridge发送审核展示方式">
          <button
            type="button"
            role="tab"
            aria-selected={bridgeDispatchView === "readable"}
            className={bridgeDispatchView === "readable" ? "lifeos-prompt-tab-active" : undefined}
            onClick={() => setBridgeDispatchView("readable")}
          >
            易读视图
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={bridgeDispatchView === "raw"}
            className={bridgeDispatchView === "raw" ? "lifeos-prompt-tab-active" : undefined}
            onClick={() => setBridgeDispatchView("raw")}
          >
            原始请求
          </button>
        </div>
        <div className="lifeos-prompt-body lifeos-bridge-dispatch-body" role="tabpanel">
          <div className="lifeos-prompt-caption">
            {bridgeDispatchView === "raw"
              ? "以下bodyJson就是批准后交给fetch的完整请求正文；认证Header不会进入审核数据。"
              : "字段值全部从原始bodyJson解析；来源定位和Plan元数据仅供界面审核，不会发给Chat后端。"}
          </div>
          {bridgeDispatchView === "raw" ? (
            <BridgeDispatchRaw plan={plan} />
          ) : (
            <BridgeDispatchReadable plan={plan} />
          )}
        </div>
      </PromptAuditSurface>
    );
  }

  if (promptReview !== null || projection?.pendingPromptReviewDecision != null) {
    return (
      <PromptAuditSurface
        title={`Pi Coding Agent · 第 ${promptReview?.requestIndex ?? "—"} 次发送审核`}
        status={
          <span aria-live="polite" data-testid="lifeos-run-status">
            {run === null || run === undefined ? "连接失败" : (PHASE_LABEL[run.phase] ?? run.phase)}
          </span>
        }
        ariaLabel="Pi Coding Agent发送前提示词审核"
        testId="lifeos-prompt-review-card"
        className="lifeos-prompt-review-card"
        footer={
          <>
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
          </>
        }
      >
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
      </PromptAuditSurface>
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
