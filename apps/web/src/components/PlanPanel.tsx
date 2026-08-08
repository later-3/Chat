import { useEffect, useRef, useState } from "react";
import type { ApprovalDto, PlanDto, RunDto, SubmitDecisionPayload } from "@chat/contracts/public";
import { ApiProblemError } from "../api/client.js";
import type { RealChainState } from "../real/use-real-chain.js";

/**
 * Plan审核面板：revision、目标、摘要、步骤、成功标准、风险与决定动作。
 * 所有状态来自服务端Query；旧revision展示为历史事实且不可决定。
 */

const PLAN_STATUS_LABEL: Record<PlanDto["status"], string> = {
  under_review: "审核中",
  approved: "已通过",
  superseded: "已被新版本取代",
  rejected: "已拒绝",
  expired: "已过期",
};

const PLAN_TONE: Record<PlanDto["status"], "success" | "warning" | "danger"> = {
  under_review: "warning",
  approved: "success",
  superseded: "danger",
  rejected: "danger",
  expired: "danger",
};

function decisionProblemText(error: ApiProblemError): string {
  switch (error.recoveryAction) {
    case "retry_same_command":
      return "网络结果未知，请重试同一决定（不会重复提交）。";
    case "rehydrate_and_retry":
      return "计划状态已变化，正在为你刷新；请基于最新版本重新决定。";
    default:
      return `决定未提交（${error.code}）。`;
  }
}

function memoryFailureText(code: string | undefined): string {
  switch (code) {
    case "memory.backend.not_configured":
    case "memory.backend.config_invalid":
      return "后端未配置";
    case "memory.backend.timeout":
      return "查询超时";
    case "memory.backend.rate_limited":
      return "请求过于频繁";
    case "memory.backend.unauthorized":
    case "memory.backend.forbidden":
      return "后端认证失败";
    case "memory.backend.contract_invalid":
      return "返回内容不符合合同";
    case "memory.response.over_budget":
      return "返回内容超过本轮预算";
    case "memory.backend.unavailable":
      return "后端暂时不可用";
    default:
      return code ?? "查询失败";
  }
}

function ContextSummary({ chain }: { chain: RealChainState }) {
  const context = chain.runContext.data;
  if (chain.runContext.isError) {
    return (
      <p className="context-summary" data-tone="danger" role="status">
        上下文来源读取失败
      </p>
    );
  }
  if (context?.memory === undefined) return null;
  const backend = chain.memoryBackends.data?.find(
    (candidate) => candidate.backendId === context.memory?.backendId,
  );
  const backendName = backend?.kind ?? "memmy";
  if (context.memory.queryStatus === "failed") {
    return (
      <p className="context-summary" data-tone="warning" role="status">
        {backendName}{" "}
        {context.memory.requirement === "optional" ? "可选上下文未采用" : "上下文失败"}：
        {memoryFailureText(context.memory.errorCode)}
      </p>
    );
  }
  if (context.memory.queryStatus === "pending") {
    return (
      <p className="context-summary" data-tone="warning" role="status">
        正在查询 {backendName} 上下文
      </p>
    );
  }
  const adoptedCount = context.contextPackage?.sources.length ?? context.memory.adoptedCount ?? 0;
  return (
    <div className="context-summary" data-tone="success" role="status">
      <strong>
        使用 {backendName} {adoptedCount} 条
      </strong>
      {context.contextPackage !== undefined && context.contextPackage.sources.length > 0 && (
        <span>{context.contextPackage.sources.map((source) => source.title).join("、")}</span>
      )}
    </div>
  );
}

