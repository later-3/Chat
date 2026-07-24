import {
  Bot,
  Boxes,
  Menu,
  MessageSquarePlus,
  Settings2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import type { WorkflowDefinition } from "../workflow/workflow-api";

interface AppTopbarProps {
  interactionBusy: boolean;
  onNewConversation: () => void;
  onOpenConfiguration: () => void;
  onOpenProjects: () => void;
  onOpenSidebar: () => void;
  onOpenWorkflow: () => void;
  workflow: WorkflowDefinition;
}

export function AppTopbar({
  interactionBusy,
  onNewConversation,
  onOpenConfiguration,
  onOpenProjects,
  onOpenSidebar,
  onOpenWorkflow,
  workflow,
}: AppTopbarProps) {
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
      <button className="topbar-workflow" onClick={onOpenWorkflow} type="button">
        <WorkflowIcon size={15} />
        <span>
          <small>本轮 Workflow</small>
          <strong>{workflow.name}</strong>
        </span>
        <span>v{workflow.version}</span>
      </button>
      <div className="topbar-actions">
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
