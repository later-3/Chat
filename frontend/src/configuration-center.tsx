import * as Dialog from "@radix-ui/react-dialog";
import { Bot, Database, Settings2, SlidersHorizontal, Workflow, Wrench, X } from "lucide-react";
import type { ReactNode } from "react";

export type ConfigurationTab = "session" | "workflow" | "agent" | "tool" | "system";

interface ConfigurationCenterProps {
  activeTab: ConfigurationTab;
  open: boolean;
  panels: Record<ConfigurationTab, ReactNode>;
  onOpenChange: (open: boolean) => void;
  onTabChange: (tab: ConfigurationTab) => void;
}

const TABS: Array<{ id: ConfigurationTab; label: string; description: string; icon: ReactNode }> = [
  { id: "session", label: "会话", description: "当前 Product Session", icon: <SlidersHorizontal size={16} /> },
  { id: "workflow", label: "Workflow", description: "目录与开发验证", icon: <Workflow size={16} /> },
  { id: "agent", label: "Agent", description: "版本化 Agent 档案", icon: <Bot size={16} /> },
  { id: "tool", label: "Tool", description: "能力目录与配置", icon: <Wrench size={16} /> },
  { id: "system", label: "系统", description: "运行时与状态边界", icon: <Database size={16} /> },
];

export function ConfigurationCenter({
  activeTab,
  open,
  panels,
  onOpenChange,
  onTabChange,
}: ConfigurationCenterProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="configuration-dialog">
          <header className="configuration-header">
            <span><Settings2 size={18} /></span>
            <div>
              <Dialog.Title>配置中心</Dialog.Title>
              <Dialog.Description>在一个入口管理会话、Workflow、Agent、Tool 与系统信息。</Dialog.Description>
            </div>
            <Dialog.Close asChild><button aria-label="关闭配置中心" type="button"><X size={18} /></button></Dialog.Close>
          </header>
          <div className="configuration-shell">
            <nav aria-label="配置分类" className="configuration-nav">
              {TABS.map((tab) => (
                <button
                  aria-current={activeTab === tab.id ? "page" : undefined}
                  className={activeTab === tab.id ? "active" : ""}
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  type="button"
                >
                  <span>{tab.icon}</span>
                  <span><strong>{tab.label}</strong><small>{tab.description}</small></span>
                </button>
              ))}
            </nav>
            <div className="configuration-panel">{panels[activeTab]}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
