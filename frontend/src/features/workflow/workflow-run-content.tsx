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
import type { RunGovernanceView, StepInputProjection, WorkflowNodeStatus } from "./workflow-api.js";

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

export function NodeDetail({ input, output, facts, governance, stepInput }: StageContent) {
  return (
    <div className="execution-node-detail">
      <DetailSection
        label="节点结果"
        description="这个节点完成后交给下游的公开结果"
        value={output}
        primary
      />
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
export function governanceForNode(nodeId: string, governance: RunGovernanceView | null): unknown {
  if (!governance) return undefined;
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
  const modelCall = governance.model_calls.find((value) => value.workflow_node_id === nodeId);
  if (nodeId === "execution_draft_compiler") {
    return { ExecutionDraft: governance.execution_draft };
  }
  if (nodeId === "run_spec_compiler") {
    return { RunSpec: governance.run_spec };
  }
  if (nodeId === "turn_summary_persist") {
    return { TurnSummary: governance.turn_summary };
  }
  if (evaluations.length === 0 && decisionRequests.length === 0 && !modelCall) return undefined;
  return {
    ...(evaluations.length > 0 ? { PolicyEvaluations: evaluations } : {}),
    ...(decisionRequests.length > 0 ? { HumanDecisionRequests: decisionRequests } : {}),
    ...(modelCall ? { ModelCallDraft: modelCall } : {}),
  };
}
