import { ArrowLeft, Check, ChevronRight, Folder, GitBranch, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  bindProjectRepository,
  listRepositoryDirectories,
  type RepositoryBinding,
  type RepositoryBindingRole,
  type RepositoryCommandResult,
  type RepositoryDirectory,
  type RepositoryDirectoryPage,
  rebindProjectRepository,
  type WorkspaceRootView,
} from "./repository-api";

function defaultName(relativePath: string, rootLabel: string): string {
  if (relativePath === ".") return rootLabel;
  return relativePath.split("/").at(-1) ?? rootLabel;
}

export function RepositoryBindingDialog({
  mode,
  projectId,
  projectRowVersion,
  roots,
  binding,
  onClose,
  onSaved,
}: {
  mode: "bind" | "rebind";
  projectId: string;
  projectRowVersion: number;
  roots: WorkspaceRootView[];
  binding?: RepositoryBinding;
  onClose: () => void;
  onSaved: (value: RepositoryCommandResult) => void;
}) {
  const availableRoots = useMemo(() => roots.filter((value) => value.available), [roots]);
  const initialRoot =
    availableRoots.find((value) => value.root_key === binding?.root_key) ?? availableRoots[0];
  const [rootKey, setRootKey] = useState(initialRoot?.root_key ?? "");
  const [page, setPage] = useState<RepositoryDirectoryPage | null>(null);
  const [directories, setDirectories] = useState<RepositoryDirectory[]>([]);
  const [displayName, setDisplayName] = useState(binding?.display_name ?? "");
  const [alias, setAlias] = useState(binding?.alias ?? "main");
  const [role, setRole] = useState<RepositoryBindingRole>(binding?.role ?? "primary");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (availableRoots.length === 0 || availableRoots.some((value) => value.root_key === rootKey)) {
      return;
    }
    const preferred =
      availableRoots.find((value) => value.root_key === binding?.root_key) ?? availableRoots[0];
    setRootKey(preferred.root_key);
  }, [availableRoots, binding?.root_key, rootKey]);

  const loadDirectory = useCallback(
    async (relativePath: string, cursor?: string | null, append = false) => {
      if (!rootKey) return;
      setLoading(true);
      setError(null);
      try {
        const value = await listRepositoryDirectories({
          rootKey,
          relativePath,
          cursor,
        });
        setPage(value);
        setDirectories((current) =>
          append ? [...current, ...value.directories] : value.directories,
        );
        const root = roots.find((item) => item.root_key === rootKey);
        setDisplayName((current) =>
          current.trim() ? current : defaultName(value.relative_path, root?.label ?? "Repository"),
        );
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "读取目录失败");
      } finally {
        setLoading(false);
      }
    },
    [rootKey, roots],
  );

  useEffect(() => {
    const startPath = binding && binding.root_key === rootKey ? binding.relative_path : ".";
    void loadDirectory(startPath);
  }, [binding, loadDirectory, rootKey]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length === 0) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && currentIndex <= 0) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && currentIndex === focusable.length - 1) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  const chooseRoot = (value: string) => {
    setRootKey(value);
    setPage(null);
    setDirectories([]);
    if (mode === "bind") setDisplayName("");
  };

  const navigate = (relativePath: string) => {
    if (!displayName.trim() || mode === "bind") {
      const root = roots.find((value) => value.root_key === rootKey);
      setDisplayName(defaultName(relativePath, root?.label ?? "Repository"));
    }
    void loadDirectory(relativePath);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!page || !displayName.trim() || !rootKey) return;
    setSaving(true);
    setError(null);
    try {
      const value =
        mode === "bind"
          ? await bindProjectRepository({
              projectId,
              expectedProjectRowVersion: projectRowVersion,
              alias,
              displayName,
              role,
              rootKey,
              relativePath: page.relative_path,
            })
          : await rebindProjectRepository({
              bindingId: binding?.id ?? "",
              expectedProjectRowVersion: projectRowVersion,
              expectedBindingRowVersion: binding?.row_version ?? 0,
              displayName,
              role,
              rootKey,
              relativePath: page.relative_path,
            });
      onSaved(value);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repository检查失败");
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="repository-dialog-backdrop" role="presentation">
      <section
        aria-labelledby="repository-dialog-title"
        aria-modal="true"
        className="repository-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <p className="eyebrow">PROJECT RESOURCE</p>
            <h3 id="repository-dialog-title">
              {mode === "bind" ? "连接代码仓库" : "重新连接代码仓库"}
            </h3>
            <p>这里只展示服务端允许的目录；不会把绝对路径交给浏览器。</p>
          </div>
          <button
            aria-label="关闭Repository对话框"
            onClick={onClose}
            ref={closeButtonRef}
            type="button"
          >
            <X size={18} />
          </button>
        </header>

        {availableRoots.length === 0 ? (
          <div className="repository-dialog-empty">
            <Folder size={24} />
            <strong>还没有可用的Workspace Root</strong>
            <p>请先在服务端私有配置中声明允许根，再回到这里选择仓库。</p>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="repository-dialog-fields">
              <label>
                <span>允许根</span>
                <select onChange={(event) => chooseRoot(event.target.value)} value={rootKey}>
                  {availableRoots.map((root) => (
                    <option key={root.root_key} value={root.root_key}>
                      {root.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>显示名称</span>
                <input
                  maxLength={120}
                  onChange={(event) => setDisplayName(event.target.value)}
                  value={displayName}
                />
              </label>
              <label>
                <span>仓库角色</span>
                <select
                  onChange={(event) => setRole(event.target.value as RepositoryBindingRole)}
                  value={role}
                >
                  <option value="primary">主仓库</option>
                  <option value="supporting">配套仓库</option>
                  <option value="documentation">文档仓库</option>
                </select>
              </label>
              {mode === "bind" && (
                <label>
                  <span>技术别名</span>
                  <input
                    maxLength={64}
                    onChange={(event) => setAlias(event.target.value)}
                    pattern="[a-z][a-z0-9-]{0,63}"
                    value={alias}
                  />
                </label>
              )}
            </div>

            <div className="repository-browser">
              <header>
                <button
                  disabled={!page?.parent_relative_path || loading}
                  onClick={() => page?.parent_relative_path && navigate(page.parent_relative_path)}
                  type="button"
                >
                  <ArrowLeft size={16} />
                  上一级
                </button>
                <div>
                  <small>{roots.find((value) => value.root_key === rootKey)?.label}</small>
                  <strong>{page?.relative_path ?? "正在读取…"}</strong>
                </div>
                {page?.current_has_git_marker && (
                  <span className="repository-git-marker">
                    <GitBranch size={14} />
                    Git仓库
                  </span>
                )}
              </header>
              {loading && directories.length === 0 ? (
                <p className="repository-browser-message">
                  <LoaderCircle size={17} />
                  正在读取目录…
                </p>
              ) : directories.length === 0 ? (
                <p className="repository-browser-message">当前目录没有可浏览的子目录。</p>
              ) : (
                <div className="repository-directory-list">
                  {directories.map((directory) => (
                    <button
                      key={directory.relative_path}
                      onClick={() => navigate(directory.relative_path)}
                      type="button"
                    >
                      <Folder size={17} />
                      <span>
                        <strong>{directory.name}</strong>
                        <small>{directory.has_git_marker ? "Git仓库" : "目录"}</small>
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  ))}
                </div>
              )}
              {page?.next_cursor && (
                <button
                  className="repository-load-more"
                  disabled={loading}
                  onClick={() => void loadDirectory(page.relative_path, page.next_cursor, true)}
                  type="button"
                >
                  加载更多目录
                </button>
              )}
            </div>

            {error && <p className="harness-error">{error}</p>}
            <footer>
              <button onClick={onClose} type="button">
                取消
              </button>
              <button
                className="harness-primary"
                disabled={
                  saving ||
                  loading ||
                  !page ||
                  !displayName.trim() ||
                  (mode === "bind" && !/^[a-z][a-z0-9-]{0,63}$/.test(alias))
                }
                type="submit"
              >
                {saving ? <LoaderCircle size={16} /> : <Check size={16} />}
                {saving ? "正在只读检查…" : mode === "bind" ? "检查并连接" : "检查并重新连接"}
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>,
    document.body,
  );
}
