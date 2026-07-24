import { ArrowRight, Check, CircleSlash2, CornerDownRight, GitBranch, Info } from "lucide-react";
import type { WorkflowPathNode, WorkflowRouteDecision } from "./workflow-route-projection.js";

function displayActual(value: unknown): string {
  if (value === null || value === undefined || value === "") return "未设置";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function WorkflowPathOverview({ path }: { path: WorkflowPathNode[] }) {
  return (
    <section className="workflow-path-overview" aria-label="本次实际运行路径">
      <header>
        <div>
          <CornerDownRight size={18} />
          <strong>本次实际运行路径</strong>
        </div>
        <span>{path.length > 0 ? `经过 ${path.length} 个节点` : "等待节点事件"}</span>
      </header>
      {path.length > 0 ? (
        <ol>
          {path.map((node, index) => (
            <li key={node.id}>
              <span className={`workflow-path-kind workflow-path-kind--${node.kind}`}>
                {index + 1}
              </span>
              <strong>{node.label}</strong>
              {index < path.length - 1 && <ArrowRight aria-hidden="true" size={15} />}
            </li>
          ))}
        </ol>
      ) : (
        <p>Run开始后，这里只排列本轮真正经过的节点，不混入未选择的分支。</p>
      )}
    </section>
  );
}

export function WorkflowRouteExplanation({ decision }: { decision: WorkflowRouteDecision }) {
  const selected = decision.options.find((option) => option.selected);
  return (
    <section className="workflow-route-decision" aria-label="分支选择依据">
      <header>
        <div>
          <GitBranch size={19} />
          <span>
            <small>分支选择</small>
            <strong>为什么走「{selected?.label ?? decision.selectedBranch}」</strong>
          </span>
        </div>
        <span className="workflow-route-mode">
          {decision.selectionMode === "first_match" ? "按顺序 · 首个命中" : decision.selectionMode}
        </span>
      </header>

      <div className="workflow-route-selected">
        <span>实际选择</span>
        <strong>{selected?.label ?? decision.selectedBranch}</strong>
        <code>→ {decision.selectedTarget}</code>
        <p>{decision.selectionReason}</p>
      </div>

      <dl className="workflow-route-facts">
        {Object.entries(decision.facts).map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>{displayActual(value)}</dd>
          </div>
        ))}
      </dl>

      <ol className="workflow-route-options">
        {decision.options.map((option, index) => (
          <li
            className={
              option.selected
                ? "workflow-route-option workflow-route-option--selected"
                : "workflow-route-option"
            }
            key={option.branchId}
          >
            <span className="workflow-route-option-index">{index + 1}</span>
            <span className="workflow-route-option-icon" aria-hidden="true">
              {option.selected ? <Check size={17} /> : <CircleSlash2 size={16} />}
            </span>
            <div>
              <span className="workflow-route-option-heading">
                <strong>{option.label}</strong>
                <em>{option.selected ? "本轮选择" : "本轮未选择"}</em>
              </span>
              <code>{option.condition}</code>
              <p>
                <span>实际值：{displayActual(option.actual)}</span>
                <span>{option.reason}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>

      <footer>
        <Info size={15} />
        <span>
          {decision.evidence === "persisted_evaluation"
            ? "依据：本轮Trace持久化的公开路由求值；不包含模型隐藏推理。"
            : "兼容说明：旧Trace只保存最终分支；逐项说明按同版本Workflow Definition显示。"}
          <code>
            continuous_chat_factory.py · add_switch_case_edge_group → continuous_chat.py ·
            ScenarioRouterExecutor
          </code>
        </span>
      </footer>
    </section>
  );
}