function PlanCard({ plan, current }: { plan: PlanDto; current: boolean }) {
  return (
    <article
      className="plan-card"
      data-current={current}
      data-plan-sha256={plan.sha256}
      aria-label={`计划第${plan.planRevision}版`}
    >
      <header className="plan-card-head">
        <span className="plan-revision">Plan v{plan.planRevision}</span>
        <span className="status-badge" data-tone={PLAN_TONE[plan.status]}>
          {PLAN_STATUS_LABEL[plan.status]}
        </span>
      </header>
      <h4>{plan.content.objective}</h4>
      <p className="plan-summary">{plan.content.summary}</p>
      <ol className="plan-steps">
        {plan.content.steps.map((step) => (
          <li key={step.stepId}>
            <strong>{step.title}</strong>
            <span>{step.purpose}</span>
            <small>
              产出：{step.expectedOutput} · 风险:
              {step.risk === "low" ? "低" : step.risk === "medium" ? "中" : "高"}
            </small>
            <small>成功标准:{step.successCriteria.join("；")}</small>
          </li>
        ))}
      </ol>
      <div className="plan-criteria">
        <strong>完成条件</strong>
        <ul>
          {plan.content.completionCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
      </div>
      {(plan.content.warnings.length > 0 || plan.content.openQuestions.length > 0) && (
        <div className="plan-warnings">
          {plan.content.warnings.map((warning) => (
            <p key={warning}>⚠ {warning}</p>
          ))}
          {plan.content.openQuestions.map((question) => (
            <p key={question}>？{question}</p>
          ))}
        </div>
      )}
    </article>
  );
}

function DecisionBox({
  chain,
  run,
  plan,
  approval,
}: {
  chain: RealChainState;
  run: RunDto;
  plan: PlanDto;
  approval: ApprovalDto;
}) {
  const [instruction, setInstruction] = useState(() =>
    chain.pendingDecision?.payload.kind === "request_revision"
      ? (chain.pendingDecision.payload.revisionInstruction ?? "")
      : "",
  );
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [awaitingRevision, setAwaitingRevision] = useState(false);
  const revisionRequestStarted = useRef(false);
  const deciding = chain.deciding;

  // 决定失败时修改意见保留；成功后由服务端Query确认并清空输入
  useEffect(() => {
    if (!awaitingRevision) return;
    if (chain.deciding) {
      revisionRequestStarted.current = true;
      return;
    }
    if (!revisionRequestStarted.current) return;
    if (chain.decisionError !== null) {
      setAwaitingRevision(false);
      revisionRequestStarted.current = false;
      return;
    }
    setAwaitingRevision(false);
    revisionRequestStarted.current = false;
    setInstruction("");
  }, [awaitingRevision, chain.decisionError, chain.deciding]);

  function basePayload(kind: SubmitDecisionPayload["kind"]): SubmitDecisionPayload {
    return {
      approvalRequestId: approval.approvalRequestId,
      planId: plan.planId,
      planRevision: plan.planRevision,
      planSha256: plan.sha256,
      kind,
    };
  }

  function requestRevision() {
    const text = instruction.trim();
    if (text === "" || deciding) return;
    setAwaitingRevision(true);
    chain.submitDecision({
      expectedRunRevision: run.revision,
      payload: { ...basePayload("request_revision"), revisionInstruction: text },
    });
  }

  function approve() {
    if (deciding) return;
    chain.submitDecision({ expectedRunRevision: run.revision, payload: basePayload("approve") });
  }

  function reject() {
    if (deciding) return;
    const reason = rejectReason.trim();
    chain.submitDecision({
      expectedRunRevision: run.revision,
      payload: { ...basePayload("reject"), ...(reason !== "" ? { reason } : {}) },
    });
    setShowReject(false);
    setRejectReason("");
  }

  function retryDecision() {
    if (deciding || chain.pendingDecision === null) return;
    if (chain.pendingDecision.payload.kind === "request_revision") {
      setAwaitingRevision(true);
    }
    chain.retryPendingDecision();
  }

  return (
    <div className="decision-box" aria-label="计划决定">
      <textarea
        className="decision-input"
        aria-label="修改意见"
        placeholder="输入修改意见，例如：把风险单独成节，并增加下周三个行动项"
        rows={2}
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="decision-actions">
        <button
          className="small-button"
          onClick={requestRevision}
          disabled={deciding || instruction.trim() === ""}
        >
          要求修改
        </button>
        <button className="small-button primary" onClick={approve} disabled={deciding}>
          通过
        </button>
        <button
          className="small-button danger"
          onClick={() => setShowReject((v) => !v)}
          disabled={deciding}
        >
          拒绝
        </button>
      </div>
      {showReject && (
        <div className="reject-box">
          <input
            aria-label="拒绝原因（可选）"
            placeholder="拒绝原因（可选）"
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
          />
          <button className="small-button danger" onClick={reject} disabled={deciding}>
            确认拒绝并结束
          </button>
        </div>
      )}
      {chain.decisionError !== null && (
        <p className="decision-error" role="alert">
          {decisionProblemText(chain.decisionError)}
          {chain.decisionError.recoveryAction === "retry_same_command" &&
            chain.pendingDecision !== null && (
              <button className="small-button" onClick={retryDecision} disabled={deciding}>
                用同一决定重试
              </button>
            )}
          <button className="small-button" onClick={chain.clearDecisionError}>
            知道了
          </button>
        </p>
      )}
      {chain.decisionError === null && chain.pendingDecision !== null && (
        <p className="decision-error" role="alert">
          上一次决定的响应未知，请勿创建新决定。
          <button className="small-button" onClick={retryDecision} disabled={deciding}>
            用同一决定重试
          </button>
        </p>
      )}
    </div>
  );
}

export function PlanPanel({
  chain,
  run,
  plans,
  approval,
}: {
  chain: RealChainState;
  run: RunDto;
  plans: readonly PlanDto[];
  approval: ApprovalDto | null;
}) {
  const currentPlan = plans[plans.length - 1];
  const canDecide =
    run.allowedActions.length > 0 &&
    approval !== null &&
    approval.status === "open" &&
    currentPlan !== undefined &&
    currentPlan.status === "under_review";

  return (
    <div className="plan-panel">
      <ContextSummary chain={chain} />
      {plans.length === 0 && run.status !== "succeeded" && (
        <p className="loading-note">系统正在工作中，计划形成后会出现在这里。</p>
      )}
      {plans.map((plan, index) => (
        <PlanCard
          key={`${plan.planId}-${plan.planRevision}`}
          plan={plan}
          current={index === plans.length - 1}
        />
      ))}
      {canDecide && approval !== null && currentPlan !== undefined && (
        <DecisionBox chain={chain} run={run} plan={currentPlan} approval={approval} />
      )}
      {approval?.status === "expired" && (
        <p className="decision-error" role="alert">
          本次计划审核已过期，不能再提交决定。请结束当前工作后重新发起。
        </p>
      )}
      {run.status === "succeeded" && (
        <p className="run-done-note">工作已完成，正式结果已作为Assistant消息进入对话。</p>
      )}
      {run.status === "failed" && (
        <p className="decision-error" role="alert">
          这次工作失败了{run.failure !== undefined ? `:${run.failure.summary}` : "。"}
          可以调整目标后重新开始。
        </p>
      )}
      {run.status === "cancelled" && <p>这次工作已取消。</p>}
    </div>
  );
}
