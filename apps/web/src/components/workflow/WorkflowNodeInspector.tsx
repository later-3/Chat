import { useEffect, useMemo, useRef } from "react";
import type {
  ApprovalDto,
  PlanDto,
  RunDto,
  WorkflowNodeDetailInclude,
  WorkflowNodeManifestDto,
  WorkflowNodeRunSummaryDto,
} from "@chat/contracts/public";
import { ApiProblemError } from "../../api/client.js";
import type { RealChainState } from "../../real/use-real-chain.js";
import { useWorkflowNodeDetail } from "../../workflow/use-workflow-run-view.js";
import {
  formatWorkflowDuration,
  workflowNodeTypeLabel,
  WORKFLOW_STATUS,
} from "../../workflow/workflow-presenters.js";
import { PlanReviewContent } from "../PlanPanel.js";

export type WorkflowInspectorTab = "overview" | "input" | "output" | "timeline" | "evidence";

const INSPECTOR_TABS: readonly {
  readonly id: WorkflowInspectorTab;
  readonly label: string;
  readonly includes: readonly WorkflowNodeDetailInclude[];
}[] = [
  { id: "overview", label: "概览", includes: ["summary"] },
  { id: "input", label: "输入", includes: ["manifests"] },
  { id: "output", label: "输出", includes: ["manifests"] },
  { id: "timeline", label: "时间线", includes: ["timeline"] },
  { id: "evidence", label: "证据", includes: ["evidence"] },
];

type ProductRef = WorkflowNodeManifestDto["slots"][number]["refs"][number];

const REF_KIND_LABEL: Record<ProductRef["kind"], string> = {
  message: "正式消息",
  context_package: "上下文包",
  plan_revision: "计划版本",
  approval_request: "审核请求",
  decision: "人工决定",
  execution_contract: "执行合同",
  execution_candidate: "执行候选",
  validation_result: "验证结果",
  artifact: "产物",
};

