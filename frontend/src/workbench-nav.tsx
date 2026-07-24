import { BookOpenText, Boxes, ClipboardList, Route, ScanSearch } from "lucide-react";

export type WorkbenchView = "workflow" | "projects" | "work" | "knowledge" | "context";

const ITEMS: Array<{
  id: WorkbenchView;
  label: string;
  shortLabel: string;
  icon: typeof Route;
}> = [
  { id: "workflow", label: "查看本轮运行", shortLabel: "运行", icon: Route },
  { id: "projects", label: "查看我的项目", shortLabel: "项目", icon: Boxes },
  { id: "work", label: "查看正在推进的事项", shortLabel: "事项", icon: ClipboardList },
  { id: "knowledge", label: "查看笔记与记忆", shortLabel: "知识", icon: BookOpenText },
  { id: "context", label: "查看本轮采用的信息与规则", shortLabel: "本轮", icon: ScanSearch },
];

export function WorkbenchNav({
  active,
  onChange,
  pendingCount = 0,
}: {
  active: WorkbenchView;
  onChange: (view: WorkbenchView) => void;
  pendingCount?: number;
}) {
  return (
    <nav className="workbench-nav" aria-label="工作台视图">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const count = item.id === "context" ? pendingCount : 0;
        return (
          <button
            aria-current={active === item.id ? "page" : undefined}
            className={active === item.id ? "workbench-nav-item--active" : ""}
            key={item.id}
            onClick={() => onChange(item.id)}
            title={item.label}
            type="button"
          >
            <Icon size={16} />
            <span>{item.shortLabel}</span>
            {count > 0 && <b title={`${count}个待处理决定`}>{count}</b>}
          </button>
        );
      })}
    </nav>
  );
}
