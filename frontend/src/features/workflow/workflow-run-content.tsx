import {
  AlertTriangle,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  LoaderCircle,
  Minus,
  ShieldCheck,
} from "lucide-react";
import type { WorkflowStageStatus } from "../../workflow-run-projection.js";
import type {
  GovernedToolExecution,
  RunGovernanceView,
  StepInputProjection,
  WorkflowNodeStatus,
} from "./workflow-api.js";

export const STAGE_STATUS_LABELS: Record<WorkflowStageStatus, string> = {
  not_started: "未开始",
  in_progress: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "未完成",
  abandoned: "已放弃",
  skipped: "已跳过",
};

export const NODE_STATUS_LABELS: Record<WorkflowNodeStatus, string> = {
  idle: "未开始",
  in_progress: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "未完成",
  abandoned: "已放弃",
  skipped: "已跳过",
};

export interface StageContent {
  input: unknown;
  output: unknown;
  facts: Record<string, unknown>;
  internalActivity?: unknown;
  governance?: unknown;
  stepInput?: unknown;
}

export function StageIcon({ status }: { status: WorkflowStageStatus | WorkflowNodeStatus }) {
  if (status === "in_progress") return <LoaderCircle className="workflow-spin" size={17} />;
  if (status === "completed") return <Check size={17} />;
  if (status === "waiting_approval") return <Clock3 size={17} />;
  if (status === "failed" || status === "abandoned") return <AlertTriangle size={17} />;
  if (status === "skipped") return <Minus size={17} />;
  return <Circle size={15} />;
}

export function formatOccurredAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <p className="node-public-empty">尚未产生</p>;
  }
  if (typeof value === "string") return <p className="node-public-text">{value}</p>;
  if (typeof value === "number" || typeof value === "boolean") {
    return <p className="node-public-text">{String(value)}</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ol className="node-public-list">
        {value.map((item, index) => (
          <li key={`${index}:${typeof item}`}>
            <ReadableValue value={item} />
          </li>
        ))}
      </ol>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="node-public-fields">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <p className="node-public-text">{String(value)}</p>;
}

function DetailSection({
  label,
  description,
  value,
  primary = false,
}: {
  label: string;
  description: string;
  value: unknown;
  primary?: boolean;
}) {
  return (
    <details
      className={`node-detail-section${primary ? " node-detail-section--primary" : ""}`}
      open={primary}
    >
      <summary>
        <span>
          <strong>{label}</strong>
          <small>{description}</small>
        </span>
        <ChevronDown aria-hidden="true" size={16} />
      </summary>
      <div className="node-detail-section__content">
        <ReadableValue value={value} />
      </div>
    </details>
  );
}

export function NodeDetail({
  input,
  output,
  facts,
  internalActivity,
  governance,
  stepInput,
}: StageContent) {
  return (
    <div className="execution-node-detail">
      <DetailSection
        label="节点结果"
        description="这个节点完成后交给下游的公开结果"
        value={output}
        primary
      />
      {internalActivity !== undefined && (
        <DetailSection
          label="节点内部活动"
          description="模型审批、只读Tool与进程事件；这些是子活动，不是额外的MAF节点"
          value={internalActivity}
          primary
        />
      )}
      {stepInput !== undefined && (
        <DetailSection
          label="实际步骤输入"
          description="本轮真正交给这个Executor或Agent的工作包"
          value={stepInput}
        />
      )}
      <DetailSection
        label="公开输入"
        description="Trace允许设计者检查的节点入口内容"
        value={input}
      />
      <DetailSection label="运行事实" description="状态、时间、路由和关联标识" value={facts} />
      {governance !== undefined && (
        <DetailSection
          label="治理与持久化事实"
          description="审批、版本、策略与持久化记录"
          value={governance}
        />
      )}
      <p>
        <ShieldCheck size={14} />
        这里只展示可审核的公开内容和运行事实，不保存或展示模型隐藏推理。
      </p>
    </div>
  );
}

/**
 * Project the latest immutable runtime work package for one real Workflow node.
 *
 * Older runs have no StepInputProjection and intentionally degrade to no
 * section. The UI must not infer historical inputs from the current Workflow.
 */
export function stepInputForNode(nodeId: string, stepInputs: StepInputProjection[]): unknown {
  const projection = stepInputs
    .filter((value) => value.node_id === nodeId)
    .sort((left, right) => right.projection_revision - left.projection_revision)[0];
  if (!projection) return undefined;
  return {
    目标与背景: projection.input,
    可用能力: projection.capability_allowlist,
    预算: projection.budget,
    输出合同: projection.output_contract,
    停止条件: projection.stop_conditions,
    绑定: {
      agent_profile: projection.agent_profile_key,
      context_package_id: projection.context_package_id,
      protocol_definition_id: projection.protocol_definition_id,
      protocol_binding_id: projection.protocol_binding_id,
      run_spec_id: projection.run_spec_id,
    },
    revision: projection.projection_revision,
    hash: projection.projection_hash,
  };
}

/**
 * Join persisted governance facts to a stable Workflow executor id.
 *
 * This is a read projection only. Missing or older governance records degrade
 * to no detail instead of inventing a Workflow state.
 */
const PI_ACTIVITY_LABELS: Record<string, string> = {
  process_started: "pi只读进程启动",
  model_call_waiting: "模型调用等待治理",
  model_call_completed: "模型调用完成",
  tool_requested: "只读Tool请求",
  tool_completed: "只读Tool完成",
  process_completed: "pi只读进程完成",
  process_failed: "pi只读进程未完成",
};

