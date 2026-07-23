import * as Dialog from "@radix-ui/react-dialog";
import { Check, Pencil, ShieldCheck, SkipForward, X } from "lucide-react";
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
  if (value === null || value === undefined || value === "") return <span className="decision-empty">未设置</span>;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return <span>{String(value)}</span>;
  if (Array.isArray(value)) return <ol>{value.map((item, index) => <li key={index}><ReadableValue value={item} /></li>)}</ol>;
  if (typeof value === "object") {
    return <dl>{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{KEY_LABELS[key] ?? key}</dt><dd><ReadableValue value={item} /></dd></div>)}</dl>;
  }
  return <span>{String(value)}</span>;
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
    return <select onChange={(event) => onChange(event.target.value === "true")} value={String(Boolean(value))}><option value="false">不需要</option><option value="true">需要</option></select>;
  }
  if (field.type === "select") {
    return <select onChange={(event) => onChange(event.target.value)} value={String(value ?? "")}>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>;
  }
  if (field.type === "multi_select") {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return <div className="decision-checklist">{field.options?.map((option) => <label key={option.value}><input checked={selected.has(option.value)} onChange={(event) => {
      const next = new Set(selected);
      if (event.target.checked) next.add(option.value); else next.delete(option.value);
      onChange([...next]);
    }} type="checkbox" /><span>{option.label}</span></label>)}</div>;
  }
  if (field.type === "long_text") {
    return <textarea onChange={(event) => onChange(event.target.value)} rows={7} value={String(value ?? "")} />;
  }
  return <input onChange={(event) => onChange(event.target.value || (field.type === "text_optional" ? null : ""))} value={String(value ?? "")} />;
}

interface ProductDecisionReviewProps {
  card: ProductDecisionReviewCard;
  busy: boolean;
  requestError: string | null;
  onDecision: (decision: string, changes?: Record<string, unknown>) => void;
}

export function ProductDecisionReview({ card, busy, requestError, onDecision }: ProductDecisionReviewProps) {
  const initial = useMemo(
    () => Object.fromEntries(card.editable_fields.map((field) => [field.key, field.value])),
    [card],
  );
  const [changes, setChanges] = useState<Record<string, unknown>>(initial);
  const [editing, setEditing] = useState(false);
  const acceptAction = card.allowed_actions.find((value) => ["accept", "execute", "commit"].includes(value));
  const executionDraftEditor = card.decision_point_key === "execution_authorization"
    && card.editable_fields.some((field) => field.type === "execution_draft")
    && card.subject_resource_id;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className={`product-decision-dialog ${editing && executionDraftEditor ? "product-decision-dialog--draft" : ""}`} aria-describedby="product-decision-description">
          <header>
            <span className="product-decision-icon"><ShieldCheck size={20} /></span>
            <div><p className="eyebrow">HUMAN IN THE LOOP</p><Dialog.Title>{card.title}</Dialog.Title></div>
            <span className="product-decision-hash">{card.subject_hash.slice(0, 10)}</span>
          </header>
          <Dialog.Description id="product-decision-description">{card.reason_summary}</Dialog.Description>

          <section className="product-decision-policy">
            <strong>为什么暂停</strong>
            <p>{card.message}</p>
            <span>有效策略：{card.policy.final_action === "require_human" ? "本次需要你决定" : card.policy.final_action}</span>
          </section>

          {editing ? (
            executionDraftEditor
              ? <ExecutionDraftWorkbench busy={busy} draftId={executionDraftEditor} onReapprove={(revisionId) => onDecision("revise", { execution_draft_revision_id: revisionId })} />
              : <section className="product-decision-fields" aria-label="修改决定对象">
                  {card.editable_fields.map((field) => (
                    <label key={field.key}><span>{field.label}</span><ProductDecisionFieldEditor field={field} onChange={(value) => setChanges((current) => ({ ...current, [field.key]: value }))} value={changes[field.key]} /></label>
                  ))}
                </section>
          ) : (
            <section className="product-decision-subject"><span>当前准备采用的内容</span><ReadableValue value={card.subject} /></section>
          )}

          {requestError && <p className="product-decision-error" role="alert">{requestError}</p>}

          <footer>
            <div>
              {card.allowed_actions.includes("cancel") && <button className="decision-cancel" disabled={busy} onClick={() => onDecision("cancel")} type="button"><X size={15} />停止Run</button>}
              {card.allowed_actions.includes("skip") && <button disabled={busy} onClick={() => onDecision("skip")} type="button"><SkipForward size={15} />本轮跳过</button>}
            </div>
            <div>
              {card.allowed_actions.includes("revise") && (
                editing
                  ? !executionDraftEditor && <button disabled={busy} onClick={() => onDecision("revise", changes)} type="button"><Pencil size={15} />保存修改并重新评估</button>
                  : <button disabled={busy} onClick={() => setEditing(true)} type="button"><Pencil size={15} />修改内容</button>
              )}
              {acceptAction && <button className="decision-primary" disabled={busy} onClick={() => onDecision(acceptAction)} type="button"><Check size={16} />{ACTION_LABELS[acceptAction]}</button>}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
