import { Home, LayoutDashboard, MessageCircle, Settings2, Workflow } from "lucide-react";
import type { WorkbenchView } from "../../workbench-nav";
import type { PrimaryView } from "../home/activity-rail";

interface MobileNavigationProps {
  activeWorkbenchView: WorkbenchView;
  primaryView: PrimaryView;
  workbenchOpen: boolean;
  onOpenChat: () => void;
  onOpenConfiguration: () => void;
  onOpenWorkspace: () => void;
  onOpenHome: () => void;
  onOpenWorkflow: () => void;
}

export function MobileNavigation({
  activeWorkbenchView,
  primaryView,
  workbenchOpen,
  onOpenChat,
  onOpenConfiguration,
  onOpenWorkspace,
  onOpenHome,
  onOpenWorkflow,
}: MobileNavigationProps) {
  const homeActive = primaryView === "home";
  const chatActive = primaryView === "chat" && !workbenchOpen;
  const workflowActive =
    primaryView === "chat" && workbenchOpen && activeWorkbenchView === "workflow";
  const workspaceActive = primaryView === "workspace";

  return (
    <nav aria-label="手机主导航" className="mobile-primary-nav">
      <button
        aria-current={homeActive ? "page" : undefined}
        className={homeActive ? "active" : ""}
        onClick={onOpenHome}
        type="button"
      >
        <Home size={20} />
        <span>主页</span>
      </button>
      <button
        aria-current={chatActive ? "page" : undefined}
        className={chatActive ? "active" : ""}
        onClick={onOpenChat}
        type="button"
      >
        <MessageCircle size={20} />
        <span>对话</span>
      </button>
      <button
        aria-current={workflowActive ? "page" : undefined}
        className={workflowActive ? "active" : ""}
        onClick={onOpenWorkflow}
        type="button"
      >
        <Workflow size={20} />
        <span>运行</span>
      </button>
      <button
        aria-current={workspaceActive ? "page" : undefined}
        className={workspaceActive ? "active" : ""}
        onClick={onOpenWorkspace}
        type="button"
      >
        <LayoutDashboard size={20} />
        <span>工作台</span>
      </button>
      <button onClick={onOpenConfiguration} type="button">
        <Settings2 size={20} />
        <span>配置</span>
      </button>
    </nav>
  );
}
