import {
  Bot,
  Boxes,
  CloudOff,
  Command,
  Menu,
  MessageSquarePlus,
  Search,
  Settings2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { BrowserNetworkStatus } from "../mobile/use-network-status";
import type { WorkflowDefinition } from "../workflow/workflow-api";

interface AppTopbarProps {
  backendReachable: boolean;
  homeActive: boolean;
  homeSearchQuery: string;
  interactionBusy: boolean;
  networkStatus: BrowserNetworkStatus;
  onNewConversation: () => void;
  onOpenConfiguration: () => void;
  onOpenProjects: () => void;
  onOpenSidebar: () => void;
  onOpenWorkflow: () => void;
  onHomeSearchChange: (value: string) => void;
  workflow: WorkflowDefinition;
}

export function AppTopbar({
  backendReachable,
  homeActive,
  homeSearchQuery,
  interactionBusy,
  networkStatus,
  onNewConversation,
  onOpenConfiguration,
  onOpenProjects,
  onOpenSidebar,
  onOpenWorkflow,
  onHomeSearchChange,
  workflow,
}: AppTopbarProps) {
  const connectionLabel =
    networkStatus === "offline"
      ? "设备离线"
      : backendReachable
        ? "本地Chat已连接"
        : "本地Chat不可达";

  return (
    <header className="topbar">
      <h1 className="sr-only">Chat AI 协作产品</h1>
      <div className="brand">
        <button
          aria-label="打开会话列表"
          className="mobile-menu-button"
          onClick={onOpenSidebar}
          type="button"
        >
          <Menu size={18} />
        </button>
        <span className="brand-mark">
          <Bot size={19} />
        </span>
        <div>
          <p className="brand-name">Chat</p>
          <p className="brand-subtitle">AI 协作产品</p>
        </div>
      </div>
      {homeActive ? (
        <label className="home-topbar-search">
          <Search size={18} />
          <input
            aria-label="搜索项目、事项和知识"
            id="home-global-search"
            onChange={(event) => onHomeSearchChange(event.target.value)}
            placeholder="搜索项目、事项和知识…"
            value={homeSearchQuery}
          />
          <kbd>
            <Command size={12} /> K
          </kbd>
        </label>
      ) : (
        <button className="topbar-workflow" onClick={onOpenWorkflow} type="button">
          <WorkflowIcon size={15} />
          <span>
            <small>本轮 Workflow</small>
            <strong>{workflow.name}</strong>
          </span>
          <span>v{workflow.version}</span>
        </button>
      )}
      <div className="topbar-actions">
        <span
          aria-label={connectionLabel}
          className={`network-indicator ${
            networkStatus === "offline" || !backendReachable ? "network-indicator--error" : ""
          }`}
          role="status"
          title={connectionLabel}
        >
          {networkStatus === "offline" || !backendReachable ? (
            <CloudOff size={15} />
          ) : (
            <span aria-hidden="true" />
          )}
          <small>{connectionLabel}</small>
        </span>
        <button
          className="icon-button labeled-on-wide"
          disabled={interactionBusy}
          onClick={onNewConversation}
          type="button"
        >
          <MessageSquarePlus size={17} />
          <span>新对话</span>
        </button>
        <button className="icon-button labeled-on-wide" onClick={onOpenProjects} type="button">
          <Boxes size={18} />
          <span>资源</span>
        </button>
        <button className="icon-button labeled-on-wide" onClick={onOpenConfiguration} type="button">
          <Settings2 size={18} />
          <span>配置</span>
        </button>
      </div>
    </header>
  );
}
