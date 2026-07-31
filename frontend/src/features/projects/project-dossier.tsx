import {
  ArrowLeft,
  BookOpenText,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  FileArchive,
  FolderTree,
  RefreshCw,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ApiError } from "../../api-client";
import {
  getObsidianProjectArchive,
  getObsidianProjectTree,
  getProjectDossier,
  type ObsidianProjectTree,
  type ProjectDossierData,
  type ProjectionEnvelope,
} from "../projections/projection-api";
import {
  KnowledgeSummary,
  PROJECT_STATUS_LABELS,
  ProjectionSectionCard,
  ResponsibilityLaneCard,
  WorkAndPlanList,
} from "./project-dossier-presenters";

export function ProjectDossier({
  projectId,
  onBack,
  onContinue,
  onManage,
}: {
  projectId: string;
  onBack: () => void;
  onContinue: (title: string, projectId: string) => void;
  onManage: () => void;
}) {
  const [dossier, setDossier] = useState<ProjectionEnvelope<ProjectDossierData> | null>(null);
  const [tree, setTree] = useState<ObsidianProjectTree | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [treeLoading, setTreeLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    void refreshVersion;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setTree(null);
    setSelectedTreePath(null);
    void getProjectDossier(projectId, controller.signal)
      .then(setDossier)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(reason instanceof Error ? reason : new Error("读取Project档案失败"));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [projectId, refreshVersion]);

  const previewTree = async () => {
    setTreeLoading(true);
    setError(null);
    try {
      const nextTree = await getObsidianProjectTree(projectId);
      setTree(nextTree);
      setSelectedTreePath(nextTree.files[0]?.path ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("读取Obsidian目录失败"));
    } finally {
      setTreeLoading(false);
    }
  };

  const downloadTree = async () => {
    setDownloading(true);
    setError(null);
    try {
      const archive = await getObsidianProjectArchive(projectId);
      const url = URL.createObjectURL(archive.blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = archive.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("下载Obsidian快照失败"));
    } finally {
      setDownloading(false);
    }
  };

  if (loading && !dossier) {
    return (
      <DossierState icon={<RefreshCw className="workspace-spin" />} title="正在组合Project档案" />
    );
  }
  if (error && !dossier) {
    return (
      <DossierState
        action="重试"
        detail={errorDetail(error)}
        icon={<CircleAlert />}
        onAction={() => setRefreshVersion((value) => value + 1)}
        title="Project档案暂时不可用"
      />
    );
  }
  if (!dossier) return null;

  const { data } = dossier;
  const selectedTreeFile = tree?.files.find((file) => file.path === selectedTreePath) ?? null;
  return (
    <main className="project-dossier" id="project-dossier" tabIndex={-1}>
      <header className="project-dossier__topline">
        <button className="workspace-back" onClick={onBack} type="button">
          <ArrowLeft size={17} /> 返回工作台
        </button>
        <div className="projection-trust-line" role="status">
          <ShieldCheck size={15} />
          <span>Product Store同源 · revision {data.project.row_version}</span>
          <span>{formatTimestamp(dossier.source_snapshot_at)}</span>
        </div>
      </header>

      <section className="project-dossier__hero">
        <div>
          <span className={`workspace-domain workspace-domain--${data.domain}`}>
            {domainLabel(data.domain)}
          </span>
          <h1>{data.project.title}</h1>
          <p>{data.project.goal}</p>
          <div className="project-dossier__meta">
            <span>{PROJECT_STATUS_LABELS[data.project.status] ?? data.project.status}</span>
            <span>Project ID {shortId(data.project.id)}</span>
            <span>投影 {shortId(dossier.projection_revision)}</span>
          </div>
        </div>
        <div className="project-dossier__actions">
          <button
            className="workspace-primary-action"
            onClick={() => onContinue(data.project.title, data.project.id)}
            type="button"
          >
            继续推进
          </button>
          <button onClick={() => void downloadTree()} type="button">
            <Download size={16} /> {downloading ? "生成中…" : "下载Obsidian快照"}
          </button>
          <button onClick={onManage} type="button">
            <FolderTree size={16} /> 管理Project与资源
          </button>
        </div>
      </section>

      {error ? (
        <p className="workspace-inline-error" role="alert">
          <CircleAlert size={15} /> {errorDetail(error)}
        </p>
      ) : null}

      <section aria-label="Project状态摘要" className="project-dossier__metrics">
        <Metric value={data.counts.open_work} label="开放Work" />
        <Metric value={data.counts.open_actions} label="下一行动" />
        <Metric value={data.counts.blocked} label="阻塞" attention={data.counts.blocked > 0} />
        <Metric value={data.evidence.reference_count} label="Evidence引用" />
      </section>

      <section className="dossier-section">
        <SectionHeading
          icon={<UsersRound size={19} />}
          title="谁来做什么"
          detail="只显示正式Action和已接受Plan步骤；模型建议不会混入。"
        />
        <div className="responsibility-grid">
          {data.role_lanes.map((lane) => (
            <ResponsibilityLaneCard key={lane.assignee_kind} lane={lane} />
          ))}
        </div>
      </section>

      <div className="project-dossier__content-grid">
        <section className="dossier-section dossier-section--work">
          <SectionHeading
            icon={<CheckCircle2 size={19} />}
            title="Work与Plan"
            detail={`${data.count_progress.completed}/${data.count_progress.total} 个Work已进入completed；数量不代表质量。`}
          />
          <WorkAndPlanList workItems={data.work_items} />
        </section>

        <section className="dossier-section">
          <SectionHeading
            icon={<BookOpenText size={19} />}
            title="知识与方法"
            detail="Note、Accepted Memory和当前解析到的协作方法。"
          />
          <KnowledgeSummary data={data} />
        </section>
      </div>

      <section className="dossier-section dossier-section--obsidian">
        <SectionHeading
          icon={<FileArchive size={19} />}
          title="Obsidian只读呈现"
          detail="文件可删除、可重建；在Obsidian中编辑不会直接写回Product Store。"
        />
        <div className="obsidian-actions">
          <button disabled={treeLoading} onClick={() => void previewTree()} type="button">
            <FolderTree size={16} /> {treeLoading ? "读取中…" : "预览目录结构"}
          </button>
          <button disabled={downloading} onClick={() => void downloadTree()} type="button">
            <Download size={16} /> 下载ZIP
          </button>
        </div>
        {tree ? (
          <div className="obsidian-tree" aria-live="polite">
            <p>
              {tree.file_count} 个文件 · {formatBytes(tree.total_bytes)} · tree{" "}
              {shortId(tree.tree_hash)}
            </p>
            <section aria-label="可滚动的Obsidian文件目录" className="obsidian-tree__files">
              <ul>
                {tree.files.map((file) => (
                  <li key={file.path}>
                    <button
                      aria-pressed={file.path === selectedTreePath}
                      onClick={() => setSelectedTreePath(file.path)}
                      type="button"
                    >
                      <code>{file.path}</code>
                    </button>
                    <span>{formatBytes(file.size_bytes)}</span>
                  </li>
                ))}
              </ul>
            </section>
            {selectedTreeFile ? (
              <div className="obsidian-file-preview">
                <strong>{selectedTreeFile.path}</strong>
                <textarea
                  aria-label={`文件预览 ${selectedTreeFile.path}`}
                  readOnly
                  value={selectedTreeFile.content}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="dossier-section">
        <SectionHeading
          icon={<Clock3 size={19} />}
          title="已知缺口与新鲜度"
          detail="unknown不等于没有；partial不等于完整。"
        />
        <div className="projection-section-grid">
          {Object.entries(dossier.sections).map(([key, value]) => (
            <ProjectionSectionCard key={key} name={key} section={value} />
          ))}
        </div>
      </section>
    </main>
  );
}

function Metric({
  value,
  label,
  attention = false,
}: {
  value: number;
  label: string;
  attention?: boolean;
}) {
  return (
    <div className={attention ? "is-attention" : ""}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <header className="dossier-section-heading">
      <span>{icon}</span>
      <div>
        <h2>{title}</h2>
        <p>{detail}</p>
      </div>
    </header>
  );
}

function DossierState({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <main className="workspace-state" role={detail ? "alert" : "status"}>
      {icon}
      <strong>{title}</strong>
      {detail ? <p>{detail}</p> : null}
      {action && onAction ? (
        <button onClick={onAction} type="button">
          {action}
        </button>
      ) : null}
    </main>
  );
}

function errorDetail(error: Error): string {
  if (error instanceof ApiError) return `${error.message}（${error.code} · ${error.requestId}）`;
  return error.message;
}

function domainLabel(value: string): string {
  return { work: "工作", learning: "学习", research: "研究", life: "生活" }[value] ?? value;
}

function shortId(value: string): string {
  return value.slice(0, 8);
}

function formatTimestamp(value: string | null): string {
  if (!value) return "来源时间未知";
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${(value / 1024).toFixed(1)} KB`;
}