function formatTimestamp(value: string | undefined): string {
  if (value === undefined) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function ProductReference({ reference }: { readonly reference: ProductRef }) {
  return (
    <article className="workflow-product-ref">
      <span className="workflow-ref-kind">{REF_KIND_LABEL[reference.kind]}</span>
      <strong>{reference.label}</strong>
      <dl>
        <div>
          <dt>版本</dt>
          <dd>{reference.revision}</dd>
        </div>
        <div>
          <dt>对象</dt>
          <dd>{reference.id}</dd>
        </div>
        <div>
          <dt>Hash</dt>
          <dd title={reference.sha256}>{reference.sha256.slice(0, 12)}</dd>
        </div>
      </dl>
    </article>
  );
}

function ManifestPanel({
  manifest,
  emptyText,
}: {
  readonly manifest: WorkflowNodeManifestDto | undefined;
  readonly emptyText: string;
}) {
  if (manifest === undefined || manifest.slots.length === 0) {
    return <p className="workflow-inspector-empty">{emptyText}</p>;
  }
  return (
    <div className="workflow-manifest">
      {manifest.slots.map((slot) => (
        <section key={slot.name} className="workflow-manifest-slot">
          <h5>{slot.name}</h5>
          <div className="workflow-ref-list">
            {slot.refs.map((reference) => (
              <ProductReference
                key={`${reference.kind}:${reference.id}:${String(reference.revision)}`}
                reference={reference}
              />
            ))}
          </div>
        </section>
      ))}
      <p className="workflow-manifest-hash" title={manifest.sha256}>
        Manifest v{manifest.revision} · {manifest.sha256.slice(0, 12)}
      </p>
    </div>
  );
}

function DetailProblem({ error }: { readonly error: unknown }) {
  const problem = error instanceof ApiProblemError ? error : null;
  return (
    <div className="workflow-detail-problem" role="alert">
      <strong>
        {problem?.code === "not_found"
          ? "节点不存在或你没有查看权限"
          : problem?.code === "network_unknown"
            ? "暂时无法读取节点详情"
            : "节点详情数据不符合公开合同"}
      </strong>
      <p>
        {problem?.code === "network_unknown"
          ? "已保留运行图快照；网络恢复后可重试。"
          : "请刷新当前运行，确认节点仍属于这次工作。"}
      </p>
    </div>
  );
}

function OverviewPanel({ node }: { readonly node: WorkflowNodeRunSummaryDto }) {
  const status = WORKFLOW_STATUS[node.status];
  const duration = formatWorkflowDuration(node);
  return (
    <div className="workflow-overview">
      <dl className="workflow-overview-grid">
        <div>
          <dt>状态</dt>
          <dd className="workflow-node-status" data-tone={status.tone}>
            <span aria-hidden="true">{status.symbol}</span>
            {status.label}
          </dd>
        </div>
        <div>
          <dt>节点类型</dt>
          <dd>{workflowNodeTypeLabel(node.nodeType)}</dd>
        </div>
        <div>
          <dt>尝试</dt>
          <dd>{node.attemptNumber}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{duration ?? "尚未结束"}</dd>
        </div>
        <div>
          <dt>开始</dt>
          <dd>{formatTimestamp(node.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>{formatTimestamp(node.finishedAt)}</dd>
        </div>
      </dl>
      {node.executionPath.length > 0 && (
        <p className="workflow-path-summary">
          循环路径：
          {node.executionPath
            .map((segment) => `${segment.containerNodeId} #${String(segment.iteration)}`)
            .join(" → ")}
        </p>
      )}
      {node.outcomeCode !== undefined && (
        <p className="workflow-path-summary">结果：{node.outcomeCode}</p>
      )}
      {node.publicSummary !== undefined && <p>{node.publicSummary}</p>}
      {node.error !== undefined && (
        <div className="workflow-safe-error" role="alert">
          <strong>{node.error.code}</strong>
          <p>{node.error.summary}</p>
          <small>内部堆栈、Provider响应和凭据不会在此显示。</small>
        </div>
      )}
    </div>
  );
}

function timelineIsConsistent(timeline: readonly { readonly nodeSequence: number }[]): boolean {
  return timeline.every((item, index) => item.nodeSequence === index + 1);
}

function tabFromKeyboard(current: WorkflowInspectorTab, key: string): WorkflowInspectorTab | null {
  const index = INSPECTOR_TABS.findIndex((tab) => tab.id === current);
  if (key === "ArrowRight") return INSPECTOR_TABS[(index + 1) % INSPECTOR_TABS.length]?.id ?? null;
  if (key === "ArrowLeft") {
    return INSPECTOR_TABS[(index - 1 + INSPECTOR_TABS.length) % INSPECTOR_TABS.length]?.id ?? null;
  }
  if (key === "Home") return INSPECTOR_TABS[0]?.id ?? null;
  if (key === "End") return INSPECTOR_TABS.at(-1)?.id ?? null;
  return null;
}

export function WorkflowNodeInspector({
  chain,
  run,
  plans,
  approval,
  node,
  expectedViewHash,
  tab,
  onTabChange,
  onClose,
  revisionInstructionDraft,
}: {
  readonly chain: RealChainState;
  readonly run: RunDto;
  readonly plans: readonly PlanDto[];
  readonly approval: ApprovalDto | null;
  readonly node: WorkflowNodeRunSummaryDto;
  readonly expectedViewHash: string;
  readonly tab: WorkflowInspectorTab;
  readonly onTabChange: (tab: WorkflowInspectorTab) => void;
  readonly onClose: () => void;
  readonly revisionInstructionDraft: {
    readonly value: string;
    readonly onChange: (value: string) => void;
  };
}) {
  const selectedTab = INSPECTOR_TABS.find((candidate) => candidate.id === tab) ?? INSPECTOR_TABS[0];
  const detail = useWorkflowNodeDetail({
    productRunId: run.productRunId,
    workflowNodeRunId: node.workflowNodeRunId,
    includes: selectedTab?.includes ?? ["summary"],
  });
  const tabRefs = useRef(new Map<WorkflowInspectorTab, HTMLButtonElement>());
  const viewHashMismatch =
    detail.data !== undefined &&
    (detail.data.node.workflowNodeRunId !== node.workflowNodeRunId ||
      detail.data.viewHash !== expectedViewHash);
  const timeline = detail.data?.timeline ?? [];
  const evidence = detail.data?.evidence ?? [];
  const timelineConsistent = useMemo(() => timelineIsConsistent(timeline), [timeline]);
  const canSubmitReview =
    node.nodeType === "human.plan_review" &&
    node.status === "waiting_human" &&
    node.allowedActions.includes("submit_decision");

  useEffect(() => {
    const panel = document.getElementById(`workflow-panel-${tab}`);
    panel?.focus({ preventScroll: true });
  }, [tab]);

  return (
    <aside className="workflow-inspector" aria-label={`${node.title}节点详情`}>
      <header className="workflow-inspector-header">
        <div>
          <span className="eyebrow">节点详情</span>
          <h4>{node.title}</h4>
        </div>
        <button type="button" className="small-button" aria-label="关闭节点详情" onClick={onClose}>
          关闭
        </button>
      </header>
      <div className="workflow-inspector-tabs" role="tablist" aria-label="节点详情栏目">
        {INSPECTOR_TABS.map((candidate) => (
          <button
            key={candidate.id}
            ref={(element) => {
              if (element === null) tabRefs.current.delete(candidate.id);
              else tabRefs.current.set(candidate.id, element);
            }}
            type="button"
            role="tab"
            id={`workflow-tab-${candidate.id}`}
            aria-controls={`workflow-panel-${candidate.id}`}
            aria-selected={candidate.id === tab}
            tabIndex={candidate.id === tab ? 0 : -1}
            onClick={() => onTabChange(candidate.id)}
            onKeyDown={(event) => {
              const next = tabFromKeyboard(tab, event.key);
              if (next === null) return;
              event.preventDefault();
              onTabChange(next);
              tabRefs.current.get(next)?.focus();
            }}
          >
            {candidate.label}
          </button>
        ))}
      </div>
      <section
        className="workflow-inspector-panel"
        id={`workflow-panel-${tab}`}
        role="tabpanel"
        aria-labelledby={`workflow-tab-${tab}`}
        tabIndex={-1}
      >
        {detail.isPending ? (
          <p className="workflow-inspector-empty">正在读取{selectedTab?.label ?? "详情"}…</p>
        ) : detail.isError ? (
          <>
            <DetailProblem error={detail.error} />
            <button className="small-button" type="button" onClick={() => void detail.refetch()}>
              重新读取
            </button>
          </>
        ) : viewHashMismatch ? (
          <p className="workflow-data-inconsistent" role="alert">
            节点详情与当前运行图不一致，请刷新运行图后重试。
          </p>
        ) : tab === "overview" ? (
          <>
            <OverviewPanel node={detail.data?.node ?? node} />
            {canSubmitReview && (
              <section className="workflow-review-content" aria-label="当前节点审核">
                <PlanReviewContent
                  chain={chain}
                  run={run}
                  plans={plans}
                  approval={approval}
                  revisionInstructionDraft={revisionInstructionDraft}
                />
              </section>
            )}
            {node.nodeType === "human.plan_review" && !canSubmitReview && (
              <p className="workflow-review-resolution">
                {node.outcomeCode === "policy_auto_continue"
                  ? "本节点按运行前策略自动继续；未生成虚假的人工决定。"
                  : "审核窗口已关闭或当前节点只读，不能再提交决定。"}
              </p>
            )}
          </>
        ) : tab === "input" ? (
          <ManifestPanel manifest={detail.data?.input} emptyText="这个节点没有公开输入引用。" />
        ) : tab === "output" ? (
          <ManifestPanel manifest={detail.data?.output} emptyText="这个节点尚无公开输出引用。" />
        ) : tab === "timeline" ? (
          !timelineConsistent ? (
            <p className="workflow-data-inconsistent" role="alert">
              节点状态序列重复或缺号，已停止展示不可靠时间线。
            </p>
          ) : timeline.length === 0 ? (
            <p className="workflow-inspector-empty">这个节点尚无状态变化。</p>
          ) : (
            <ol className="workflow-node-timeline">
              {timeline.map((item) => {
                const status = WORKFLOW_STATUS[item.toStatus];
                return (
                  <li key={item.nodeSequence}>
                    <span className="workflow-node-status" data-tone={status.tone}>
                      <span aria-hidden="true">{status.symbol}</span>
                      {status.label}
                    </span>
                    <span>{item.reasonKind}</span>
                    <time dateTime={item.occurredAt}>{formatTimestamp(item.occurredAt)}</time>
                    {item.relatedProductRef !== undefined && (
                      <ProductReference reference={item.relatedProductRef} />
                    )}
                  </li>
                );
              })}
            </ol>
          )
        ) : evidence.length === 0 ? (
          <p className="workflow-inspector-empty">这个节点没有公开证据引用。</p>
        ) : (
          <div className="workflow-ref-list">
            {evidence.map((reference) => (
              <ProductReference
                key={`${reference.kind}:${reference.id}:${String(reference.revision)}`}
                reference={reference}
              />
            ))}
          </div>
        )}
      </section>
    </aside>
  );
}
