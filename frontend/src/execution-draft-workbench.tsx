import { ChevronDown, ChevronRight, FilePenLine, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import {
  EXECUTION_DRAFT_SECTION_ORDER,
  type ExecutionDraftSectionKey,
  type ExecutionDraftView,
  getExecutionDraft,
  reviseExecutionDraft,
} from "./execution-draft-api";

const SECTION_COPY: Record<ExecutionDraftSectionKey, { label: string; description: string }> = {
  identity_lineage: { label: "身份与运行来源", description: "本轮会话、Run和Workflow版本的绑定。" },
  intent_goal: { label: "意图与目标", description: "系统准备完成什么，以及如何理解本轮输入。" },
  project_work_binding: {
    label: "Project / Work关联",
    description: "本轮采用的项目、工作项和关联状态。",
  },
  background: { label: "背景", description: "为执行提供的必要背景，不等于完整会话历史。" },
  accepted_decisions: { label: "已接受决定", description: "此前已经由用户或有效策略确认的决定。" },
  scope: { label: "范围", description: "本轮包含与明确排除的工作边界。" },
  plan: { label: "计划", description: "步骤、顺序和本轮采用的计划模式。" },
  context_binding: { label: "上下文绑定", description: "采用的上下文清单、Hash与排除原则。" },
  resource_manifest: { label: "资源清单", description: "文件、知识、Evidence等可定位资源。" },
  runtime_target: { label: "运行目标", description: "Runtime、隔离方式和工作目录。" },
  capability_grant: { label: "能力授权", description: "本轮允许的Tool、网络和副作用范围。" },
  model_envelope: {
    label: "模型约束",
    description: "Provider/模型选择及store、Continuation等边界。",
  },
  prompt_assembly_plan: {
    label: "Prompt组装计划",
    description: "哪些内容块会进入模型上下文以及历史策略。",
  },
  hitl_plan: { label: "人工介入计划", description: "本轮哪些位置可能暂停并要求用户决定。" },
  validation_plan: { label: "验证计划", description: "如何检查结果、需要哪些Evidence。" },
  output_commit_contract: {
    label: "结果提交合同",
    description: "哪些输出只是候选，哪些可以成为产品事实。",
  },
  stop_escalation: { label: "停止与升级条件", description: "失败、结果未知或能力扩大时怎样收敛。" },
};

const FIELD_LABELS: Record<string, string> = {
  session_id: "Product Session ID",
  run_id: "Product Run ID",
  workflow_id: "Workflow ID",
  workflow_version: "Workflow版本",
  project_hint: "Project提示",
  context_hash: "Context Hash",
  working_directory: "工作目录",
  side_effects: "副作用",
  network: "网络范围",
  tools: "允许的Tool",
  store: "Provider保存",
  continuation: "Continuation",
  history_policy: "历史采用规则",
};

function fieldLabel(key: string): string {
  return FIELD_LABELS[key] ?? key.replaceAll("_", " ");
}

function ValueEditor({
  value,
  onChange,
  path,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  path: string;
}) {
  if (typeof value === "boolean") {
    return (
      <select
        aria-label={path}
        onChange={(event) => onChange(event.target.value === "true")}
        value={String(value)}
      >
        <option value="true">是（true）</option>
        <option value="false">否（false）</option>
      </select>
    );
  }
  if (typeof value === "number") {
    return (
      <input
        aria-label={path}
        onChange={(event) => onChange(Number(event.target.value))}
        type="number"
        value={value}
      />
    );
  }
  if (typeof value === "string" || value === null || value === undefined) {
    const text = value == null ? "" : value;
    const long = text.length > 72 || text.includes("\n");
    return long ? (
      <textarea
        aria-label={path}
        onChange={(event) => onChange(event.target.value)}
        rows={4}
        value={text}
      />
    ) : (
      <input aria-label={path} onChange={(event) => onChange(event.target.value)} value={text} />
    );
  }
  if (Array.isArray(value)) {
    return (
      <div className="execution-draft-list">
        {value.length === 0 && <p className="execution-draft-empty">当前为空；可添加一项。</p>}
        {value.map((item, index) => (
          <div className="execution-draft-list-item" key={`${path}-${index}`}>
            <span className="execution-draft-index">{index + 1}</span>
            <ValueEditor
              path={`${path}[${index}]`}
              value={item}
              onChange={(next) =>
                onChange(value.map((current, itemIndex) => (itemIndex === index ? next : current)))
              }
            />
            <button
              aria-label={`删除${path}第${index + 1}项`}
              onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
              type="button"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <button
          className="execution-draft-add"
          onClick={() => onChange([...value, ""])}
          type="button"
        >
          <Plus size={14} />
          添加一项
        </button>
      </div>
    );
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    return (
      <div className="execution-draft-object">
        {Object.entries(objectValue).map(([key, item]) => (
          <label className="execution-draft-field" key={`${path}.${key}`}>
            <span>
              <strong>{fieldLabel(key)}</strong>
              <small>Key固定：{key}</small>
            </span>
            <ValueEditor
              path={`${path}.${key}`}
              value={item}
              onChange={(next) => onChange({ ...objectValue, [key]: next })}
            />
          </label>
        ))}
      </div>
    );
  }
  return (
    <input
      aria-label={path}
      onChange={(event) => onChange(event.target.value)}
      value={String(value)}
    />
  );
}

interface ExecutionDraftWorkbenchProps {
  draftId: string;
  busy: boolean;
  onReapprove: (revisionId: string) => void;
}

export function ExecutionDraftWorkbench({
  draftId,
  busy,
  onReapprove,
}: ExecutionDraftWorkbenchProps) {
  const [draft, setDraft] = useState<ExecutionDraftView | null>(null);
  const [brief, setBrief] = useState("");
  const [payload, setPayload] = useState<ExecutionDraftView["payload"] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(["intent_goal", "scope", "plan", "validation_plan"]),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void getExecutionDraft(draftId)
      .then((value) => {
        if (cancelled) return;
        setDraft(value);
        setBrief(value.execution_brief);
        setPayload(structuredClone(value.payload));
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : "读取ExecutionDraft失败");
      });
    return () => {
      cancelled = true;
    };
  }, [draftId]);

  const save = async () => {
    if (!draft || !payload || !brief.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const revised = await reviseExecutionDraft(draft, brief, payload);
      setDraft(revised);
      setBrief(revised.execution_brief);
      setPayload(structuredClone(revised.payload));
      onReapprove(revised.revision_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存ExecutionDraft失败");
    } finally {
      setSaving(false);
    }
  };

  if (!draft || !payload)
    return (
      <section className="execution-draft-loading">{error ?? "正在加载ExecutionDraft…"}</section>
    );

  return (
    <section className="execution-draft-workbench" aria-label="ExecutionDraft完整编辑工作台">
      <header>
        <div>
          <FilePenLine size={18} />
          <span>
            <strong>ExecutionDraft完整编辑工作台</strong>
            <small>17部分 · revision {draft.revision} · Key固定，所有Value可编辑</small>
          </span>
        </div>
        <code>{draft.draft_hash.slice(0, 12)}</code>
      </header>
      <label className="execution-draft-brief">
        <span>
          <strong>执行摘要</strong>
          <small>给人阅读的本轮执行合同摘要</small>
        </span>
        <textarea onChange={(event) => setBrief(event.target.value)} rows={6} value={brief} />
      </label>
      <div className="execution-draft-sections">
        {EXECUTION_DRAFT_SECTION_ORDER.map((key, index) => {
          const open = expanded.has(key);
          const copy = SECTION_COPY[key];
          return (
            <section
              className={`execution-draft-section ${open ? "execution-draft-section--open" : ""}`}
              key={key}
            >
              <button
                aria-expanded={open}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
                type="button"
              >
                <span className="execution-draft-section-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{copy.label}</strong>
                  <small>{copy.description}</small>
                  <code>{key}</code>
                </span>
                {open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
              </button>
              {open && (
                <div className="execution-draft-section-body">
                  <ValueEditor
                    onChange={(value) =>
                      setPayload((current) => (current ? { ...current, [key]: value } : current))
                    }
                    path={key}
                    value={payload[key]}
                  />
                </div>
              )}
            </section>
          );
        })}
      </div>
      {error && (
        <p className="product-decision-error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <p>保存会生成新revision和Hash；旧审批不会授权新内容。</p>
        <button
          disabled={busy || saving || !brief.trim()}
          onClick={() => void save()}
          type="button"
        >
          <Save size={15} />
          {saving ? "保存中…" : "保存并重新审核"}
        </button>
      </footer>
    </section>
  );
}
