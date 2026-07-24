import {
  BadgeCheck,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  Layers3,
  LockKeyhole,
  PencilLine,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UnlockKeyhole,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ExecutionDraftWorkbench } from "../../execution-draft-workbench";
import { ProductDecisionFieldEditor } from "../../product-decision-review";
import type { ProductDecisionEditableField } from "../../use-chat-agent";
import { type DurableDecisionRequest, resolveDurableDecisionRequest } from "../governance/hitl-api";
import { getRunStepInputs, type StepInputProjection } from "../workflow/workflow-api";
import {
  type CollaborationIntentSet,
  type ContextPackage,
  type HarnessMemory,
  type HarnessNote,
  type HarnessProject,
  type HarnessWorkItem,
  reviseContextPackage,
} from "./harness-api";
import { collaborationMethodPresentation } from "./harness-presentation";

type ContextItem = ContextPackage["items"][number];

interface ContextItemDraft extends ContextItem {
  ordinal: number;
}

interface AddedSource {
  source_kind: string;
  source_id: string;
  title: string;
}

const CONTEXT_SOURCE_LABELS: Record<string, string> = {
  repository_directory: "仓库轻量目录",
  repository_snapshot: "代码基线快照",
  repository_governance: "仓库治理正文",
  repository_governance_manifest: "可选治理文档",
  project_directory: "Project目录",
  project: "Project",
  work_item: "Work",
  task_plan: "Plan",
  action_item: "Action",
  note: "Note",
  accepted_memory: "已接受Memory",
  turn_summary: "回合重点",
  user_override: "用户修改副本",
};

function ContextSourceMeta({ item }: { item: ContextItem }) {
  return (
    <small className="context-source-meta">
      <span>{CONTEXT_SOURCE_LABELS[item.source_kind] ?? item.source_kind}</span>
      {item.source_revision && <code>{item.source_revision.slice(0, 10)}</code>}
      <span>{item.selection_origin === "human" ? "你选择" : "系统建议"}</span>
    </small>
  );
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="harness-empty-inline">未设置</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value))
    return (
      <ol>
        {value.map((item, index) => (
          <li key={`${index}:${String(item).slice(0, 20)}`}>
            <ReadableValue value={item} />
          </li>
        ))}
      </ol>
    );
  if (typeof value === "object")
    return (
      <dl>
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  return <span>{String(value)}</span>;
}

function EmptyContext() {
  return (
    <div className="harness-empty">
      <Layers3 size={24} />
      <strong>本会话还没有协作信息包</strong>
      <p>发送一条消息后，系统会逐步选择项目、规则、历史重点和其他必要信息。</p>
    </div>
  );
}

const SCENARIO_LABELS: Record<string, string> = {
  simple_question: "简单询问",
  continue_project: "继续Project",
  new_task: "新任务",
  plan_request: "规划请求",
  learning: "学习",
  clarify: "等待澄清",
};

