import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalDto, PlanDto, RunDto, WorkflowRunViewDto } from "@chat/contracts/public";
import { ApiProblemError } from "../../api/client.js";
import type { RealChainState } from "../../real/use-real-chain.js";
import { useOnlineState } from "../../use-online-state.js";
import {
  linearizedWorkflowView,
  WorkflowLayoutError,
} from "../../workflow/layout-workflow-view.js";
import { useWorkflowRunView } from "../../workflow/use-workflow-run-view.js";
import { PlanPanel } from "../PlanPanel.js";
import { WorkflowLinearList } from "./WorkflowLinearList.js";
import { WorkflowNodeInspector, type WorkflowInspectorTab } from "./WorkflowNodeInspector.js";

const LazyWorkflowCanvas = lazy(() =>
  import("./WorkflowCanvas.js").then((module) => ({ default: module.WorkflowCanvas })),
);

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "outcome_unknown"]);
const INSPECTOR_TABS = new Set<WorkflowInspectorTab>([
  "overview",
  "input",
  "output",
  "timeline",
  "evidence",
]);

function useWideWorkflowCanvas(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth > 760);
  useEffect(() => {
    const update = () => setWide(window.innerWidth > 760);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return wide;
}

function selectedTabFromUrl(): WorkflowInspectorTab {
  const raw = new URL(window.location.href).searchParams.get("workflowTab");
  return raw !== null && INSPECTOR_TABS.has(raw as WorkflowInspectorTab)
    ? (raw as WorkflowInspectorTab)
    : "overview";
}

function writeWorkflowLocation(
  runId: string,
  nodeId: string | null,
  tab: WorkflowInspectorTab,
): void {
  const url = new URL(window.location.href);
  url.searchParams.set("workflowRun", runId);
  if (nodeId === null) {
    url.searchParams.delete("workflowNode");
    url.searchParams.delete("workflowTab");
  } else {
    url.searchParams.set("workflowNode", nodeId);
    url.searchParams.set("workflowTab", tab);
  }
  window.history.replaceState(window.history.state, "", url);
}

function runViewIsConsistent(run: RunDto, view: WorkflowRunViewDto): boolean {
  if (view.productRunId !== run.productRunId) return false;
  // 迁移前没有NodeRun台账的历史只能诚实标记“细节有限”；queued是缺证据投影，
  // 不是当年真的仍在排队。legacy只校验身份/图结构，不能用新事实标准否定旧历史。
  if (view.historyCompleteness === "legacy_limited") return true;
  const statuses = new Set(view.nodeRuns.map((node) => node.status));
  if (
    run.status === "succeeded" &&
    ["queued", "running", "waiting_human", "failed", "outcome_unknown"].some((status) =>
      statuses.has(status as never),
    )
  ) {
    return false;
  }
  if (run.status === "waiting_human" && !statuses.has("waiting_human")) return false;
  return true;
}

function ViewProblem({ error }: { readonly error: unknown }) {
  const problem = error instanceof ApiProblemError ? error : null;
  return (
    <div className="workflow-view-problem" aria-live="polite">
      <strong>
        {problem?.code === "not_found"
          ? "这次运行不存在或你没有查看权限"
          : problem?.code === "network_unknown"
            ? "暂时无法读取运行图"
            : "运行图数据不符合公开合同"}
      </strong>
      <p>
        {problem?.code === "network_unknown"
          ? "计划审核仍可在下方继续；网络恢复后重新读取运行图。"
          : "请刷新当前会话，确认本地定位仍有效。"}
      </p>
    </div>
  );
}

function focusWorkflowNode(nodeId: string): void {
  const candidate = [
    ...document.querySelectorAll<HTMLButtonElement>("[data-workflow-node-id]"),
  ].find((element) => element.dataset.workflowNodeId === nodeId);
  candidate?.focus({ preventScroll: true });
}

export function WorkflowRunPanel({
  chain,
  run,
  plans,
  approval,
}: {
  readonly chain: RealChainState;
  readonly run: RunDto;
  readonly plans: readonly PlanDto[];
  readonly approval: ApprovalDto | null;
}) {
  const online = useOnlineState();
  const wideCanvas = useWideWorkflowCanvas();
  const active = !TERMINAL_RUN_STATUSES.has(run.status);
  const viewQuery = useWorkflowRunView(run.productRunId, { active });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkflowInspectorTab>(selectedTabFromUrl);
  const [collapsedParentNodeRunIds, setCollapsedParentNodeRunIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [reviewDraft, setReviewDraft] = useState("");
  const initializedRunId = useRef<string | null>(null);
  const view = viewQuery.data;

  useEffect(() => {
    if (initializedRunId.current === run.productRunId || view === undefined) return;
    initializedRunId.current = run.productRunId;
    setCollapsedParentNodeRunIds(new Set());
    setReviewDraft(
      chain.pendingDecision?.payload.kind === "request_revision"
        ? (chain.pendingDecision.payload.revisionInstruction ?? "")
        : "",
    );
    const url = new URL(window.location.href);
    const restoredNodeId =
      url.searchParams.get("workflowRun") === run.productRunId
        ? url.searchParams.get("workflowNode")
        : null;
    const restorable =
      restoredNodeId !== null &&
      (view.nodeRuns.some((node) => node.workflowNodeRunId === restoredNodeId) ||
        view.definitionNodes.some(
          (node) => `definition:${node.definitionNodeId}` === restoredNodeId,
        ));
    const initial = restorable
      ? restoredNodeId
      : (view.nodeRuns.find((node) => node.status === "waiting_human")?.workflowNodeRunId ?? null);
    setSelectedNodeId(initial);
    const initialTab = selectedTabFromUrl();
    setTab(initialTab);
    writeWorkflowLocation(run.productRunId, initial, initialTab);
  }, [chain.pendingDecision, run.productRunId, view]);

  useEffect(() => {
    if (view === undefined || selectedNodeId === null) return;
    const stillExists =
      view.nodeRuns.some((node) => node.workflowNodeRunId === selectedNodeId) ||
      view.definitionNodes.some((node) => `definition:${node.definitionNodeId}` === selectedNodeId);
    if (!stillExists) setSelectedNodeId(null);
  }, [selectedNodeId, view]);

  const selectedNode = useMemo(
    () => view?.nodeRuns.find((node) => node.workflowNodeRunId === selectedNodeId) ?? null,
    [selectedNodeId, view],
  );
  const waitingReviewNode =
    view?.nodeRuns.find(
      (node) =>
        (node.nodeType === "human.plan_review" || node.nodeType === "human.note_review") &&
        node.status === "waiting_human",
    ) ?? null;
  const chooseNode = useCallback(
    (nodeId: string) => {
      setSelectedNodeId(nodeId);
      setTab("overview");
      writeWorkflowLocation(run.productRunId, nodeId, "overview");
    },
    [run.productRunId],
  );
  const toggleChildren = useCallback((nodeId: string) => {
    setCollapsedParentNodeRunIds((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  if (viewQuery.isPending) {
    return (
      <section className="workflow-run-panel" aria-label="工作流运行">
        <p className="loading-note">正在读取真实节点运行图…</p>
      </section>
    );
  }
  if (viewQuery.isError || view === undefined) {
    return (
      <section className="workflow-run-panel" aria-label="工作流运行">
        <ViewProblem error={viewQuery.error} />
        <button className="small-button" type="button" onClick={() => void viewQuery.refetch()}>
          重新读取运行图
        </button>
        <PlanPanel chain={chain} run={run} plans={plans} approval={approval} />
      </section>
    );
  }

  let consistent = runViewIsConsistent(run, view);
  try {
    // 线性化与Canvas共用结构校验；错误图不会进入React Flow后被静默“修复”。
    linearizedWorkflowView(view);
  } catch (error) {
    if (error instanceof WorkflowLayoutError) consistent = false;
    else throw error;
  }
  if (!consistent) {
    return (
      <section className="workflow-run-panel" aria-label="工作流运行">
        <p className="workflow-data-inconsistent" role="alert">
          Product Run与节点运行事实不一致，已停止渲染运行图；请重新读取服务端事实。
        </p>
        <button className="small-button" type="button" onClick={() => void viewQuery.refetch()}>
          重新读取
        </button>
        <PlanPanel chain={chain} run={run} plans={plans} approval={approval} />
      </section>
    );
  }

  return (
    <section className="workflow-run-panel" aria-label="工作流运行">
      <header className="workflow-run-header">
        <div>
          <span className="eyebrow">真实运行图</span>
          <h3>{view.title}</h3>
          <p>{view.nodeRuns.length} 个运行实例 · 从左到右推进</p>
        </div>
        <div className="workflow-run-badges" aria-live="polite">
          {!online && <span data-tone="warning">离线 · 显示上次快照</span>}
          {viewQuery.isFetching && online && <span>正在同步</span>}
          {view.historyCompleteness === "legacy_limited" && (
            <span data-tone="warning">旧运行 · 细节有限</span>
          )}
          {waitingReviewNode !== null &&
            selectedNode?.workflowNodeRunId !== waitingReviewNode.workflowNodeRunId && (
              <button
                type="button"
                className="small-button"
                onClick={() => chooseNode(waitingReviewNode.workflowNodeRunId)}
              >
                转到等待审核节点
              </button>
            )}
        </div>
      </header>
      <div className="workflow-run-content" data-inspector-open={selectedNode !== null}>
        <div className="workflow-graph-region">
          {wideCanvas ? (
            <Suspense fallback={<p className="loading-note">正在载入横向画布…</p>}>
              <LazyWorkflowCanvas
                view={view}
                viewportClass={window.innerWidth < 1_100 ? "compact" : "desktop"}
                selectedNodeId={selectedNodeId}
                collapsedParentNodeRunIds={collapsedParentNodeRunIds}
                onSelect={chooseNode}
                onToggleChildren={toggleChildren}
              />
            </Suspense>
          ) : (
            <WorkflowLinearList
              view={view}
              selectedNodeId={selectedNodeId}
              collapsedParentNodeRunIds={collapsedParentNodeRunIds}
              onSelect={chooseNode}
              onToggleChildren={toggleChildren}
            />
          )}
        </div>
        {selectedNode !== null && (
          <WorkflowNodeInspector
            chain={chain}
            run={run}
            plans={plans}
            approval={approval}
            node={selectedNode}
            expectedViewHash={view.viewHash}
            tab={tab}
            onTabChange={(nextTab) => {
              setTab(nextTab);
              writeWorkflowLocation(run.productRunId, selectedNode.workflowNodeRunId, nextTab);
            }}
            onClose={() => {
              const previous = selectedNode.workflowNodeRunId;
              setSelectedNodeId(null);
              writeWorkflowLocation(run.productRunId, null, tab);
              requestAnimationFrame(() => focusWorkflowNode(previous));
            }}
            revisionInstructionDraft={{ value: reviewDraft, onChange: setReviewDraft }}
          />
        )}
      </div>
      {run.status === "succeeded" && (
        <p className="run-done-note">工作已完成，正式结果已作为Assistant消息进入对话。</p>
      )}
      {run.status === "failed" && (
        <p className="decision-error" role="alert">
          这次工作失败了{run.failure !== undefined ? `：${run.failure.summary}` : "。"}
          可以从失败节点查看公开原因和证据。
        </p>
      )}
    </section>
  );
}
