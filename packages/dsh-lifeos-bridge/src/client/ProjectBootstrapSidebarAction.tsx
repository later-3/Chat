import { useState } from "react";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";

export interface ProjectBootstrapSidebarInjected {
  startProjectBootstrap: () => Promise<void>;
}

type ProjectBootstrapSidebarActionProps = PropsRuntime<"sidebar.footer.action"> &
  SidebarFooterActionOwnerProps &
  ProjectBootstrapSidebarInjected;

function ProjectIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path
        d="M4 5.5h12v10H4zM7 3.5h6v4H7zM7 10h6M10 7v6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ProjectBootstrapSidebarAction({
  wide,
  startProjectBootstrap,
}: ProjectBootstrapSidebarActionProps) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (): Promise<void> => {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      await startProjectBootstrap();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建项目会话失败");
    } finally {
      setStarting(false);
    }
  };
  return (
    <button
      type="button"
      className="lifeos-workbench-entry"
      data-wide={wide ? "true" : "false"}
      aria-label={error ?? "创建项目"}
      title={error ?? "创建项目"}
      data-testid="lifeos-create-project"
      disabled={starting}
      onClick={() => void start()}
    >
      <ProjectIcon />
      {wide ? <span>{starting ? "准备中…" : error === null ? "创建项目" : "重试创建"}</span> : null}
    </button>
  );
}
