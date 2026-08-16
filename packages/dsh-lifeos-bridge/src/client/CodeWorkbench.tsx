import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { WorkbenchSurfaceController } from "./workbench-controller.ts";

export const WORKBENCH_PUBLIC_URL = "http://localhost:43110/workbench/code/";

interface WorkbenchInjected {
  workbench: WorkbenchSurfaceController;
}

type SidebarActionProps = PropsRuntime<"sidebar.footer.action"> &
  SidebarFooterActionOwnerProps &
  WorkbenchInjected;
type SurfaceProps = PropsRuntime<"shell.overlay"> & WorkbenchInjected;

function WorkbenchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" width="18" height="18" fill="none">
      <path
        d="M3.5 4.5h13v11h-13zM3.5 7.5h13M7 7.5v8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Workbench是全局Workspace能力，不属于某个Chat Session。官方Sidebar root slot在
 * blank Hero与已物化会话中都存在；wide展示文字，56px rail只保留可访问图标。
 */
export function CodeWorkbenchSidebarAction({ wide, workbench }: SidebarActionProps) {
  return (
    <button
      type="button"
      className="lifeos-workbench-entry"
      data-wide={wide ? "true" : "false"}
      aria-label="打开 Code Workbench"
      title="打开 Code Workbench"
      data-testid="lifeos-open-workbench"
      onClick={workbench.open}
    >
      <WorkbenchIcon />
      {wide ? <span>Workbench</span> : null}
    </button>
  );
}

/**
 * iframe始终留在同一React树中；close只隐藏顶层Surface，避免终端、编辑器与
 * code-server WebSocket因返回Chat而被销毁。外部应用不使用sandbox，因为VS Code
 * 需要Worker、IndexedDB、剪贴板和完整同源WebSocket能力。
 */
export function CodeWorkbenchSurface({ workbench }: SurfaceProps) {
  const state = useSyncExternalStore(workbench.subscribe, workbench.snapshot, workbench.snapshot);
  const [activated, setActivated] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!state.open) return;
    setActivated(true);
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      workbench.close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocus.current?.focus();
    };
  }, [state.open, workbench]);

  return (
    <section
      className="lifeos-workbench-surface"
      data-open={state.open ? "true" : "false"}
      data-testid="lifeos-workbench-surface"
      aria-label="Code Workbench"
      aria-hidden={!state.open}
    >
      <header className="lifeos-workbench-toolbar">
        <button
          ref={closeButton}
          type="button"
          className="lifeos-workbench-back"
          data-testid="lifeos-close-workbench"
          onClick={workbench.close}
        >
          返回对话
        </button>
        <strong>Code Workbench</strong>
        <a
          className="lifeos-workbench-new-tab"
          href={WORKBENCH_PUBLIC_URL}
          target="_blank"
          rel="noopener"
        >
          在新标签页打开
        </a>
      </header>
      {activated ? (
        <iframe
          className="lifeos-workbench-frame"
          src={WORKBENCH_PUBLIC_URL}
          title="Code Workbench"
          allow="clipboard-read; clipboard-write"
          data-testid="lifeos-workbench-frame"
        />
      ) : (
        <div className="lifeos-workbench-frame" aria-hidden="true" />
      )}
    </section>
  );
}
