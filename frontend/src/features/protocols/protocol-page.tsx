import {
  Check,
  ChevronDown,
  CircleAlert,
  LockKeyhole,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  type CollaborationProtocolBinding,
  loadProtocolConfiguration,
  type ProtocolConfiguration,
  saveProtocolBinding,
} from "./protocol-api";

const SCENARIO_LABELS: Record<string, { name: string; description: string }> = {
  simple_question: {
    name: "简单询问",
    description: "少量上下文、无副作用，权威查询优先不用模型。",
  },
  software_delivery: { name: "软件开发", description: "从现状和方案推进到实现、验证与回写。" },
  project: { name: "一般项目", description: "围绕目标、里程碑、当前工作和复盘持续推进。" },
  task: { name: "独立任务", description: "明确结果、步骤、验证标准和停止条件。" },
  learning: { name: "学习", description: "诊断、学习、练习、验证和复习形成闭环。" },
  research: { name: "研究", description: "保留来源，提取内容并交叉验证结论。" },
  recurring: { name: "周期工作", description: "按计划检索、去重、验证并追踪交付。" },
};

const ENFORCEMENT_LABELS: Record<string, string> = {
  deterministic: "脚本或规则检查",
  reviewer: "Reviewer 检查",
  human: "需要人工判断",
};

function bindingFor(
  configuration: ProtocolConfiguration,
  scenario: string,
  scopeKind: "user" | "system",
): CollaborationProtocolBinding | null {
  return (
    configuration.bindings.find(
      (value) =>
        value.scenario_kind === scenario &&
        value.scope_kind === scopeKind &&
        value.scope_ref_id === (scopeKind === "user" ? configuration.principal_id : "*"),
    ) ?? null
  );
}

