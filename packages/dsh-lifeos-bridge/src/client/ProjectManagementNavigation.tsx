import { useEffect, useRef } from "react";
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type { SidebarFooterActionOwnerProps } from "@deepseek-ai/dsh-client-ui-sidebar/client";
import {
  ProjectManagementContent,
  type ProjectManagementInjected,
} from "./ProjectManagementView.tsx";
import type { ProjectManagementState } from "./project-management-controller.ts";
import type { HostObservable } from "@deepseek-ai/dsh-client-ui-slots";

export interface ProjectManagementNavigationInjected {
  hooks: { projectManagement: HostObservable<ProjectManagementState> };
  openProjectManagement: () => void;
}

export type ProjectManagementSidebarActionProps = SidebarFooterActionOwnerProps &
  InjectFace<ProjectManagementNavigationInjected>;

export function ProjectManagementSidebarAction({
  wide,
  useProjectManagement,
  openProjectManagement,
}: ProjectManagementSidebarActionProps) {
  const state = useProjectManagement((value) => value);
  return (
    <button
      type="button"
      className="lifeos-project-sidebar-action"
      aria-label="打开项目管理"
      title="项目"
      data-testid="lifeos-projects-open"
      data-active={state.open}
      data-wide={wide ? "true" : "false"}
      onClick={openProjectManagement}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" fill="none" aria-hidden="true">
        <path d="M2.5 3.5h4l1 1h6v8h-11z" stroke="currentColor" strokeWidth="1.3" />
        <path d="M5 7h6M5 9.5h4" stroke="currentColor" strokeWidth="1.15" />
      </svg>
      {wide ? <span>项目</span> : null}
    </button>
  );
}

export type ProjectManagementSurfaceProps = PropsRuntime<"shell.overlay"> &
  InjectFace<ProjectManagementInjected & { closeProjectManagement: () => void }>;

export function ProjectManagementSurface(props: ProjectManagementSurfaceProps) {
  const state = props.useProjectManagement((value) => value);
  const { closeProjectManagement } = props;
  const returnFocus = useRef<HTMLElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!state.open) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closeProjectManagement();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      returnFocus.current?.focus();
    };
  }, [closeProjectManagement, state.open]);

  return (
    <section
      className="lifeos-project-surface"
      data-open={state.open}
      aria-hidden={!state.open}
      data-testid="lifeos-projects-surface"
      aria-label="项目管理"
    >
      <header className="lifeos-project-surface-toolbar">
        <button ref={closeButton} type="button" onClick={closeProjectManagement}>
          返回对话
        </button>
        <strong>项目管理</strong>
        <span>Chat Product Store</span>
      </header>
      <ProjectManagementContent {...props} />
    </section>
  );
}
