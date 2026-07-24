interface SystemInfo {
  status: string;
  runtime_mode: "bootstrap" | "model";
  model_call_approval: "every_call" | "not_applicable";
  product_sessions: "sqlite";
  protocol: string;
}

interface SystemInfoPanelProps {
  aguiThreadId: string;
  health: SystemInfo | null;
  healthError: boolean;
  runtimeLabel: string | null;
  sessionId: string | null;
}

export function SystemInfoPanel({
  aguiThreadId,
  health,
  healthError,
  runtimeLabel,
  sessionId,
}: SystemInfoPanelProps) {
  return (
    <section className="configuration-section">
      <header>
        <p className="eyebrow">SYSTEM BOUNDARIES</p>
        <h2>系统与运行时</h2>
        <p>
          Product DB 保存产品事实；AG-UI 传递 Agent Run 事件；MAF 管理 Agent 与 Workflow 运行语义。
        </p>
      </header>
      <dl className="system-grid">
        <div>
          <dt>后端</dt>
          <dd>{healthError ? "未连接" : (health?.status ?? "检查中")}</dd>
        </div>
        <div>
          <dt>Product Store</dt>
          <dd>{health?.product_sessions ?? "—"}</dd>
        </div>
        <div>
          <dt>运行模式</dt>
          <dd>{health?.runtime_mode ?? "—"}</dd>
        </div>
        <div>
          <dt>Agent Runtime</dt>
          <dd>{runtimeLabel || "—"}</dd>
        </div>
        <div>
          <dt>模型请求审批</dt>
          <dd>{health?.model_call_approval === "every_call" ? "每次调用" : "不适用"}</dd>
        </div>
        <div>
          <dt>实时协议</dt>
          <dd>{health?.protocol?.toUpperCase() ?? "AG-UI"}</dd>
        </div>
        <div>
          <dt>Product Session</dt>
          <dd className="mono">{sessionId ?? "—"}</dd>
        </div>
        <div>
          <dt>AG-UI Thread</dt>
          <dd className="mono">{aguiThreadId}</dd>
        </div>
      </dl>
    </section>
  );
}
