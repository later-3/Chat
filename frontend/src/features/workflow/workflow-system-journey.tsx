import { ArrowRight, Check, Circle, CircleAlert, LoaderCircle, Network } from "lucide-react";
import { progressFromTrace } from "../../workflow-progress.js";
import type { ProductRun } from "../session/session-api.js";
import type { ProductTraceEvent, WorkflowDefinition } from "./workflow-api.js";

export type SystemJourneyStatus = "idle" | "running" | "completed" | "failed";

export interface SystemJourneyStep {
  id: string;
  label: string;
  owner: string;
  source: string;
  status: SystemJourneyStatus;
}

const TERMINAL_FAILURES = new Set([
  "failed",
  "cancelled",
  "interrupted",
  "abandoned",
  "outcome_unknown",
]);

function statusAfterRunExists(run: ProductRun | null): SystemJourneyStatus {
  return run ? "completed" : "idle";
}

export function deriveSystemJourney(
  definition: WorkflowDefinition,
  trace: ProductTraceEvent[],
  run: ProductRun | null,
): SystemJourneyStep[] {
  const progress = progressFromTrace(definition, trace);
  const intake = progress.input_acceptance?.status;
  const finalization = progress.result_finalization?.status;
  const anyWorkflowActivity = Object.values(progress).some((value) => value.status !== "idle");
  const allWorkflowActivity = Object.values(progress).filter((value) => value.status !== "idle");
  const workflowFailed = allWorkflowActivity.some((value) =>
    ["failed", "abandoned"].includes(value.status),
  );
  const productFailed = Boolean(run && TERMINAL_FAILURES.has(run.status));
  const workerStatus: SystemJourneyStatus = !run?.runtime_job
    ? run
      ? "running"
      : "idle"
    : TERMINAL_FAILURES.has(run.runtime_job.status)
      ? "failed"
      : run.runtime_job.recoverability === "terminal" || run.finished_at
        ? "completed"
        : "running";
  const workflowStatus: SystemJourneyStatus = workflowFailed
    ? "failed"
    : run?.status === "succeeded"
      ? "completed"
      : anyWorkflowActivity
        ? "running"
        : "idle";
  const productCommitStatus: SystemJourneyStatus =
    finalization === "completed"
      ? "completed"
      : finalization === "failed" || productFailed
        ? "failed"
        : finalization && finalization !== "idle"
          ? "running"
          : "idle";
  const projectionStatus: SystemJourneyStatus = run?.assistant_message_id
    ? "completed"
    : productFailed
      ? "failed"
      : run
        ? "running"
        : "idle";

  return [
    {
      id: "frontend_submit",
      label: "前端提交",
      owner: "React / AG-UI Client",
      source: "App.submit → useChatAgent.send",
      status: statusAfterRunExists(run),
    },
    {
      id: "product_acceptance",
      label: "产品事实接纳",
      owner: "Product Session",
      source: "prepare_agui_run",
      status:
        intake === "completed"
          ? "completed"
          : intake === "failed"
            ? "failed"
            : run
              ? "running"
              : "idle",
    },
    {
      id: "runtime_worker",
      label: "Worker执行",
      owner: "Runtime Job / Lease",
      source: "ExecutionWorker",
      status: workerStatus,
    },
    {
      id: "maf_workflow",
      label: "MAF Workflow",
      owner: `${definition.nodes.length}个真实节点`,
      source: "build_continuous_collaboration_workflow",
      status: workflowStatus,
    },
    {
      id: "product_commit",
      label: "产品结果提交",
      owner: "Finalization Gate",
      source: "complete_active_run",
      status: productCommitStatus,
    },
    {
      id: "frontend_projection",
      label: "前端呈现",
      owner: "Product事实 + AG-UI事件",
      source: "hydrateProductSession",
      status: projectionStatus,
    },
  ];
}

function JourneyIcon({ status }: { status: SystemJourneyStatus }) {
  if (status === "completed") return <Check size={16} />;
  if (status === "running") return <LoaderCircle className="workflow-spin" size={16} />;
  if (status === "failed") return <CircleAlert size={16} />;
  return <Circle size={14} />;
}

export function WorkflowSystemJourney({
  definition,
  trace,
  run,
}: {
  definition: WorkflowDefinition;
  trace: ProductTraceEvent[];
  run: ProductRun | null;
}) {
  const steps = deriveSystemJourney(definition, trace, run);
  return (
    <section className="workflow-system-journey" aria-label="系统执行链">
      <header>
        <div>
          <Network size={18} />
          <strong>系统执行链</strong>
        </div>
        <span>代码边界 · 不是额外MAF节点</span>
      </header>
      <ol>
        {steps.map((step, index) => (
          <li className={`system-journey-step system-journey-step--${step.status}`} key={step.id}>
            <span className="system-journey-step-icon">
              <JourneyIcon status={step.status} />
            </span>
            <div>
              <strong>{step.label}</strong>
              <span>{step.owner}</span>
              <code>{step.source}</code>
            </div>
            {index < steps.length - 1 && <ArrowRight aria-hidden="true" size={16} />}
          </li>
        ))}
      </ol>
    </section>
  );
}
