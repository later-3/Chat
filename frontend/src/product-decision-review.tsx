import * as Dialog from "@radix-ui/react-dialog";
import { Check, Pencil, Plus, ShieldCheck, SkipForward, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ExecutionDraftWorkbench } from "./execution-draft-workbench";
import type { ProductDecisionEditableField, ProductDecisionReviewCard } from "./use-chat-agent";

const ACTION_LABELS: Record<string, string> = {
  accept: "接受并继续",
  execute: "授权并继续",
  commit: "提交并继续",
  skip: "本轮跳过",
  cancel: "停止当前Run",
};

const KEY_LABELS: Record<string, string> = {
  scenario: "场景",
  goal: "本轮目标",
  project_hint: "Project提示",
  confidence: "置信度",
  needs_plan: "需要计划",
  clarification_question: "澄清问题",
  plan: "计划",
  response: "准备提交的答复",
  selected_summaries: "采用的主题摘要",
  candidates: "候选内容",
};

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "")
    return <span className="decision-empty">未设置</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return <span>{String(value)}</span>;
  if (Array.isArray(value))
    return (
      <ol>
        {value.map((item, index) => (
          <li key={index}>
            <ReadableValue value={item} />
          </li>
        ))}
      </ol>
    );
  if (typeof value === "object") {
    return (
      <dl>
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <div key={key}>
            <dt>{KEY_LABELS[key] ?? key}</dt>
            <dd>
              <ReadableValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}

const INTENT_SCENARIOS = [
  ["simple_question", "简单询问"],
  ["continue_project", "继续Project"],
  ["new_task", "新任务"],
  ["plan_request", "规划请求"],
  ["learning", "学习"],
  ["clarify", "需要澄清"],
] as const;

function asIntentValues(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
    : [];
}

function IntentSetEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const intents = asIntentValues(value);
  const update = (index: number, changes: Record<string, unknown>) => {
    onChange(intents.map((item, current) => (current === index ? { ...item, ...changes } : item)));
  };
  const add = () => {
    if (intents.length >= 4) return;
    const ordinal = intents.length + 1;
    onChange([
      ...intents,
      {
        branch_key: `intent_${ordinal}`,
        scenario: "simple_question",
        goal: "",
        expected_outcome: "",
        confidence: 1,
        project_hint: null,
        needs_plan: false,
        needs_clarification: false,
        clarification_question: null,
        context_keywords: [],
        dependency_branch_keys: [],
        constraints: [],
        reason_summary: "用户在审核时新增Intent",
      },
    ]);
  };

  return (
    <div className="intent-set-editor">
      <header>
        <div>
          <strong>{intents.length} 个目标</strong>
          <span>按从上到下的顺序推进；最多4个。</span>
        </div>
        <button disabled={intents.length >= 4} onClick={add} type="button">
          <Plus size={15} />
          添加目标
        </button>
      </header>
      {intents.map((intent, index) => {
        const scenario = String(intent.scenario ?? "simple_question");
        const priorBranches = intents.slice(0, index);
        const dependencies = new Set(
          Array.isArray(intent.dependency_branch_keys)
            ? intent.dependency_branch_keys.map(String)
            : [],
        );
        return (
          <article className="intent-edit-card" key={String(intent.branch_key ?? index)}>
            <div className="intent-edit-card-heading">
              <span>
                <b>{index + 1}</b>
                <strong>目标 {index + 1}</strong>
              </span>
              {intents.length > 1 && (
                <button
                  aria-label={`删除目标${index + 1}`}
                  onClick={() => onChange(intents.filter((_, current) => current !== index))}
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
            <div className="intent-edit-grid">
              <label>
                <span>场景</span>
                <select
                  onChange={(event) => {
                    const next = event.target.value;
                    update(index, {
                      scenario: next,
                      needs_clarification: next === "clarify",
                      clarification_question:
                        next === "clarify"
                          ? intent.clarification_question || "你希望我接下来具体推进哪件事？"
                          : null,
                    });
                  }}
                  value={scenario}
                >
                  {INTENT_SCENARIOS.map(([option, label]) => (
                    <option key={option} value={option}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>关联Project提示</span>
                <input
                  onChange={(event) =>
                    update(index, { project_hint: event.target.value.trim() || null })
                  }
                  placeholder="不关联可留空"
                  value={String(intent.project_hint ?? "")}
                />
              </label>
            </div>
            <label>
              <span>这次真正要做什么</span>
              <textarea
                onChange={(event) => update(index, { goal: event.target.value })}
                rows={3}
                value={String(intent.goal ?? "")}
              />
            </label>
            <label>
              <span>怎样算得到想要的结果</span>
              <textarea
                onChange={(event) => update(index, { expected_outcome: event.target.value })}
                rows={3}
                value={String(intent.expected_outcome ?? intent.goal ?? "")}
              />
            </label>
            <label>
              <span>边界与限制（每行一条）</span>
              <textarea
                onChange={(event) =>
                  update(index, {
                    constraints: event.target.value
                      .split("\n")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="例如：只读审查，不修改代码"
                rows={3}
                value={
                  Array.isArray(intent.constraints) ? intent.constraints.map(String).join("\n") : ""
                }
              />
            </label>
            {priorBranches.length > 0 && (
              <fieldset>
                <legend>开始前必须完成</legend>
                {priorBranches.map((prior, priorIndex) => {
                  const key = String(prior.branch_key ?? `intent_${priorIndex + 1}`);
                  return (
                    <label key={key}>
                      <input
                        checked={dependencies.has(key)}
                        onChange={(event) => {
                          const next = new Set(dependencies);
                          if (event.target.checked) next.add(key);
                          else next.delete(key);
                          update(index, { dependency_branch_keys: [...next] });
                        }}
                        type="checkbox"
                      />
                      <span>{String(prior.goal ?? `目标 ${priorIndex + 1}`)}</span>
                    </label>
                  );
                })}
              </fieldset>
            )}
            <label className="intent-plan-toggle">
              <input
                checked={Boolean(intent.needs_plan)}
                onChange={(event) => update(index, { needs_plan: event.target.checked })}
                type="checkbox"
              />
              <span>进入执行前先形成计划</span>
            </label>
            {scenario === "clarify" && (
              <label>
                <span>需要问我的问题</span>
                <textarea
                  onChange={(event) =>
                    update(index, {
                      clarification_question: event.target.value,
                      needs_clarification: true,
                    })
                  }
                  rows={3}
                  value={String(intent.clarification_question ?? "")}
                />
              </label>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function ProductDecisionFieldEditor({
  field,
  value,
  onChange,
}: {
  field: ProductDecisionEditableField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (field.type === "boolean") {
    return (
      <select
        onChange={(event) => onChange(event.target.value === "true")}
        value={String(Boolean(value))}
      >
        <option value="false">不需要</option>
        <option value="true">需要</option>
      </select>
    );
  }
  if (field.type === "select") {
    return (
      <select onChange={(event) => onChange(event.target.value)} value={String(value ?? "")}>
        {field.options?.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "multi_select") {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className="decision-checklist">
        {field.options?.map((option) => (
          <label key={option.value}>
            <input
              checked={selected.has(option.value)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(option.value);
                else next.delete(option.value);
                onChange([...next]);
              }}
              type="checkbox"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    );
  }
  if (field.type === "intent_set") {
    return <IntentSetEditor onChange={onChange} value={value} />;
  }
  if (field.type === "long_text") {
    return (
      <textarea
        onChange={(event) => onChange(event.target.value)}
        rows={7}
        value={String(value ?? "")}
      />
    );
  }
  return (
    <input
      onChange={(event) =>
        onChange(event.target.value || (field.type === "text_optional" ? null : ""))
      }
      value={String(value ?? "")}
    />
  );
}

interface ProductDecisionReviewProps {
  card: ProductDecisionReviewCard;
  busy: boolean;
  requestError: string | null;
  onDecision: (decision: string, changes?: Record<string, unknown>) => void;
}

export function ProductDecisionReview({
  card,
  busy,
  requestError,
  onDecision,
}: ProductDecisionReviewProps) {
  const initial = useMemo(
    () => Object.fromEntries(card.editable_fields.map((field) => [field.key, field.value])),
    [card],
  );
  const [changes, setChanges] = useState<Record<string, unknown>>(initial);
  const [editing, setEditing] = useState(false);
  const acceptAction = card.allowed_actions.find((value) =>
    ["accept", "execute", "commit"].includes(value),
  );
  const executionDraftEditor =
    card.decision_point_key === "execution_authorization" &&
    card.editable_fields.some((field) => field.type === "execution_draft") &&
    card.subject_resource_id;
  const intentSetEditor = card.editable_fields.some((field) => field.type === "intent_set");

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`product-decision-dialog ${
            editing && executionDraftEditor
              ? "product-decision-dialog--draft"
              : editing && intentSetEditor
                ? "product-decision-dialog--intent"
                : ""
          }`}
          aria-describedby="product-decision-description"
        >
          <header>
            <span className="product-decision-icon">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="eyebrow">HUMAN IN THE LOOP</p>
              <Dialog.Title>{card.title}</Dialog.Title>
            </div>
            <span className="product-decision-hash">{card.subject_hash.slice(0, 10)}</span>
          </header>
          <Dialog.Description id="product-decision-description">
            {card.reason_summary}
          </Dialog.Description>

          <section className="product-decision-policy">
            <strong>为什么暂停</strong>
            <p>{card.message}</p>
            <span>
              有效策略：
              {card.policy.final_action === "require_human"
                ? "本次需要你决定"
                : card.policy.final_action}
            </span>
          </section>

          {editing ? (
            executionDraftEditor ? (
              <ExecutionDraftWorkbench
                busy={busy}
                draftId={executionDraftEditor}
                onReapprove={(revisionId) =>
                  onDecision("revise", { execution_draft_revision_id: revisionId })
                }
              />
            ) : (
              <section className="product-decision-fields" aria-label="修改决定对象">
                {card.editable_fields.map((field) => (
                  <label key={field.key}>
                    <span>{field.label}</span>
                    <ProductDecisionFieldEditor
                      field={field}
                      onChange={(value) =>
                        setChanges((current) => ({ ...current, [field.key]: value }))
                      }
                      value={changes[field.key]}
                    />
                  </label>
                ))}
              </section>
            )
          ) : (
            <section className="product-decision-subject">
              <span>当前准备采用的内容</span>
              <ReadableValue value={card.subject} />
            </section>
          )}

          {requestError && (
            <p className="product-decision-error" role="alert">
              {requestError}
            </p>
          )}

          <footer>
            <div>
              {card.allowed_actions.includes("cancel") && (
                <button
                  className="decision-cancel"
                  disabled={busy}
                  onClick={() => onDecision("cancel")}
                  type="button"
                >
                  <X size={15} />
                  停止Run
                </button>
              )}
              {card.allowed_actions.includes("skip") && (
                <button disabled={busy} onClick={() => onDecision("skip")} type="button">
                  <SkipForward size={15} />
                  本轮跳过
                </button>
              )}
            </div>
            <div>
              {card.allowed_actions.includes("revise") &&
                (editing ? (
                  !executionDraftEditor && (
                    <button
                      disabled={busy}
                      onClick={() => onDecision("revise", changes)}
                      type="button"
                    >
                      <Pencil size={15} />
                      保存修改并重新评估
                    </button>
                  )
                ) : (
                  <button disabled={busy} onClick={() => setEditing(true)} type="button">
                    <Pencil size={15} />
                    修改内容
                  </button>
                ))}
              {acceptAction && (
                <button
                  className="decision-primary"
                  disabled={busy}
                  onClick={() => onDecision(acceptAction)}
                  type="button"
                >
                  <Check size={16} />
                  {ACTION_LABELS[acceptAction]}
                </button>
              )}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
