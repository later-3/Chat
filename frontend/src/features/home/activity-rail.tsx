import { Home, LayoutDashboard, MessageCircle, ShieldCheck, Sprout, Workflow } from "lucide-react";
import "./activity-rail.css";

export type PrimaryView = "home" | "workspace" | "chat";

interface ActivityRailProps {
  activeView: PrimaryView;
  pendingDecisionCount: number;
  onOpenApprovals: () => void;
  onOpenChat: () => void;
  onOpenGarden: () => void;
  onOpenHome: () => void;
  onOpenWorkspace: () => void;
  onOpenWorkflow: () => void;
}

export function ActivityRail({
  activeView,
  pendingDecisionCount,
  onOpenApprovals,
  onOpenChat,
  onOpenGarden,
  onOpenHome,
  onOpenWorkspace,
  onOpenWorkflow,
}: ActivityRailProps) {
  return (
    <nav aria-label="主导航" className="activity-rail">
      <div className="activity-rail__main">
        <button
          aria-current={activeView === "home" ? "page" : undefined}
          className={
            activeView === "home" ? "activity-rail__button is-active" : "activity-rail__button"
          }
          onClick={onOpenHome}
          type="button"
        >
          <Home size={20} />
          <span>主页</span>
        </button>
        <button
          aria-current={activeView === "workspace" ? "page" : undefined}
          className={
            activeView === "workspace" ? "activity-rail__button is-active" : "activity-rail__button"
          }
          onClick={onOpenWorkspace}
          type="button"
        >
          <LayoutDashboard size={20} />
          <span>工作台</span>
        </button>
        <button
          aria-current={activeView === "chat" ? "page" : undefined}
          className={
            activeView === "chat" ? "activity-rail__button is-active" : "activity-rail__button"
          }
          onClick={onOpenChat}
          type="button"
        >
          <MessageCircle size={20} />
          <span>对话</span>
        </button>
        <button className="activity-rail__button" onClick={onOpenWorkflow} type="button">
          <Workflow size={20} />
          <span>运行</span>
        </button>
        <button className="activity-rail__button" onClick={onOpenApprovals} type="button">
          <ShieldCheck size={20} />
          <span>审批</span>
          {pendingDecisionCount > 0 ? <em>{pendingDecisionCount}</em> : null}
        </button>
      </div>
      <button
        className="activity-rail__button activity-rail__button--quiet"
        onClick={onOpenGarden}
        type="button"
      >
        <Sprout size={20} />
        <span>花园</span>
      </button>
    </nav>
  );
}
