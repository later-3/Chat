import { BookOpenCheck, Braces, Download, Route } from "lucide-react";

import type { RunTraceReport } from "./workflow-api.js";

function downloadReport(report: RunTraceReport): void {
  const body =
    report.report_kind === "human" && report.text
      ? report.text
      : JSON.stringify(report.content, null, 2);
  const extension = report.report_kind === "human" && report.text ? "md" : "json";
  const blob = new Blob([body], {
    type: extension === "md" ? "text/markdown" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${report.run_id}-${report.report_kind}-trace.${extension}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function WorkflowTraceReports({
  reports,
  terminal,
}: {
  reports: RunTraceReport[];
  terminal: boolean;
}) {
  const human = reports.find((value) => value.report_kind === "human") ?? null;
  const diagnostic = reports.find((value) => value.report_kind === "diagnostic") ?? null;
  const path = human?.content.actual_path ?? [];
  const unvisited = human?.content.unvisited_nodes ?? [];
  const emptyFields = human?.content.empty_fields ?? [];

  return (
    <section className="trace-report-card" aria-label="本轮双Trace报告">
      <div className="workbench-section-heading trace-report-heading">
        <div>
          <BookOpenCheck size={18} />
          <strong>本轮流程报告</strong>
        </div>
        <small>后端确定性生成 · 不调用Agent · 不含隐藏推理</small>
      </div>

      {!human && (
        <p className="workbench-note">
          {terminal
            ? "报告正在从Product Trace生成；稍后会自动刷新。"
            : "Run走到成功、失败、取消或结果未知终态后，自动生成机器版与人读版两份报告。"}
        </p>
      )}

      {human && (
        <>
          <div className="trace-report-summary">
            <div>
              <span>结果</span>
              <strong>{human.content.summary?.result ?? "终态事实已保存"}</strong>
            </div>
            <div>
              <span>实际节点</span>
              <strong>{human.content.summary?.visited_node_count ?? path.length}</strong>
            </div>
            <div>
              <span>Tool执行</span>
              <strong>{human.content.summary?.tool_execution_count ?? 0}</strong>
            </div>
            <div>
              <span>空值说明</span>
              <strong>{human.content.summary?.empty_field_count ?? emptyFields.length}</strong>
            </div>
          </div>

          <div className="trace-report-path">
            <div className="trace-report-subheading">
              <Route size={17} />
              <strong>实际经过路径</strong>
            </div>
            <ol>
              {path.map((node) => (
                <li key={`${node.ordinal}-${node.node_id}`}>
                  <span className="trace-report-ordinal">{node.ordinal}</span>
                  <div>
                    <small>{node.phase}</small>
                    <strong>
                      {node.label} <code>{node.node_id}</code>
                    </strong>
                    <p>{node.path_reason}</p>
                    <details>
                      <summary>查看节点职责与公开输入/输出</summary>
                      <p>{node.purpose}</p>
                      <dl>
                        <div>
                          <dt>公开输入</dt>
                          <dd>{node.input_summary}</dd>
                        </div>
                        <div>
                          <dt>公开输出</dt>
                          <dd>{node.output_summary}</dd>
                        </div>
                      </dl>
                    </details>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <details className="trace-report-details">
            <summary>未经过节点与空值原因（{unvisited.length + emptyFields.length}）</summary>
            <ul>
              {unvisited.map((node) => (
                <li key={`unvisited-${node.node_id}`}>
                  <code>{node.node_id}</code> · [{node.code}] {node.reason}
                </li>
              ))}
              {emptyFields.map((item) => (
                <li key={`empty-${item.node_id}-${item.field}-${item.code}`}>
                  <code>
                    {item.node_id}.{item.field}
                  </code>{" "}
                  · [{item.code}] {item.reason}
                </li>
              ))}
            </ul>
          </details>

          <div className="trace-report-actions">
            <button type="button" onClick={() => downloadReport(human)}>
              <Download size={16} />
              下载人读版 Markdown
            </button>
            {diagnostic && (
              <button type="button" onClick={() => downloadReport(diagnostic)}>
                <Braces size={16} />
                下载机器版 JSON
              </button>
            )}
            <span>
              Trace Sequence {human.source_first_sequence}–{human.source_last_sequence} · Hash{" "}
              <code>{human.content_hash.slice(0, 12)}</code>
            </span>
          </div>
        </>
      )}
    </section>
  );
}