export function ProtocolPage() {
  const [configuration, setConfiguration] = useState<ProtocolConfiguration | null>(null);
  const [scenario, setScenario] = useState("simple_question");
  const [protocolId, setProtocolId] = useState("");
  const [disabledRules, setDisabledRules] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await loadProtocolConfiguration();
      setConfiguration(value);
      setScenario((current) =>
        value.scenario_kinds.includes(current) ? current : (value.scenario_kinds[0] ?? ""),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取协作方法失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const userBinding = configuration ? bindingFor(configuration, scenario, "user") : null;
  const systemBinding = configuration ? bindingFor(configuration, scenario, "system") : null;
  const effectiveBinding =
    userBinding?.status === "active"
      ? userBinding
      : systemBinding?.status === "active"
        ? systemBinding
        : null;
  const compatibleProtocols = useMemo(
    () =>
      configuration?.protocols.filter(
        (value) => value.status === "active" && value.scenario_kinds.includes(scenario),
      ) ?? [],
    [configuration, scenario],
  );

  useEffect(() => {
    const selected =
      compatibleProtocols.find((value) => value.id === effectiveBinding?.protocol_definition_id) ??
      compatibleProtocols[0];
    setProtocolId(selected?.id ?? "");
    setDisabledRules(
      new Set(userBinding?.status === "active" ? userBinding.disabled_rule_keys : []),
    );
    setNotice(null);
  }, [compatibleProtocols, effectiveBinding?.protocol_definition_id, userBinding]);

  const selectedProtocol =
    compatibleProtocols.find((value) => value.id === protocolId) ?? compatibleProtocols[0] ?? null;

  const toggleRule = (ruleKey: string) => {
    setDisabledRules((current) => {
      const next = new Set(current);
      if (next.has(ruleKey)) next.delete(ruleKey);
      else next.add(ruleKey);
      return next;
    });
  };

  const save = async (status: "active" | "disabled") => {
    if (!configuration || !selectedProtocol) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await saveProtocolBinding({
        scope_kind: "user",
        scope_ref_id: configuration.principal_id,
        scenario_kind: scenario,
        protocol_definition_id:
          status === "disabled" && userBinding
            ? userBinding.protocol_definition_id
            : selectedProtocol.id,
        disabled_rule_keys: status === "active" ? [...disabledRules] : [],
        status,
        expected_row_version: userBinding?.row_version ?? 0,
      });
      await load();
      setNotice(status === "active" ? "我的默认方法已保存。" : "已恢复系统默认方法。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存协作方法失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="configuration-section protocol-page">
      <header>
        <p className="eyebrow">CHAT HARNESS METHODS</p>
        <h2>协作方法</h2>
        <p>
          这里管理不同事情默认怎样理解、推进、验证和回写。它们是版本化规则，不是藏在 Prompt
          里的提示词。
        </p>
      </header>

      {loading && !configuration && (
        <div className="protocol-loading">
          <RefreshCw className="workflow-spin" size={18} />
          正在读取协作方法…
        </div>
      )}
      {error && (
        <div className="protocol-error" role="alert">
          <CircleAlert size={18} />
          <span>{error}</span>
          <button onClick={() => void load()} type="button">
            重试
          </button>
        </div>
      )}

      {configuration && (
        <div className="protocol-workspace">
          <nav aria-label="事情类型" className="protocol-scenarios">
            {configuration.scenario_kinds.map((value) => (
              <button
                aria-current={scenario === value ? "page" : undefined}
                className={scenario === value ? "active" : ""}
                key={value}
                onClick={() => setScenario(value)}
                type="button"
              >
                <span>{SCENARIO_LABELS[value]?.name ?? value}</span>
                <small>{SCENARIO_LABELS[value]?.description ?? "使用已批准的协作方法。"}</small>
              </button>
            ))}
          </nav>

          <main className="protocol-editor">
            <section className="protocol-current-card">
              <div className="protocol-current-icon">
                <Sparkles size={21} />
              </div>
              <div>
                <span>{SCENARIO_LABELS[scenario]?.name ?? scenario}</span>
                <strong>{selectedProtocol?.name ?? "没有可用方法"}</strong>
                <p>{selectedProtocol?.description}</p>
              </div>
              <span className="protocol-source-badge">
                {userBinding?.status === "active" ? "我的默认" : "系统默认"}
              </span>
            </section>

            <label className="protocol-selector">
              <span>
                <strong>默认采用的方法</strong>
                <small>只显示适用于当前事情类型的已发布版本。</small>
              </span>
              <select
                disabled={saving || compatibleProtocols.length === 0}
                onChange={(event) => {
                  setProtocolId(event.target.value);
                  setDisabledRules(new Set());
                }}
                value={selectedProtocol?.id ?? ""}
              >
                {compatibleProtocols.map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.name} · r{value.revision}
                  </option>
                ))}
              </select>
            </label>

            {selectedProtocol && (
              <>
                <section className="protocol-phase-section">
                  <header>
                    <span>推进阶段</span>
                    <small>{selectedProtocol.phases.length} 个</small>
                  </header>
                  <ol>
                    {selectedProtocol.phases.map((phase, index) => (
                      <li key={phase.key ?? phase.name ?? String(index)}>
                        <span>{index + 1}</span>
                        <div>
                          <strong>{phase.name ?? phase.key ?? `阶段 ${index + 1}`}</strong>
                          {phase.description && <small>{phase.description}</small>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>

                <details className="protocol-rules" open>
                  <summary>
                    <span>
                      <strong>本方法的规则</strong>
                      <small>必要规则会锁定；可调整规则只影响这个事情类型。</small>
                    </span>
                    <ChevronDown size={17} />
                  </summary>
                  <div>
                    {selectedProtocol.rules.map((rule) => {
                      const enabled = !disabledRules.has(rule.rule_key);
                      return (
                        <article className={enabled ? "" : "protocol-rule--disabled"} key={rule.id}>
                          <label>
                            <input
                              checked={enabled}
                              disabled={!rule.overridable || saving}
                              onChange={() => toggleRule(rule.rule_key)}
                              type="checkbox"
                            />
                            <span>
                              <strong>{rule.name}</strong>
                              <small>{rule.description}</small>
                            </span>
                          </label>
                          <footer>
                            <span>{ENFORCEMENT_LABELS[rule.enforcement] ?? rule.enforcement}</span>
                            <span>{rule.failure_action}</span>
                            {!rule.overridable && (
                              <span>
                                <LockKeyhole size={12} />
                                必须遵守
                              </span>
                            )}
                          </footer>
                        </article>
                      );
                    })}
                  </div>
                </details>

                <details className="protocol-technical-details">
                  <summary>
                    查看版本与完整策略边界
                    <ChevronDown size={16} />
                  </summary>
                  <dl>
                    <div>
                      <dt>Protocol</dt>
                      <dd>
                        {selectedProtocol.protocol_key}@{selectedProtocol.revision}
                      </dd>
                    </div>
                    <div>
                      <dt>Definition Hash</dt>
                      <dd>{selectedProtocol.definition_hash}</dd>
                    </div>
                    <div>
                      <dt>Context</dt>
                      <dd>{JSON.stringify(selectedProtocol.context_policy)}</dd>
                    </div>
                    <div>
                      <dt>验证</dt>
                      <dd>{JSON.stringify(selectedProtocol.validation_policy)}</dd>
                    </div>
                    <div>
                      <dt>回写</dt>
                      <dd>{JSON.stringify(selectedProtocol.writeback_policy)}</dd>
                    </div>
                  </dl>
                </details>
              </>
            )}

            {notice && (
              <p className="protocol-notice">
                <Check size={15} />
                {notice}
              </p>
            )}
            <footer className="protocol-actions">
              <button
                disabled={saving || userBinding?.status !== "active"}
                onClick={() => void save("disabled")}
                type="button"
              >
                <RotateCcw size={15} />
                使用系统默认
              </button>
              <button
                className="protocol-save"
                disabled={saving || !selectedProtocol}
                onClick={() => void save("active")}
                type="button"
              >
                <Save size={15} />
                {saving ? "正在保存…" : "保存我的默认"}
              </button>
            </footer>
          </main>
        </div>
      )}
    </section>
  );
}
