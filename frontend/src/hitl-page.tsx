import {
  Check,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  LockKeyhole,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  activateHitlPolicy,
  type DecisionPointDefinition,
  type HitlMode,
  type HitlPolicyRule,
  type HitlPolicySet,
  type HitlPreview,
  loadHitlConfiguration,
  loadWorkflowHitlDecisionPoints,
  previewHitlPolicy,
} from "./hitl-api";
import { type WorkflowDefinition, listWorkflows } from "./features/workflow/workflow-api.js";

const MODE_LABELS: Record<HitlMode, string> = {
  inherit: "沿用更上层",
  deny: "始终阻止",
  require_human: "每次询问我",
  conditional: "满足条件时询问",
  auto_continue: "在这个范围内自动继续",
};

const ACTION_LABELS: Record<string, string> = {
  deny: "阻止",
  require_human: "询问我",
  auto_continue: "自动继续",
};

const CONDITION_SUMMARIES: Record<string, string> = {
  intent_binding: "置信度不足、意图有歧义或会改变活动工作时询问",
  project_work_binding: "多Project候选或跨敏感范围时询问",
  context_adoption: "跨Project、来源失效或被标记需要审核时询问",
  plan_acceptance: "风险升高、能力扩张或边界不清时询问",
  execution_authorization: "有副作用、风险升高或目标不完整时询问",
  model_call_authorization: "完整请求每次发送前询问",
  tool_execution_authorization: "有副作用、风险升高或超出能力范围时询问",
  work_state_commit: "创建/删除工作或缺证据却声称完成时询问",
  memory_commit: "长期Memory候选每次询问",
  result_commit: "证据不足、外部交付或长期状态变化时询问",
  runtime_recovery: "恢复、重试和干预每次询问",
  unknown_or_high_risk: "结果未知或高风险时强制询问",
};

function nominalFacts(key: string): Record<string, unknown> {
  const values: Record<string, Record<string, unknown>> = {
    intent_binding: { intent: { confidence: 0.95, changes_active_work: false, ambiguous: false } },
    project_work_binding: { project: { candidate_count: 1, cross_sensitive_scope: false } },
    context_adoption: {
      context: { requires_review: false, cross_project: false, source_invalid: false },
    },
    plan_acceptance: {
      plan: { risk_level: 0, expands_capability: false, boundary_unclear: false },
    },
    execution_authorization: {
      execution: { risk_level: 0, has_side_effects: false, goal_incomplete: false },
    },
    model_call_authorization: { model: { call_ordinal: 1 }, context: { changed: false } },
    tool_execution_authorization: {
      tool: { risk_level: 0, has_side_effects: false, outside_capability: false },
    },
    work_state_commit: {
      work: { creates_or_deletes: false, claims_completion_without_evidence: false },
    },
    memory_commit: { memory: { candidate_count: 1 } },
    result_commit: {
      result: {
        evidence_sufficient: true,
        external_delivery: false,
        changes_long_term_state: false,
      },
    },
    runtime_recovery: { runtime: { safe_to_retry: false } },
    unknown_or_high_risk: { risk: { outcome_unknown: true } },
  };
  return values[key] ?? {};
}

interface ScopeOption {
  kind: string;
  refId: string;
  label: string;
  description: string;
  readOnly?: boolean;
}

interface HitlPageProps {
  sessionId: string | null;
  workflowId: string;
}

function ruleFor(policy: HitlPolicySet | undefined, key: string): HitlPolicyRule | undefined {
  return policy?.active_revision?.rules.find((value) => value.decision_point_key === key);
}