function IntentSetSummary({ value }: { value: CollaborationIntentSet | null }) {
  if (!value) {
    return (
      <section className="intent-summary-card intent-summary-card--empty">
        <Sparkles size={19} />
        <div>
          <strong>尚未形成本轮目标</strong>
          <p>意图Agent完成后，这里会显示系统准备推进什么，以及为什么这样理解。</p>
        </div>
      </section>
    );
  }
  return (
    <section className="intent-summary-card">
      <header>
        <span>
          <BadgeCheck size={20} />
          <span>
            <strong>我理解你这轮要推进 {value.intents.length} 件事</strong>
            <small>
              {value.status === "accepted" ? "已接受" : "等待确认"} · revision{" "}
              {value.current_revision.revision}
            </small>
          </span>
        </span>
        <code>{value.current_revision.revision_hash.slice(0, 10)}</code>
      </header>
      {value.intents.length > 1 && (
        <div className="intent-composition-note">
          <Layers3 size={18} />
          <span>
            <strong>本轮先组合，再逐项完成</strong>
            <small>
              每个目标本身都可直接处理；系统仍会先形成一份组合计划，避免遗漏、串线或重复执行。
            </small>
          </span>
        </div>
      )}
      <div className="intent-summary-list">
        {value.intents.map((intent, index) => {
          const revision = intent.current_revision;
          return (
            <article key={intent.id}>
              <span className="intent-summary-order">{index + 1}</span>
              <div>
                <header>
                  <strong>{revision.goal}</strong>
                  <b>{SCENARIO_LABELS[revision.scenario] ?? revision.scenario}</b>
                </header>
                <p>{revision.expected_outcome}</p>
                <div className="intent-summary-facts">
                  {revision.project_hint && <span>关联提示：{revision.project_hint}</span>}
                  <span>{revision.needs_plan ? "先形成计划" : "可直接处理"}</span>
                  {revision.dependency_branch_keys.length > 0 && (
                    <span>依赖前置目标 {revision.dependency_branch_keys.length} 个</span>
                  )}
                </div>
                {revision.constraints.length > 0 && (
                  <details>
                    <summary>
                      查看 {revision.constraints.length} 条边界
                      <ChevronDown size={14} />
                    </summary>
                    <ul>
                      {revision.constraints.map((constraint) => (
                        <li key={constraint}>{constraint}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {intent.clarification && (
                  <div className="intent-clarification">
                    <CircleAlert size={15} />
                    <span>
                      <strong>{intent.clarification.question}</strong>
                      <small>
                        {intent.clarification.status === "answered"
                          ? "已通过后续聊天回答"
                          : "请直接在聊天输入框回答"}
                      </small>
                    </span>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <details className="progressive-details">
        <summary>
          查看识别依据与技术标识
          <ChevronDown size={15} />
        </summary>
        <dl>
          <div>
            <dt>推进方式</dt>
            <dd>
              {value.current_revision.combination_policy === "single"
                ? "单一目标"
                : "按顺序推进多个目标"}
            </dd>
          </div>
          <div>
            <dt>Intent Set ID</dt>
            <dd>{value.id}</dd>
          </div>
          {value.intents.map((intent) => (
            <div key={intent.id}>
              <dt>{intent.branch_key}</dt>
              <dd>{intent.current_revision.reason_summary}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}

function DurableDecisionCard({
  request,
  onResolved,
}: {
  request: DurableDecisionRequest;
  onResolved: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const item = request.items[0];
  const decisionView = item?.subject?.decision_view ?? {};
  const editableFields = Array.isArray(decisionView.editable_fields)
    ? (decisionView.editable_fields as ProductDecisionEditableField[])
    : [];
  const [changes, setChanges] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(editableFields.map((field) => [field.key, field.value])),
  );
  if (!item)
    return (
      <article className="durable-decision-card">
        <p className="harness-error">这个决定缺少可处理内容，请刷新后重试。</p>
      </article>
    );
  const draftId =
    request.decision_point_key === "execution_authorization"
      ? (item.subject?.resource_id ?? null)
      : null;
  const resolve = async (decision: string, responsePayload: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await resolveDurableDecisionRequest(
        request,
        request.items.map((value) => ({ item_key: value.item_key, decision })),
        responsePayload,
      );
      onResolved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "提交决定失败");
    } finally {
      setBusy(false);
    }
  };
  const genericEditor =
    !draftId && item.allowed_actions.includes("revise") && editableFields.length > 0;
  return (
    <article className="durable-decision-card">
      <header>
        <div>
          <ShieldCheck size={19} />
          <span>
            <strong>{request.title}</strong>
            <small>{request.reason_summary}</small>
          </span>
        </div>
        <span className="decision-waiting-badge">等你决定</span>
      </header>
      {!editing && (
        <details className="progressive-details">
          <summary>
            查看准备采用的内容
            <ChevronDown size={16} />
          </summary>
          <section>
            <ReadableValue
              value={
                (request.visible_evidence.content as unknown) ??
                decisionView.content ??
                decisionView
              }
            />
          </section>
        </details>
      )}
      {editing && draftId && (
        <ExecutionDraftWorkbench
          busy={busy}
          draftId={draftId}
          onReapprove={(revisionId) =>
            void resolve("revise", {
              changes: { execution_draft_revision_id: revisionId },
            })
          }
        />
      )}
      {editing && genericEditor && (
        <section
          className="product-decision-fields durable-decision-fields"
          aria-label="修改决定内容"
        >
          {editableFields.map((field) => (
            <div className="durable-decision-field" key={field.key}>
              <span>{field.label}</span>
              <ProductDecisionFieldEditor
                field={field}
                onChange={(value) => setChanges((current) => ({ ...current, [field.key]: value }))}
                value={changes[field.key]}
              />
            </div>
          ))}
        </section>
      )}
      {error && <p className="harness-error">{error}</p>}
      <footer>
        {item.allowed_actions.includes("revise") && !editing && (
          <button disabled={busy} onClick={() => setEditing(true)} type="button">
            <PencilLine size={15} />
            先修改
          </button>
        )}
        {genericEditor && editing && (
          <button disabled={busy} onClick={() => void resolve("revise", { changes })} type="button">
            保存修改
          </button>
        )}
        {item.allowed_actions
          .filter((action) => action !== "revise")
          .map((action) => (
            <button
              className={
                ["accept", "approve", "execute", "commit"].includes(action) ? "harness-primary" : ""
              }
              disabled={busy}
              key={action}
              onClick={() => void resolve(action)}
              type="button"
            >
              {action === "cancel"
                ? "停止本轮"
                : action === "skip"
                  ? "本轮跳过"
                  : action === "commit"
                    ? "提交并继续"
                    : "确认并继续"}
            </button>
          ))}
      </footer>
      <details className="technical-details">
        <summary>技术信息</summary>
        <p>
          决定点 {request.decision_point_key} · 请求 {request.request_hash.slice(0, 10)} ·{" "}
          {request.runtime_recovery?.status ?? "等待恢复点"}
        </p>
      </details>
    </article>
  );
}

function MethodSummary({ projection }: { projection: StepInputProjection | null }) {
  const input = projection?.input ?? {};
  const method = collaborationMethodPresentation(input, projection?.projection_revision ?? "");
  const phases = Array.isArray(input.phases)
    ? (input.phases as Array<{ key?: string; name?: string }>)
    : [];
  const rules = Array.isArray(input.applicable_rules)
    ? (input.applicable_rules as Array<{
        rule_key?: string;
        name?: string;
        description?: string;
        enforcement?: string;
      }>)
    : [];
  return (
    <section className="context-method-card">
      <div className="context-method-icon">
        <Sparkles size={20} />
      </div>
      <div className="context-method-copy">
        <span>基础协作方法</span>
        <strong>{method.protocolName}</strong>
        <p>{method.selectionReason}</p>
      </div>
      {projection && <span className="context-method-revision">基础 r{method.revision}</span>}
      {method.hasCompositionOverlay && (
        <section aria-label="本轮有效组合策略" className="context-method-overlay">
          <div>
            <Layers3 size={18} />
          </div>
          <span>
            <small>本轮有效组合策略</small>
            <strong>{method.compositionTitle}</strong>
            <p>{method.compositionReason}</p>
            <span className="context-method-overlay-facts">
              <b>{method.intentCount} 个目标</b>
              <b>规划角色已启用</b>
            </span>
          </span>
        </section>
      )}
      {(phases.length > 0 || rules.length > 0 || method.hasCompositionOverlay) && (
        <details className="context-method-details">
          <summary>
            查看方法阶段、规则和本轮策略
            <ChevronDown size={16} />
          </summary>
          {method.hasCompositionOverlay && (
            <div className="context-method-policy-comparison">
              <span>
                <small>基础方法</small>
                <strong>{method.basePlannerLabel}</strong>
              </span>
              <span>
                <small>本轮实际采用</small>
                <strong>{method.effectivePlannerLabel}</strong>
              </span>
            </div>
          )}
          {phases.length > 0 && (
            <ol className="method-phase-list">
              {phases.map((phase, index) => (
                <li key={phase.key ?? index}>
                  <span>{index + 1}</span>
                  {phase.name ?? phase.key}
                </li>
              ))}
            </ol>
          )}
          {rules.length > 0 && (
            <div className="method-rule-list">
              {rules.map((rule, index) => (
                <article key={rule.rule_key ?? index}>
                  <strong>{rule.name ?? rule.rule_key}</strong>
                  <p>{rule.description}</p>
                  <small>{rule.enforcement ?? "规则"}</small>
                </article>
              ))}
            </div>
          )}
        </details>
      )}
    </section>
  );
}

function SourcePicker({
  projects,
  work,
  notes,
  accepted,
  selected,
  onToggle,
}: {
  projects: HarnessProject[];
  work: HarnessWorkItem[];
  notes: HarnessNote[];
  accepted: HarnessMemory[];
  selected: AddedSource[];
  onToggle: (source: AddedSource) => void;
}) {
  const choices: AddedSource[] = [
    ...projects.map((value) => ({
      source_kind: "project",
      source_id: value.id,
      title: `项目 · ${value.title}`,
    })),
    ...work.map((value) => ({
      source_kind: "work_item",
      source_id: value.id,
      title: `工作 · ${value.title}`,
    })),
    ...notes.map((value) => ({
      source_kind: "note",
      source_id: value.id,
      title: `笔记 · ${value.title}`,
    })),
    ...accepted.map((value) => ({
      source_kind: "accepted_memory",
      source_id: value.id,
      title: `记忆 · ${value.current_revision?.content.slice(0, 36) ?? value.memory_kind}`,
    })),
  ];
  const selectedKeys = new Set(selected.map((value) => `${value.source_kind}:${value.source_id}`));
  return (
    <details className="context-source-picker">
      <summary>
        <Plus size={16} />
        从我的信息中添加
        <span>{selected.length > 0 ? `已选 ${selected.length}` : "可选"}</span>
      </summary>
      {choices.length === 0 ? (
        <p>还没有可加入的项目、工作、笔记或已接受记忆。</p>
      ) : (
        <div>
          {choices.map((source) => {
            const key = `${source.source_kind}:${source.source_id}`;
            const checked = selectedKeys.has(key);
            return (
              <label key={key}>
                <input checked={checked} onChange={() => onToggle(source)} type="checkbox" />
                <span>{source.title}</span>
              </label>
            );
          })}
        </div>
      )}
    </details>
  );
}

function EditableSource({
  item,
  onChange,
}: {
  item: ContextItemDraft;
  onChange: (value: ContextItemDraft) => void;
}) {
  return (
    <article className={`context-edit-item ${item.adopted ? "" : "context-edit-item--excluded"}`}>
      <header>
        <label>
          <input
            checked={item.adopted}
            disabled={item.locked}
            onChange={(event) => onChange({ ...item, adopted: event.target.checked })}
            type="checkbox"
          />
          <span>
            <strong>{item.title}</strong>
            <small>{item.adopted ? "会进入本轮" : "本轮不采用"}</small>
            {item.source_kind === "repository_governance_manifest" && (
              <small>勾选后由服务端核对Snapshot并载入正文</small>
            )}
          </span>
        </label>
        <button
          aria-label={item.locked ? `取消锁定${item.title}` : `锁定${item.title}`}
          className={item.locked ? "context-lock--active" : ""}
          onClick={() =>
            onChange({
              ...item,
              adopted: item.locked ? item.adopted : true,
              locked: !item.locked,
            })
          }
          type="button"
        >
          {item.locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}
        </button>
      </header>
      <textarea
        aria-label={`${item.title}的本轮内容`}
        onChange={(event) => onChange({ ...item, content: event.target.value })}
        rows={5}
        value={item.content}
      />
      <input
        aria-label={`${item.title}的采用原因`}
        onChange={(event) => onChange({ ...item, reason: event.target.value })}
        value={item.reason}
      />
    </article>
  );
}

export function ContextInspector({
  context,
  decisions,
  intentSet,
  projects,
  work,
  notes,
  accepted,
  onRefresh,
  onContextChanged,
}: {
  context: ContextPackage | null;
  decisions: DurableDecisionRequest[];
  intentSet: CollaborationIntentSet | null;
  projects: HarnessProject[];
  work: HarnessWorkItem[];
  notes: HarnessNote[];
  accepted: HarnessMemory[];
  onRefresh: () => void;
  onContextChanged: (value: ContextPackage) => void;
}) {
  const [stepInputs, setStepInputs] = useState<StepInputProjection[]>([]);
  const [editing, setEditing] = useState(false);
  const [draftItems, setDraftItems] = useState<ContextItemDraft[]>([]);
  const [addedSources, setAddedSources] = useState<AddedSource[]>([]);
  const [reason, setReason] = useState("我调整了本轮真正要采用的信息");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!context) {
      setStepInputs([]);
      return;
    }
    let cancelled = false;
    void getRunStepInputs(context.run_id)
      .then((values) => {
        if (!cancelled) setStepInputs(values);
      })
      .catch((loadError: unknown) => {
        if (!cancelled)
          setError(loadError instanceof Error ? loadError.message : "读取节点输入失败");
      });
    return () => {
      cancelled = true;
    };
  }, [context]);

  const protocolProjection =
    [...stepInputs]
      .reverse()
      .find((value) => value.node_id === "collaboration_protocol_resolver") ?? null;
  const adopted = context?.items.filter((value) => value.adopted) ?? [];
  const excluded = context?.items.filter((value) => !value.adopted) ?? [];
  const locked = context?.items.filter((value) => value.locked) ?? [];
  const usage = context
    ? Math.min(100, Math.round((context.estimated_tokens / context.token_budget) * 100))
    : 0;

  const beginEditing = () => {
    if (!context) return;
    setDraftItems(context.items.map((value, ordinal) => ({ ...value, ordinal })));
    setAddedSources([]);
    setReason("我调整了本轮真正要采用的信息");
    setError(null);
    setEditing(true);
  };
  const toggleAdded = (source: AddedSource) => {
    const key = `${source.source_kind}:${source.source_id}`;
    setAddedSources((current) =>
      current.some((value) => `${value.source_kind}:${value.source_id}` === key)
        ? current.filter((value) => `${value.source_kind}:${value.source_id}` !== key)
        : [...current, source],
    );
  };
  const save = async () => {
    if (!context || !reason.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const value = await reviseContextPackage(context.id, {
        expected_package_hash: context.package_hash,
        reason,
        item_changes: draftItems.map((item) => ({
          ordinal: item.ordinal,
          adopted: item.adopted,
          locked: item.locked,
          content: item.content,
          reason: item.reason,
          materialize: item.source_kind === "repository_governance_manifest" && item.adopted,
        })),
        added_source_refs: addedSources.map((source) => ({
          source_kind: source.source_kind,
          source_id: source.source_id,
          adopted: true,
          locked: true,
          reason: "用户从信息面板明确加入本轮",
        })),
      });
      onContextChanged(value);
      setEditing(false);
      onRefresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存本轮信息失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="context-inspector context-inspector--progressive">
      <header className="harness-toolbar">
        <div>
          <p className="eyebrow">本轮如何理解与行动</p>
          <h3>本轮协作信息</h3>
          <p>先看结论；需要时再展开来源、规则和技术细节。</p>
        </div>
        <div>
          <button onClick={onRefresh} type="button">
            <RefreshCw size={16} />
            刷新
          </button>
          {context && !editing && (
            <button className="context-edit-trigger" onClick={beginEditing} type="button">
              <PencilLine size={16} />
              调整本轮信息
            </button>
          )}
        </div>
      </header>

      {decisions.length > 0 && (
        <section className="durable-decision-inbox">
          <header>
            <CircleAlert size={20} />
            <div>
              <strong>现在需要你做 {decisions.length} 个决定</strong>
              <p>每张卡片都会说明采用什么，以及确认后会发生什么。</p>
            </div>
            <span>{decisions.length}</span>
          </header>
          {decisions.map((request) => (
            <DurableDecisionCard key={request.id} onResolved={onRefresh} request={request} />
          ))}
        </section>
      )}

      {!context ? (
        <EmptyContext />
      ) : editing ? (
        <section className="context-editor">
          <header>
            <div>
              <strong>调整真正进入本轮的内容</strong>
              <p>你可以采用、排除、锁定，也可以直接修改将要使用的文字。</p>
            </div>
            <button onClick={() => setEditing(false)} type="button">
              <X size={16} />
              取消
            </button>
          </header>
          <div className="context-edit-list">
            {draftItems.map((item) => (
              <EditableSource
                item={item}
                key={`${item.ordinal}:${item.source_kind}:${item.source_id}`}
                onChange={(value) =>
                  setDraftItems((current) =>
                    current.map((candidate) =>
                      candidate.ordinal === value.ordinal ? value : candidate,
                    ),
                  )
                }
              />
            ))}
          </div>
          <SourcePicker
            accepted={accepted}
            notes={notes}
            onToggle={toggleAdded}
            projects={projects}
            selected={addedSources}
            work={work}
          />
          <label className="context-revision-reason">
            <span>为什么这样调整</span>
            <input onChange={(event) => setReason(event.target.value)} value={reason} />
          </label>
          {error && <p className="harness-error">{error}</p>}
          <footer>
            <span>保存后会生成新 revision；旧的执行授权会自动失效。</span>
            <button
              className="harness-primary"
              disabled={saving || !reason.trim()}
              onClick={() => void save()}
              type="button"
            >
              <Check size={16} />
              {saving ? "正在保存…" : "保存并重新检查"}
            </button>
          </footer>
        </section>
      ) : (
        <>
          <IntentSetSummary value={intentSet} />
          <MethodSummary projection={protocolProjection} />
          <section className="context-overview-card">
            <div className="context-overview-heading">
              <span>
                <Layers3 size={19} />
                本轮信息概览
              </span>
              <code>revision {context.revision}</code>
            </div>
            <div className="context-overview-metrics">
              <div>
                <strong>{adopted.length}</strong>
                <span>采用</span>
              </div>
              <div>
                <strong>{excluded.length}</strong>
                <span>排除</span>
              </div>
              <div>
                <strong>{locked.length}</strong>
                <span>你已锁定</span>
              </div>
              <div>
                <strong>{usage}%</strong>
                <span>预算占用</span>
              </div>
            </div>
            <div
              aria-label={`Token预算使用${usage}%`}
              className="context-budget-track"
              role="progressbar"
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={usage}
            >
              <span style={{ width: `${usage}%` }} />
            </div>
            <p>
              预计 {context.estimated_tokens} / {context.token_budget} Tokens ·{" "}
              {context.stage === "detail" ? "已进入项目详细信息" : "当前为轻量信息目录"}
            </p>
          </section>

          <details className="context-source-group" open>
            <summary>
              <span>
                <Check size={18} />
                本轮会采用
              </span>
              <b>{adopted.length}</b>
              <ChevronDown size={17} />
            </summary>
            <div>
              {adopted.length === 0 ? (
                <p className="knowledge-empty">本轮没有采用额外来源。</p>
              ) : (
                adopted.map((item) => (
                  <article key={`${item.source_kind}:${item.source_id}`}>
                    <header>
                      <span>
                        {item.locked && <LockKeyhole size={14} />}
                        <strong>{item.title}</strong>
                      </span>
                      <small>{item.token_estimate} Tokens</small>
                    </header>
                    <ContextSourceMeta item={item} />
                    <p>{item.reason}</p>
                    <details className="progressive-details">
                      <summary>
                        查看进入本轮的文字
                        <ChevronDown size={15} />
                      </summary>
                      <pre>{item.content}</pre>
                    </details>
                  </article>
                ))
              )}
            </div>
          </details>

          {excluded.length > 0 && (
            <details className="context-source-group context-source-group--excluded">
              <summary>
                <span>
                  <X size={18} />
                  本轮不采用
                </span>
                <b>{excluded.length}</b>
                <ChevronDown size={17} />
              </summary>
              <div>
                {excluded.map((item) => (
                  <article key={`${item.source_kind}:${item.source_id}`}>
                    <header>
                      <strong>{item.title}</strong>
                      <small>{item.token_estimate} Tokens</small>
                    </header>
                    <ContextSourceMeta item={item} />
                    <p>{item.reason}</p>
                  </article>
                ))}
              </div>
            </details>
          )}

          <details className="context-audit-details">
            <summary>
              <span>
                <FileText size={17} />
                审计与节点输入
              </span>
              <span>{stepInputs.length} 个节点投影</span>
              <ChevronDown size={17} />
            </summary>
            <section>
              <dl>
                <div>
                  <dt>Context ID</dt>
                  <dd>{context.id}</dd>
                </div>
                <div>
                  <dt>Context Hash</dt>
                  <dd>{context.package_hash}</dd>
                </div>
                <div>
                  <dt>上一 revision</dt>
                  <dd>{context.previous_package_id ?? "首个版本"}</dd>
                </div>
              </dl>
              <div className="step-input-list">
                {stepInputs.map((step) => (
                  <details key={step.id}>
                    <summary>
                      <span>
                        <strong>{step.node_id}</strong>
                        <small>
                          输入 r{step.projection_revision} · {step.projection_hash.slice(0, 10)}
                        </small>
                      </span>
                      <ChevronDown size={15} />
                    </summary>
                    <section>
                      <ReadableValue value={step.input} />
                    </section>
                  </details>
                ))}
              </div>
            </section>
          </details>
          {error && <p className="harness-error">{error}</p>}
        </>
      )}
    </div>
  );
}
