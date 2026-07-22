import {
  Activity,
  Check,
  Clock3,
  Cpu,
  RefreshCw,
  Save,
  ShieldCheck,
  TerminalSquare,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  listPiExecutions,
  listTools,
  type PiToolConfiguration,
  type ToolExecutionSummary,
  updatePiTool,
} from "./tool-api";
import type { ModelProviderOption } from "./use-chat-agent";

interface ToolPageProps {
  blocked: boolean;
  providers: ModelProviderOption[];
  onChanged: () => void;
}

function duration(value: number): string {
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

const EXECUTION_STATUS_LABELS: Record<string, string> = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  abandoned: "已放弃",
  interrupted: "已中断",
};

function ExecutionRow({ value }: { value: ToolExecutionSummary }) {
  return (
    <article className="tool-execution-row">
      <span className={`tool-execution-status tool-execution-status--${value.status}`}><Activity size={14} /></span>
      <div>
        <strong>{EXECUTION_STATUS_LABELS[value.status] ?? value.status}</strong>
        <small>{new Date(value.started_at).toLocaleString()} · config r{value.config_revision}</small>
      </div>
      <dl>
        <div><dt>模型调用</dt><dd>{value.model_call_count}</dd></div>
        <div><dt>内部 Tool 调用</dt><dd>{value.internal_tool_call_count}</dd></div>
        <div><dt>Token 总量</dt><dd>{value.tokens.input + value.tokens.output}</dd></div>
        <div><dt>耗时</dt><dd>{duration(value.duration_ms)}</dd></div>
      </dl>
    </article>
  );
}