export function HitlPage({ sessionId, workflowId }: HitlPageProps) {
  const [decisionPoints, setDecisionPoints] = useState<DecisionPointDefinition[]>([]);
  const [policySets, setPolicySets] = useState<HitlPolicySet[]>([]);
  const [scopeIndex, setScopeIndex] = useState(0);
  const [modes, setModes] = useState<Record<string, HitlMode>>({});
  const [previews, setPreviews] = useState<Record<string, HitlPreview>>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowDefinition[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(workflowId);

  const scopes = useMemo<ScopeOption[]>(
    () => [
      {
        kind: "principal",
        refId: "local-user",
        label: "我的默认",
        description: "跨会话的个人偏好",
      },
      { kind: "channel", refId: "web", label: "Web 入口", description: "只影响当前Web入口" },
      ...(sessionId
        ? [
            {
              kind: "product_session",
              refId: sessionId,
              label: "当前会话",
              description: "只影响当前Product Session",
            },
          ]
        : []),
      {
        kind: "workflow_version",
        refId: selectedWorkflowId,
        label: "Workflow",
        description: "只影响当前Workflow版本",
      },
      {
        kind: "product_default",
        refId: "*",
        label: "产品与系统规则",
        description: "只读的默认和安全下限",
        readOnly: true,
      },
    ],
    [sessionId, selectedWorkflowId],
  );
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)];
  const userPolicy = policySets.find(
    (value) =>
      value.authority === "user_preference" &&
      value.scope_kind === scope.kind &&
      value.scope_ref_id === scope.refId,
  );
  const productPolicy = policySets.find((value) => value.authority === "product_default");
  const safetyPolicy = policySets.find((value) => value.authority === "system_safety");

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [config, workflowPoints, workflowList] = await Promise.all([
        loadHitlConfiguration(),
        loadWorkflowHitlDecisionPoints(selectedWorkflowId),
        listWorkflows(),
      ]);
      setPolicySets(config.policySets);
      setDecisionPoints(workflowPoints);
      setWorkflows(workflowList);
      setSelectedKey((current) => current ?? workflowPoints[0]?.key ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "读取人工介入配置失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, [selectedWorkflowId]);

  useEffect(() => {
    const next: Record<string, HitlMode> = {};
    for (const point of decisionPoints) {
      const configured = ruleFor(userPolicy, point.key);
      next[point.key] = scope.readOnly
        ? (ruleFor(productPolicy, point.key)?.mode ?? point.default_mode)
        : (configured?.mode ?? "inherit");
    }
    setModes(next);
  }, [decisionPoints, productPolicy, scope.kind, scope.readOnly, scope.refId, userPolicy]);

  useEffect(() => {
    if (decisionPoints.length === 0) return;
    let cancelled = false;
    const scopeChain = [
      { kind: "product_default", ref_id: "*" },
      { kind: "principal", ref_id: "local-user" },
      ...(scope.kind === "principal" || scope.kind === "product_default"
        ? []
        : [{ kind: scope.kind, ref_id: scope.refId }]),
    ];
    void Promise.all(
      decisionPoints.map(
        async (point) =>
          [
            point.key,
            await previewHitlPolicy({
              decision_point_key: point.key,
              scopes: scopeChain,
              facts: nominalFacts(point.key),
            }),
          ] as const,
      ),
    )
      .then((values) => {
        if (!cancelled) setPreviews(Object.fromEntries(values));
      })
      .catch((previewError: unknown) => {
        if (!cancelled)
          setError(previewError instanceof Error ? previewError.message : "有效策略预览失败");
      });
    return () => {
      cancelled = true;
    };
  }, [decisionPoints, policySets, scope.kind, scope.refId]);

  const save = async () => {
    if (scope.readOnly) return;
    setSaving(true);
    setError(null);
    try {
      const rules = decisionPoints.map<HitlPolicyRule>((point) => {
        const mode = modes[point.key] ?? "inherit";
        const inherited = ruleFor(productPolicy, point.key);
        return {
          decision_point_key: point.key,
          mode,
          condition: mode === "conditional" ? (inherited?.condition ?? null) : null,
          on_match: mode === "conditional" ? (inherited?.on_match ?? "require_human") : null,
          constraints: {},
          reason: `用户在${scope.label}配置`,
        };
      });
      await activateHitlPolicy({
        scope_kind: scope.kind,
        scope_ref_id: scope.refId,
        expected_active_revision_id: userPolicy?.active_revision?.id ?? null,
        change_summary: `更新${scope.label}的12项人工介入策略`,
        rules,
      });
      await reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "激活策略失败");
    } finally {
      setSaving(false);
    }
  };

  const selected = decisionPoints.find((value) => value.key === selectedKey) ?? null;
  const selectedPreview = selected ? previews[selected.key] : null;

  if (loading && decisionPoints.length === 0) {
    return (
      <div className="hitl-loading">
        <LoaderCircle className="workflow-spin" size={18} />
        正在读取人工介入策略…
      </div>
    );
  }

  return (
    <section className="hitl-page">
      <header className="hitl-header">
        <div>
          <p className="eyebrow">HUMAN IN THE LOOP</p>
          <h2>人工介入</h2>
          <p>每个决策点都保留；你可以决定何时暂停，自动继续也会留下Evaluation与Decision Record。</p>
        </div>
        <button disabled={saving || scope.readOnly} onClick={() => void save()} type="button">
          <Save size={15} />
          {saving ? "激活中…" : "保存并激活"}
        </button>
      </header>

      <div className="hitl-scope-tabs" role="tablist" aria-label="人工介入策略作用域">
        {scopes.map((value, index) => (
          <button
            aria-selected={index === scopeIndex}
            className={index === scopeIndex ? "active" : ""}
            key={`${value.kind}:${value.refId}`}
            onClick={() => setScopeIndex(index)}
            role="tab"
            type="button"
          >
            <strong>
              {value.label}
              {value.readOnly && <LockKeyhole size={12} />}
            </strong>
            <small>{value.description}</small>
          </button>
        ))}
        {scope.kind === "workflow_version" && (
          <select
            className="hitl-workflow-select"
            onChange={(event) => setSelectedWorkflowId(event.target.value)}
            value={selectedWorkflowId}
          >
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name} · v{workflow.version}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p className="hitl-error" role="alert">
          <CircleAlert size={15} />
          {error}
        </p>
      )}

      <div className="hitl-workspace">
        <div className="hitl-matrix" role="table" aria-label="12项有效人工介入策略">
          <div className="hitl-matrix-head" role="row">
            <span>决策点</span>
            <span>本层设置</span>
            <span>最终生效（普通低风险模拟）</span>
            <span>来源</span>
            <span>条件 / 重新暂停</span>
            <span />
          </div>
          {decisionPoints.map((point) => {
            const configured = ruleFor(userPolicy, point.key);
            const inherited = ruleFor(productPolicy, point.key);
            const floor = ruleFor(safetyPolicy, point.key);
            const preview = previews[point.key];
            const mode = modes[point.key] ?? "inherit";
            const locked = floor?.mode === "deny" || floor?.mode === "require_human";
            return (
              <div
                className={`hitl-matrix-row ${selectedKey === point.key ? "selected" : ""}`}
                key={point.key}
                role="row"
              >
                <button
                  className="hitl-point-copy"
                  onClick={() => setSelectedKey(point.key)}
                  type="button"
                >
                  <strong>{point.label}</strong>
                  <small>{point.description}</small>
                </button>
                <label>
                  <span className="sr-only">{point.label}本层设置</span>
                  <select
                    disabled={scope.readOnly}
                    onChange={(event) =>
                      setModes((values) => ({
                        ...values,
                        [point.key]: event.target.value as HitlMode,
                      }))
                    }
                    value={mode}
                  >
                    {Object.entries(MODE_LABELS)
                      .filter(
                        ([value]) =>
                          value !== "conditional" ||
                          scope.readOnly ||
                          Boolean(inherited?.condition) ||
                          mode === "conditional",
                      )
                      .map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                  </select>
                </label>
                <span
                  className={`hitl-effective hitl-effective--${preview?.final_action ?? "unknown"}`}
                >
                  {locked && <LockKeyhole size={12} />}
                  {ACTION_LABELS[preview?.final_action ?? ""] ?? "等待预览"}
                </span>
                <span className="hitl-source">
                  {configured
                    ? scope.label
                    : `继承产品默认：${MODE_LABELS[inherited?.mode ?? point.default_mode]}`}
                </span>
                <span className="hitl-condition">
                  {mode === "conditional" || inherited?.mode === "conditional"
                    ? CONDITION_SUMMARIES[point.key]
                    : MODE_LABELS[mode]}
                  {preview?.result_status === "failed_closed" && (
                    <small>事实不足时会重新询问</small>
                  )}
                </span>
                <button
                  aria-label={`查看${point.label}详情`}
                  onClick={() => setSelectedKey(point.key)}
                  type="button"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            );
          })}
        </div>

        <aside className="hitl-explainer">
          {selected ? (
            <>
              <span className="hitl-explainer-icon">
                <ShieldCheck size={19} />
              </span>
              <p className="eyebrow">有效策略解释</p>
              <h3>{selected.label}</h3>
              <p>{selected.description}</p>
              <dl>
                <div>
                  <dt>本层设置</dt>
                  <dd>{MODE_LABELS[modes[selected.key] ?? "inherit"]}</dd>
                </div>
                <div>
                  <dt>普通低风险模拟</dt>
                  <dd>{ACTION_LABELS[selectedPreview?.final_action ?? ""] ?? "读取中"}</dd>
                </div>
                <div>
                  <dt>系统下限</dt>
                  <dd>{ACTION_LABELS[selectedPreview?.floor_action ?? ""] ?? "读取中"}</dd>
                </div>
                <div>
                  <dt>条件</dt>
                  <dd>{CONDITION_SUMMARIES[selected.key]}</dd>
                </div>
                <div>
                  <dt>解析器</dt>
                  <dd className="mono">{selectedPreview?.resolver_version ?? "—"}</dd>
                </div>
              </dl>
              {selectedPreview?.matched_rules.map((rule, index) => (
                <div
                  className="hitl-rule-source"
                  key={`${rule.authority}:${rule.scope_kind}:${index}`}
                >
                  <Check size={13} />
                  <span>
                    <strong>{rule.authority}</strong>
                    <small>
                      {rule.scope_kind} · {MODE_LABELS[rule.mode]}
                    </small>
                  </span>
                </div>
              ))}
              <p className="hitl-explainer-note">
                修改当前对象、模型、Payload、Context、风险或能力范围，会生成新Subject
                Hash并重新评估；旧批准不会转移。
              </p>
            </>
          ) : (
            <p>选择一个决策点查看解释。</p>
          )}
        </aside>
      </div>
    </section>
  );
}