function latestPiExecution(values: GovernedToolExecution[]): GovernedToolExecution | undefined {
  return values
    .filter((value) => value.tool_id === "pi_agent")
    .sort((left, right) => {
      const ordinalDifference =
        (right.execution_ordinal ?? Number.NEGATIVE_INFINITY) -
        (left.execution_ordinal ?? Number.NEGATIVE_INFINITY);
      if (ordinalDifference !== 0) return ordinalDifference;
      return right.started_at.localeCompare(left.started_at);
    })[0];
}

/**
 * Prefer the durable ToolExecution result over a sparse Workflow Trace event.
 *
 * The pi dispatch executor persists its public result in the ToolExecution
 * aggregate. Treating a missing Trace payload as "no result" would hide the
 * authoritative execution outcome from the designer.
 */
export function outputForNode(
  nodeId: string,
  traceOutput: unknown,
  toolExecutions: GovernedToolExecution[],
): unknown {
  if (nodeId !== "pi_readonly_dispatch") return traceOutput;
  const execution = latestPiExecution(toolExecutions);
  if (!execution) return traceOutput;
  if (execution.result !== null) return execution.result;
  return {
    状态: execution.status,
    终止原因: execution.terminal_reason_code,
    失败码: execution.failure_code,
  };
}

function governedExecutionProjection(value: GovernedToolExecution): unknown {
  const activities = (value.metrics.activities ?? []).map((activity) => ({
    序号: activity.sequence,
    活动: PI_ACTIVITY_LABELS[activity.stage] ?? activity.stage,
    状态: activity.status,
    说明: activity.summary,
    ...(Object.keys(activity.details).length > 0 ? { 公开细节: activity.details } : {}),
  }));
  return {
    执行概览: {
      状态: value.status,
      进程发送: value.process_dispatch_state,
      终止原因: value.terminal_reason_code,
      失败码: value.failure_code,
    },
    活动时间线: activities,
    模型与Tool统计: {
      模型调用: value.model_call_count,
      内部只读Tool调用: value.internal_tool_call_count,
      输入Token: value.tokens.input,
      输出Token: value.tokens.output,
      耗时毫秒: value.duration_ms,
      成本: value.cost,
    },
    Repository只读围栏: {
      Binding: value.repository_binding_id,
      Snapshot: value.repository_snapshot_id,
      模式: value.mode,
    },
  };
}

export function internalActivityForNode(
  nodeId: string,
  toolExecutions: GovernedToolExecution[],
): unknown {
  if (nodeId !== "pi_readonly_dispatch") return undefined;
  const execution = latestPiExecution(toolExecutions);
  return execution ? governedExecutionProjection(execution) : undefined;
}

function governedExecutionAudit(values: GovernedToolExecution[]): unknown {
  if (values.length === 0) return undefined;
  return values.map((value) => ({
    执行标识: {
      ToolExecution: value.id,
      ProductRun: value.run_id,
      RunAttempt: value.run_attempt_id,
      RuntimeJob: value.runtime_job_id,
      RunSpec: value.run_spec_id,
    },
    config_revision: value.config_revision,
    row_version: value.row_version,
    结果Hash: value.result_hash,
  }));
}

export function governanceForNode(
  nodeId: string,
  governance: RunGovernanceView | null,
  toolExecutions: GovernedToolExecution[] = [],
): unknown {
  const executionValues =
    nodeId === "pi_readonly_dispatch"
      ? governedExecutionAudit(toolExecutions.filter((value) => value.tool_id === "pi_agent"))
      : undefined;
  if (!governance) {
    return executionValues === undefined ? undefined : { ToolExecution审计索引: executionValues };
  }
  const evaluations = governance.policy_evaluations.filter(
    (value) => value.workflow_node_id === nodeId,
  );
  const decisionKeys = new Set(evaluations.map((value) => value.decision_point_key));
  const decisionRequests = governance.decision_requests.filter((value) => {
    const evidence = value.visible_evidence;
    const requestNode =
      typeof evidence === "object" &&
      evidence !== null &&
      typeof (evidence as Record<string, unknown>).workflow_node_id === "string"
        ? String((evidence as Record<string, unknown>).workflow_node_id)
        : null;
    if (requestNode !== null) return requestNode === nodeId;
    return (
      typeof value.decision_point_key === "string" && decisionKeys.has(value.decision_point_key)
    );
  });
  const modelCalls = governance.model_calls.filter((value) => value.workflow_node_id === nodeId);
  if (nodeId === "execution_draft_compiler") {
    return { ExecutionDraft: governance.execution_draft };
  }
  if (nodeId === "run_spec_compiler") {
    return { RunSpec: governance.run_spec };
  }
  if (nodeId === "turn_summary_persist") {
    return { TurnSummary: governance.turn_summary };
  }
  if (
    evaluations.length === 0 &&
    decisionRequests.length === 0 &&
    modelCalls.length === 0 &&
    executionValues === undefined
  ) {
    return undefined;
  }
  return {
    ...(evaluations.length > 0 ? { PolicyEvaluations: evaluations } : {}),
    ...(decisionRequests.length > 0 ? { HumanDecisionRequests: decisionRequests } : {}),
    ...(modelCalls.length === 1 ? { ModelCallDraft: modelCalls[0] } : {}),
    ...(modelCalls.length > 1 ? { ModelCallDrafts: modelCalls } : {}),
    ...(executionValues !== undefined ? { ToolExecution审计索引: executionValues } : {}),
  };
}
