import { Bot, Check, GitMerge, LoaderCircle, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  agentModelOptions,
  listAgents,
  type AgentProfile,
  updateAgent,
} from "./agent-api";
import type { ModelProviderOption } from "./use-chat-agent";

interface AgentPageProps {
  providers: ModelProviderOption[];
  blocked: boolean;
  onAgentsChanged: () => void;
}

export function AgentPage({ providers, blocked, onAgentsChanged }: AgentPageProps) {
  const requiredAgentIds = new Set(["planner", "reviewer", "idiom_agent_a", "idiom_agent_b"]);
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<AgentProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    void listAgents()
      .then((values) => {
        setAgents(values);
        const selected = values.find((value) => value.id === selectedId) ?? values[0] ?? null;
        setSelectedId(selected?.id ?? "");
        setDraft(selected ? { ...selected } : null);
      })
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : "加载Agent失败");
      })
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const modelOptions = useMemo(
    () => agentModelOptions(providers, draft?.provider_id ?? ""),
    [draft?.provider_id, providers],
  );
  const selected = agents.find((value) => value.id === selectedId) ?? null;
  const dirty = Boolean(draft && selected && JSON.stringify(draft) !== JSON.stringify(selected));

  const selectAgent = (profile: AgentProfile) => {
    if (saving) return;
    setSelectedId(profile.id);
    setDraft({ ...profile });
    setError(null);
    setSaved(false);
  };

  const save = async () => {
    if (!draft || !dirty || saving || blocked) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateAgent(draft.id, {
        expected_revision: draft.revision,
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        provider_id: draft.provider_id,
        model: draft.model,
        enabled: draft.enabled,
      });
      setAgents((values) => values.map((value) => value.id === updated.id ? updated : value));
      setDraft({ ...updated });
      setSaved(true);
      onAgentsChanged();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存Agent失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="agent-layout">
      <header className="agent-page-header">
        <div>
          <p className="eyebrow">AGENT PROFILES</p>
          <h1>Agent 配置</h1>
          <p>这里配置版本化 Agent 档案；每次 Workflow 运行会取得一个版本快照，实际模型请求仍逐次审批。</p>
        </div>
        <div className="agent-policy-pill"><ShieldCheck size={15} />配置不是执行授权</div>
      </header>

      <section className="agent-workspace">
        <aside className="agent-list" aria-label="Agent列表">
          {loading && <div className="agent-loading"><LoaderCircle className="workflow-spin" size={17} />读取中</div>}
          {!loading && agents.length === 0 && <div className="agent-loading">当前没有可配置的Agent</div>}
          {agents.map((profile) => (
            <button
              className={profile.id === selectedId ? "agent-list-item agent-list-item--active" : "agent-list-item"}
              key={profile.id}
              onClick={() => selectAgent(profile)}
              type="button"
            >
              <span><Bot size={17} /></span>
              <div><strong>{profile.name}</strong><small>{profile.id} · r{profile.revision}</small></div>
              {profile.id === selectedId && <Check size={14} />}
            </button>
          ))}
          <div className="agent-handoff-note">
            <GitMerge size={16} />
            <p><strong>显式 Agent 交接</strong><span>规划/审校双Agent；成语接龙Agent甲/乙均由确定性节点交接。</span></p>
          </div>
        </aside>

        <div className="agent-editor">
          {draft ? (
            <>
              <div className="agent-editor-heading">
                <div><span>稳定 Agent ID</span><code>{draft.id}</code></div>
                <span className="agent-revision">Agent 版本 {draft.revision}</span>
              </div>
              <div className="agent-form-grid">
                <label><span>显示名称</span><input disabled={saving || blocked} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></label>
                <label><span>状态</span><select disabled={saving || blocked || requiredAgentIds.has(draft.id)} onChange={(event) => setDraft({ ...draft, enabled: event.target.value === "enabled" })} value={draft.enabled ? "enabled" : "disabled"}><option value="enabled">启用</option><option value="disabled">停用</option></select></label>
                <label className="agent-form-wide"><span>职责说明</span><textarea disabled={saving || blocked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} rows={3} value={draft.description} /></label>
                <label><span>Provider</span><select disabled={saving || blocked} onChange={(event) => { const provider = providers.find((value) => value.id === event.target.value); setDraft({ ...draft, provider_id: event.target.value, model: provider?.models[0]?.id ?? "" }); }} value={draft.provider_id}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select></label>
                <label><span>模型</span><select disabled={saving || blocked} onChange={(event) => setDraft({ ...draft, model: event.target.value })} value={draft.model}>{modelOptions.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
                <label className="agent-form-wide"><span>Instructions</span><small>定义这个Agent如何理解任务与产出；本次调用还可以在发送前审批中临时修改。</small><textarea disabled={saving || blocked} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} rows={10} value={draft.instructions} /></label>
              </div>
              {error && <p className="agent-form-error" role="alert">{error}</p>}
              {saved && <p className="agent-form-success"><Check size={14} />已保存，新 Workflow 将使用 Agent 版本 {draft.revision}</p>}
              <div className="agent-form-actions">
                <button disabled={!dirty || saving || blocked || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()} type="button"><Save size={15} />{saving ? "保存中…" : "保存Agent配置"}</button>
              </div>
            </>
          ) : !loading ? <div className="agent-loading">请选择Agent</div> : null}
        </div>
      </section>
    </main>
  );
}
