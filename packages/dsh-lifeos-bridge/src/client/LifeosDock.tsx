import { useState } from "react";
import type { HostObservable, InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type { DecisionRequest } from "../contracts.ts";
import type { LifeosProjection } from "../contracts.ts";
import type { LifeosClientState } from "./controller.ts";

export interface LifeosDockInjected {
  hooks: { lifeos: HostObservable<LifeosClientState> };
  decide: (request: DecisionRequest) => Promise<boolean>;
}

export type LifeosDockProps = PropsRuntime<"conversation.input.dock"> &
  InjectFace<LifeosDockInjected>;

const PHASE_LABEL: Record<string, string> = {
  plan_review: "等待你审核",
};

/** 审核Dock是临时命令表面，不是Run状态看板；终态历史只进入Trajectory。 */
export function hasActionableReview(projection: LifeosProjection | null): boolean {
  const run = projection?.run;
  const plan = projection?.plan;
  const approval = projection?.approval;
  return (
    approval?.status === "open" &&
    run?.status === "waiting_human" &&
    plan !== null &&
    plan !== undefined &&
    plan.planId === approval.planId &&
    plan.planRevision === approval.planRevision &&
    plan.sha256 === approval.planSha256
  );
}

export function shouldShowLifeosReviewDock(projection: LifeosProjection | null): boolean {
  return hasActionableReview(projection) || projection?.pendingDecision != null;
}

export function LifeosDock({ useLifeos, decide }: LifeosDockProps) {
  const state = useLifeos((value) => value);
  const [explanation, setExplanation] = useState("");
  const projection = state.projection;
  const canReview = hasActionableReview(projection);
  if (!shouldShowLifeosReviewDock(projection)) return null;

  const run = projection?.run;
  const plan = projection?.plan;
  const approval = projection?.approval;
  const submit = async (kind: DecisionRequest["kind"]): Promise<void> => {
    if (
      !canReview ||
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

  return (
    <section className="lifeos-card" data-testid="lifeos-plan-card" aria-label="LifeOS 计划与审批">
      <header className="lifeos-header">
        <strong>
          LifeOS 计划{plan === null || plan === undefined ? "" : ` v${plan.planRevision}`}
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

      {canReview && projection?.pendingDecision === null ? (
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
              onClick={() => void submit("request_revision")}
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
              onClick={() => void submit("reject")}
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
              onClick={() => void submit("approve")}
            >
              批准并执行
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
