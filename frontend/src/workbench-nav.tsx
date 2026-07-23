import { BookOpenText, Boxes, ClipboardList, Route, ScanSearch } from "lucide-react";

export type WorkbenchView = "workflow" | "projects" | "work" | "knowledge" | "context";

const ITEMS: Array<{
  id: WorkbenchView;
  label: string;
  shortLabel: string;
  icon: typeof Route;
}> = [
  { id: "workflow", label: "Workflow Run", shortLabel: "运行", icon: Route },
  { id: "projects", label: "Project Explorer", shortLabel: "项目", icon: Boxes },
  { id: "work", label: "Work Board", shortLabel: "工作", icon: ClipboardList },
  { id: "knowledge", label: "Knowledge", shortLabel: "知识", icon: BookOpenText },
  { id: "context", label: "Context Inspector", shortLabel: "上下文", icon: ScanSearch },
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
            {count > 0 && <b aria-label={`${count}个待处理决定`}>{count}</b>}
          </button>
        );
      })}
    </nav>
  );
}
