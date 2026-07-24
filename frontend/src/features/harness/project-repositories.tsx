import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Code2,
  FileText,
  GitBranch,
  Link2,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Unlink,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import "./repository.css";
import {
  detachProjectRepository,
  listProjectRepositories,
  listWorkspaceRoots,
  type RepositoryBinding,
  type RepositoryCommandResult,
  type RepositorySnapshot,
  type RepositorySummary,
  refreshProjectRepository,
  type WorkspaceRootView,
} from "./repository-api";
import { RepositoryBindingDialog } from "./repository-binding-dialog";

const ROLE_LABELS = {
  primary: "主仓库",
  supporting: "配套仓库",
  documentation: "文档仓库",
} as const;

function shortHash(value: string | null | undefined, length = 8): string {
  return value ? value.slice(0, length) : "—";
}

function branchName(snapshot: RepositorySnapshot | null): string {
  if (!snapshot) return "未观察";
  if (snapshot.detached_head) return "detached HEAD";
  return snapshot.head_ref?.replace("refs/heads/", "") ?? "unborn";
}

function observedLabel(value: string | null | undefined): string {
  if (!value) return "尚未观察";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function RepositoryDetails({ summary }: { summary: RepositorySummary }) {
  const latest = summary.latest_snapshot;
  const snapshot =
    latest?.capture_status === "available" ? latest : summary.last_available_snapshot;
  return (
    <div className="repository-details">
      {latest?.capture_status === "unavailable" && (
        <div className="repository-history-warning">
          <CircleAlert size={17} />
          <span>
            <strong>最新检查不可用</strong>
            <small>
              {latest.error_detail_safe ?? latest.error_code}
              ；下面只显示历史基线，不会自动发送给模型。
            </small>
          </span>
        </div>
      )}
      {!snapshot ? (
        <p className="repository-empty-copy">还没有可用的Repository Snapshot。</p>
      ) : (
        <>
          <section>
            <header>
              <GitBranch size={16} />
              <strong>代码基线</strong>
            </header>
            <dl>
              <div>
                <dt>Branch</dt>
                <dd>{branchName(snapshot)}</dd>
              </div>
              <div>
                <dt>HEAD</dt>
                <dd>
                  <code>{shortHash(snapshot.head_oid, 12)}</code>
                </dd>
              </div>
              <div>
                <dt>远端差异</dt>
                <dd>
                  ahead {snapshot.ahead_count} · behind {snapshot.behind_count}
                </dd>
              </div>
              <div>
                <dt>指纹</dt>
                <dd>{snapshot.fingerprint_complete ? "完整" : "超过上限，不完整"}</dd>
              </div>
              <div>
                <dt>语义版本</dt>
                <dd>
                  <code>{shortHash(snapshot.semantic_hash, 12)}</code>
                </dd>
              </div>
              <div>
                <dt>观察时间</dt>
                <dd>{observedLabel(snapshot.observed_at)}</dd>
              </div>
            </dl>
          </section>
          <section>
            <header>
              <Code2 size={16} />
              <strong>未提交变化</strong>
              <span>{snapshot.change_count}</span>
            </header>
            <p className="repository-change-counts">
              staged {snapshot.staged_count} · unstaged {snapshot.unstaged_count} · untracked{" "}
              {snapshot.untracked_count}
            </p>
            {snapshot.change_summary.length === 0 ? (
              <p className="repository-empty-copy">工作树干净。</p>
            ) : (
              <ul className="repository-change-list">
                {snapshot.change_summary.slice(0, 20).map((change) => (
                  <li key={`${change.status}:${change.path}`}>
                    <code>{change.status}</code>
                    <span>{change.path}</span>
                  </li>
                ))}
              </ul>
            )}
            {snapshot.change_count > 20 && (
              <small>这里只展示前20项；完整计数以Snapshot为准。</small>
            )}
          </section>
          <section>
            <header>
              <ShieldCheck size={16} />
              <strong>项目规则</strong>
              <span>{snapshot.governance_manifest.length}</span>
            </header>
            {snapshot.governance_manifest.length === 0 ? (
              <p className="repository-empty-copy">允许清单中没有可用的治理文档。</p>
            ) : (
              <ul className="repository-governance-list">
                {snapshot.governance_manifest.map((document) => (
                  <li key={document.path}>
                    <FileText size={15} />
                    <span>
                      <strong>{document.path}</strong>
                      <small>
                        {shortHash(document.sha256)} · {document.size_bytes} bytes
                      </small>
                    </span>
                    <em>尚未进入本轮Context</em>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export function ProjectRepositories({
  projectId,
  projectRowVersion,
  onProjectRowVersionChange,
}: {
  projectId: string;
  projectRowVersion: number;
  onProjectRowVersionChange: (value: number) => void;
}) {
  const [summaries, setSummaries] = useState<RepositorySummary[]>([]);
  const [roots, setRoots] = useState<WorkspaceRootView[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    { mode: "bind" } | { mode: "rebind"; binding: RepositoryBinding } | null
  >(null);
  const [detachingId, setDetachingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentProjectVersion, setCurrentProjectVersion] = useState(projectRowVersion);

  useEffect(() => setCurrentProjectVersion(projectRowVersion), [projectRowVersion]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repositoryValues, rootValues] = await Promise.all([
        listProjectRepositories(projectId),
        listWorkspaceRoots(),
      ]);
      setSummaries(repositoryValues);
      setRoots(rootValues);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取Project资源失败");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceResult = (result: RepositoryCommandResult) => {
    setSummaries((current) => {
      const existing = current.find((value) => value.binding.id === result.binding.id);
      const next: RepositorySummary = {
        binding: result.binding,
        latest_snapshot: result.snapshot ?? existing?.latest_snapshot ?? null,
        last_available_snapshot:
          result.snapshot?.capture_status === "available"
            ? result.snapshot
            : (existing?.last_available_snapshot ?? null),
      };
      return existing
        ? current.map((value) => (value.binding.id === result.binding.id ? next : value))
        : [next, ...current];
    });
    if (result.project_row_version) {
      setCurrentProjectVersion(result.project_row_version);
      onProjectRowVersionChange(result.project_row_version);
    }
  };

  const refresh = async (summary: RepositorySummary) => {
    setBusyId(summary.binding.id);
    setError(null);
    try {
      replaceResult(
        await refreshProjectRepository({
          bindingId: summary.binding.id,
          expectedBindingRowVersion: summary.binding.row_version,
        }),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "刷新Repository失败");
    } finally {
      setBusyId(null);
    }
  };

  const detach = async (summary: RepositorySummary) => {
    setBusyId(summary.binding.id);
    setError(null);
    try {
      replaceResult(
        await detachProjectRepository({
          bindingId: summary.binding.id,
          expectedProjectRowVersion: currentProjectVersion,
          expectedBindingRowVersion: summary.binding.row_version,
        }),
      );
      setDetachingId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解除Repository失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="project-repositories">
      <header>
        <div>
          <p className="eyebrow">CODE & GOVERNANCE</p>
          <h4>代码与项目规则</h4>
          <p>Project只保存绑定与只读Snapshot；源码仍由Git和文件系统拥有。</p>
        </div>
        <button onClick={() => setDialog({ mode: "bind" })} type="button">
          <Plus size={16} />
          连接仓库
        </button>
      </header>
      {error && <p className="harness-error">{error}</p>}
      {loading ? (
        <p className="repository-loading">
          <LoaderCircle size={17} />
          正在读取Repository资源…
        </p>
      ) : summaries.length === 0 ? (
        <button
          className="repository-empty-action"
          onClick={() => setDialog({ mode: "bind" })}
          type="button"
        >
          <Link2 size={22} />
          <span>
            <strong>让这个Project认识它的代码</strong>
            <small>从服务端允许的目录中选择；连接过程只读，不会修改仓库。</small>
          </span>
        </button>
      ) : (
        <div className="repository-card-list">
          {summaries.map((summary) => {
            const latest = summary.latest_snapshot;
            const visibleSnapshot =
              latest?.capture_status === "available" ? latest : summary.last_available_snapshot;
            const expanded = expandedId === summary.binding.id;
            const unavailable = summary.binding.status === "unavailable";
            return (
              <article
                className={`repository-card repository-card--${summary.binding.status}`}
                key={summary.binding.id}
              >
                <header>
                  <span className="repository-card-icon">
                    <GitBranch size={18} />
                  </span>
                  <div>
                    <strong>{summary.binding.display_name}</strong>
                    <small>
                      {ROLE_LABELS[summary.binding.role]} · {summary.binding.root_label} /{" "}
                      {summary.binding.relative_path}
                    </small>
                  </div>
                  <span className="repository-status">
                    {summary.binding.status === "active"
                      ? "可用"
                      : summary.binding.status === "unavailable"
                        ? "不可用"
                        : "已解除"}
                  </span>
                </header>
                <div className="repository-card-summary">
                  <span>
                    {branchName(visibleSnapshot)} · {shortHash(visibleSnapshot?.head_oid)}
                  </span>
                  <span>{observedLabel(latest?.observed_at)}</span>
                  <strong className={visibleSnapshot?.dirty ? "is-dirty" : ""}>
                    {visibleSnapshot?.dirty
                      ? `${visibleSnapshot.change_count}项未提交变化`
                      : "工作树干净"}
                  </strong>
                </div>
                {unavailable && (
                  <p className="repository-unavailable-copy">
                    <CircleAlert size={15} />
                    最新观察不可用；历史基线仅供查看，不会自动发送给模型。
                  </p>
                )}
                {summary.binding.status === "detached" && (
                  <p className="repository-detached-copy">
                    <Unlink size={15} />
                    已解除连接；历史基线仍可查看，但不再进入新的Context候选。
                  </p>
                )}
                <footer>
                  <button
                    onClick={() => setExpandedId(expanded ? null : summary.binding.id)}
                    type="button"
                  >
                    {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    {expanded ? "收起基线" : "查看基线"}
                  </button>
                  <button
                    disabled={
                      busyId === summary.binding.id || summary.binding.status === "detached"
                    }
                    onClick={() => void refresh(summary)}
                    type="button"
                  >
                    <RefreshCw size={15} />
                    刷新
                  </button>
                  <button
                    disabled={busyId === summary.binding.id}
                    onClick={() => setDialog({ mode: "rebind", binding: summary.binding })}
                    type="button"
                  >
                    <Link2 size={15} />
                    {summary.binding.status === "detached" ? "重新连接" : "重绑"}
                  </button>
                  {summary.binding.status !== "detached" && (
                    <button
                      className="repository-detach-button"
                      disabled={busyId === summary.binding.id}
                      onClick={() => setDetachingId(summary.binding.id)}
                      type="button"
                    >
                      <Unlink size={15} />
                      解除
                    </button>
                  )}
                </footer>
                {detachingId === summary.binding.id && (
                  <div className="repository-inline-confirm">
                    <CircleAlert size={17} />
                    <span>
                      <strong>解除后保留历史Snapshot</strong>
                      <small>新Context不再采用这个Repository；你仍可稍后重新连接。</small>
                    </span>
                    <button onClick={() => setDetachingId(null)} type="button">
                      取消
                    </button>
                    <button
                      className="repository-confirm-detach"
                      disabled={busyId === summary.binding.id}
                      onClick={() => void detach(summary)}
                      type="button"
                    >
                      {busyId === summary.binding.id ? (
                        <LoaderCircle size={15} />
                      ) : (
                        <CheckCircle2 size={15} />
                      )}
                      确认解除
                    </button>
                  </div>
                )}
                {expanded && <RepositoryDetails summary={summary} />}
              </article>
            );
          })}
        </div>
      )}
      {dialog && (
        <RepositoryBindingDialog
          binding={dialog.mode === "rebind" ? dialog.binding : undefined}
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onSaved={(value) => {
            replaceResult(value);
            setDialog(null);
          }}
          projectId={projectId}
          projectRowVersion={currentProjectVersion}
          roots={roots}
        />
      )}
    </section>
  );
}
