import { Boxes, UserRound } from "lucide-react";

import type {
  ProjectDossierData,
  ProjectionSection,
  ResponsibilityItem,
  ResponsibilityLane,
} from "../projections/projection-api";

export const PROJECT_STATUS_LABELS: Record<string, string> = {
  proposed: "待确认",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  cancelled: "已取消",
  archived: "已归档",
  draft: "草稿",
  planned: "已规划",
  ready: "可开始",
  pending: "待处理",
  in_progress: "推进中",
  blocked: "受阻",
};

export function ResponsibilityLaneCard({ lane }: { lane: ResponsibilityLane }) {
  return (
    <article className={`responsibility-lane responsibility-lane--${lane.assignee_kind}`}>
      <header>
        {lane.assignee_kind === "user" ? <UserRound size={18} /> : <Boxes size={18} />}
        <div>
          <h3>{lane.label}</h3>
          <p>{lane.description}</p>
        </div>
        <span>{lane.items.length}</span>
      </header>
      {lane.items.length ? (
        <div className="responsibility-list">
          {lane.items.map((item) => (
            <ResponsibilityRow item={item} key={`${item.source_kind}:${item.source_id}`} />
          ))}
        </div>
      ) : (
        <p className="workspace-empty-copy">当前没有该角色的正式行动。</p>
      )}
    </article>
  );
}

export function WorkAndPlanList({ workItems }: { workItems: ProjectDossierData["work_items"] }) {
  if (!workItems.length) {
    return <p className="workspace-empty-copy">还没有Work；Project存在不等于已经形成推进计划。</p>;
  }
  return (
    <div className="dossier-work-list">
      {workItems.map(({ work_item: work, plan }) => (
        <article key={work.id}>
          <header>
            <span>{work.kind}</span>
            <em>{PROJECT_STATUS_LABELS[work.status] ?? work.status}</em>
          </header>
          <h3>{work.title}</h3>
          <p>{work.objective}</p>
          {plan?.revision ? (
            <details>
              <summary>
                Plan revision {plan.revision.revision} · {plan.revision.summary}
              </summary>
              <ol>
                {plan.revision.nodes.map((raw, index) => {
                  const node = asRecord(raw);
                  return (
                    <li key={asText(node.id, String(index))}>{asText(node.title, "未命名步骤")}</li>
                  );
                })}
              </ol>
            </details>
          ) : (
            <small>尚无已接受Plan revision</small>
          )}
        </article>
      ))}
    </div>
  );
}

export function KnowledgeSummary({ data }: { data: ProjectDossierData }) {
  const protocol = data.protocol ? asRecord(data.protocol) : null;
  return (
    <div className="knowledge-summary">
      <article>
        <strong>{data.knowledge.notes.length}</strong>
        <span>Note</span>
      </article>
      <article>
        <strong>{data.knowledge.accepted_memory.length}</strong>
        <span>Accepted Memory</span>
      </article>
      <article className="knowledge-summary__protocol">
        <strong>{protocol ? asText(protocol.protocol_name, "已绑定方法") : "尚不可确定"}</strong>
        <span>{protocol ? `revision ${asText(protocol.revision, "?")}` : "Protocol unknown"}</span>
        {protocol ? <p>{asText(protocol.selection_reason, "当前有效Binding解析结果")}</p> : null}
      </article>
      {data.knowledge.notes.length ? (
        <section aria-label="Project Note" className="knowledge-summary__list">
          <h3>Project Note</h3>
          {data.knowledge.notes.map((raw, index) => {
            const note = asRecord(raw);
            const revision = asRecord(note.current_revision);
            return (
              <article key={asText(note.id, String(index))}>
                <strong>{asText(note.title, "未命名Note")}</strong>
                <span>
                  {asText(note.kind, "note")} · revision {asText(revision.revision, "?")}
                </span>
                <p>{excerpt(revision.content, "当前revision没有可显示正文")}</p>
              </article>
            );
          })}
        </section>
      ) : null}
      {data.knowledge.accepted_memory.length ? (
        <section aria-label="已接受记忆" className="knowledge-summary__list">
          <h3>Accepted Memory</h3>
          {data.knowledge.accepted_memory.map((raw, index) => {
            const memory = asRecord(raw);
            const revision = asRecord(memory.current_revision);
            return (
              <article key={asText(memory.id, String(index))}>
                <strong>{asText(memory.memory_kind, "memory")}</strong>
                <span>revision {asText(revision.revision, "?")}</span>
                <p>{excerpt(revision.content, "当前revision没有可显示内容")}</p>
              </article>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}

export function ProjectionSectionCard({
  name,
  section,
}: {
  name: string;
  section: ProjectionSection;
}) {
  return (
    <article className={`projection-section-state projection-section-state--${section.state}`}>
      <header>
        <strong>{sectionLabel(name)}</strong>
        <span>{section.state}</span>
      </header>
      <p>{section.detail ?? stateExplanation(section)}</p>
      {section.reason_code ? <code>{section.reason_code}</code> : null}
    </article>
  );
}

function ResponsibilityRow({ item }: { item: ResponsibilityItem }) {
  return (
    <div className="responsibility-row">
      <span
        className={`workspace-status-mark workspace-status-mark--${item.status}`}
        aria-hidden="true"
      />
      <div>
        <strong>{item.title}</strong>
        <small>
          {item.work_title ?? "独立行动"} · {PROJECT_STATUS_LABELS[item.status] ?? item.status} ·{" "}
          {item.commitment_state === "committed_action" ? "正式Action" : "已接受Plan步骤"}
        </small>
      </div>
      {item.due_at ? <time>{formatDate(item.due_at)}</time> : null}
    </div>
  );
}

function stateExplanation(section: ProjectionSection): string {
  if (section.state === "empty") return "权威查询成功，当前确实没有记录。";
  if (section.state === "unknown") return "当前来源不足，不能把它解释成没有。";
  if (section.state === "partial") return "当前只覆盖部分权威关系。";
  if (section.state === "forbidden") return "当前身份无权查看。";
  if (section.state === "error") return "该来源本次读取失败。";
  return "当前数据可用。";
}

function sectionLabel(value: string): string {
  return (
    {
      project: "Project",
      current_milestone: "当前里程碑",
      work: "Work",
      responsibilities: "责任",
      knowledge: "知识",
      protocol: "协作方法",
      repositories: "代码资源",
      evidence: "Evidence",
      artifacts: "Artifact",
      schedule: "Schedule",
      delivery: "Delivery",
    }[value] ?? value
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown, fallback: string): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return fallback;
}

function excerpt(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!normalized) return fallback;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(
    new Date(value),
  );
}