export function ToolPage({ blocked, providers, onChanged }: ToolPageProps) {
  const [config, setConfig] = useState<PiToolConfiguration | null>(null);
  const [executions, setExecutions] = useState<ToolExecutionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tools, history] = await Promise.all([listTools(), listPiExecutions()]);
      setConfig(tools.find((value) => value.id === "pi_agent") ?? null);
      setExecutions(history);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "加载Tool中心失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const provider = useMemo(
    () => providers.find((value) => value.id === config?.provider_id) ?? null,
    [config?.provider_id, providers],
  );

  const save = async () => {
    if (!config || blocked) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const updated = await updatePiTool({
        expected_revision: config.revision,
        enabled: config.enabled,
        provider_id: config.provider_id,
        model: config.model,
        working_directory: config.working_directory,
        allowed_tools: config.allowed_tools,
        thinking_level: config.thinking_level,
        max_model_calls: config.max_model_calls,
        timeout_seconds: config.timeout_seconds,
        system_prompt: config.system_prompt,
      });
      setConfig(updated);
      setSaved(true);
      onChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存Tool配置失败");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <main className="tool-page"><div className="workflow-empty">正在加载Tool目录…</div></main>;
  if (!config) return <main className="tool-page"><div className="workflow-empty">当前没有已注册的Tool。</div></main>;

  return (
    <main className="tool-page">
      <header className="tool-page-header">
        <div className="tool-page-title">
          <span><Wrench size={21} /></span>
          <div><p className="eyebrow">SERVER TOOL CATALOG · r{config.revision}</p><h1>{config.name}</h1><p>{config.description}</p></div>
        </div>
        <div className="tool-page-header-actions">
          <span className={config.runtime.available ? "tool-runtime-ok" : "tool-runtime-off"}>
            <ShieldCheck size={14} />{config.runtime.available ? "RPC运行时可用" : "RPC运行时不可用"}
          </span>
          <button disabled={saving} onClick={() => void load()} type="button"><RefreshCw size={15} />刷新</button>
        </div>
      </header>

      <section className="tool-page-grid">
        <div className="tool-config-card">
          <div className="tool-card-heading"><div><Cpu size={17} /><span>运行配置</span></div><small>修改后对新Workflow快照生效</small></div>
          <label className="tool-enabled-row"><span><strong>启用pi Agent Tool</strong><small>禁用后不能发起新pi运行</small></span><input checked={config.enabled} disabled={blocked || saving} onChange={(event) => setConfig({ ...config, enabled: event.target.checked })} type="checkbox" /></label>
          <div className="settings-grid">
            <label className="settings-field"><span>Provider</span><select disabled={blocked || saving} onChange={(event) => { const next = providers.find((value) => value.id === event.target.value); setConfig({ ...config, provider_id: event.target.value, model: next?.models[0]?.id ?? "" }); }} value={config.provider_id}>{providers.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
            <label className="settings-field"><span>模型</span><select disabled={blocked || saving || !provider} onChange={(event) => setConfig({ ...config, model: event.target.value })} value={config.model}>{provider?.models.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label>
            <label className="settings-field"><span>推理强度</span><select disabled={blocked || saving} onChange={(event) => setConfig({ ...config, thinking_level: event.target.value })} value={config.thinking_level}>{config.thinking_levels.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="settings-field"><span>最多模型调用次数</span><input disabled={blocked || saving} max={100} min={1} onChange={(event) => setConfig({ ...config, max_model_calls: Number(event.target.value) })} type="number" value={config.max_model_calls} /></label>
            <label className="settings-field"><span>总超时（秒）</span><input disabled={blocked || saving} max={3600} min={30} onChange={(event) => setConfig({ ...config, timeout_seconds: Number(event.target.value) })} type="number" value={config.timeout_seconds} /></label>
          </div>
          <label className="settings-field tool-full-field"><span>工作目录</span><input disabled={blocked || saving} onChange={(event) => setConfig({ ...config, working_directory: event.target.value })} value={config.working_directory} /><small>必须位于后端允许的根目录内：{config.runtime.allowed_working_roots.join("、")}</small></label>
          <label className="settings-field tool-full-field"><span>System Prompt（系统指令）</span><textarea disabled={blocked || saving} onChange={(event) => setConfig({ ...config, system_prompt: event.target.value })} rows={5} value={config.system_prompt} /></label>

          <div className="tool-selection">
            <div><strong>pi内部Tool</strong><span>这里只能选择真实存在的pi Tool；运行时每次仍单独审批参数</span></div>
            <div>{config.available_tools.map((tool) => <label className={config.allowed_tools.includes(tool) ? "tool-chip tool-chip--active" : "tool-chip"} key={tool}><input checked={config.allowed_tools.includes(tool)} disabled={blocked || saving} onChange={(event) => setConfig({ ...config, allowed_tools: event.target.checked ? [...config.allowed_tools, tool] : config.allowed_tools.filter((value) => value !== tool) })} type="checkbox" /><Check size={13} />{tool}</label>)}</div>
          </div>
          {error && <p className="workflow-error" role="alert">{error}</p>}
          <div className="tool-save-row"><span>{saved ? "已保存新Revision" : "配置不等于执行授权"}</span><button disabled={blocked || saving || config.allowed_tools.length === 0} onClick={() => void save()} type="button"><Save size={15} />{saving ? "保存中…" : "保存Tool配置"}</button></div>
        </div>

        <aside className="tool-observability-card">
          <div className="tool-card-heading"><div><Activity size={17} /><span>执行与监控</span></div><small>{executions.length} 条最近记录</small></div>
          <div className="tool-runtime-facts">
            <div><TerminalSquare size={16} /><span><small>集成方式</small><strong>JSONL RPC 子进程</strong></span></div>
            <div><ShieldCheck size={16} /><span><small>Provider Gate</small><strong>每次模型调用</strong></span></div>
            <div><Wrench size={16} /><span><small>Tool Gate</small><strong>每次内部Tool</strong></span></div>
            <div><Clock3 size={16} /><span><small>超时上限</small><strong>{config.timeout_seconds}秒</strong></span></div>
          </div>
          <div className="tool-execution-list">
            {executions.length ? executions.map((value) => <ExecutionRow key={value.id} value={value} />) : <div className="tool-no-executions">还没有 pi 运行记录。在配置中心的 Workflow 开发验证中运行 pi Agent 后，模型调用、内部 Tool 调用、Token 和耗时会出现在这里。</div>}
          </div>
        </aside>
      </section>
    </main>
  );
}
