import { Check, Code2, Eye, Plus, Save, ShieldCheck, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { ParameterEditor, ToolEditor } from "./features/model-call-review/request-section-editors";
import {
  ContentPartEditor,
  FixedValueEditor,
  KeyLabel,
} from "./features/model-call-review/structured-editors";
import {
  changeMessageRole,
  contentTypesForRole,
  contextSourceIndexForMessage,
  convertRequestForProvider,
  isRecord,
  modelFor,
  otherParameters,
  policyIssues,
  providerFor,
  ROLE_LABELS,
  requestInstructions,
  requestMessages,
  stableStringify,
  withOtherParameters,
  withRequestInstructions,
  withRequestMessages,
} from "./model-call-review-logic";
import type { ModelCallReviewCard, ModelCapabilities } from "./use-chat-agent";

interface ModelCallReviewProps {
  card: ModelCallReviewCard;
  busy: boolean;
  requestError: string | null;
  onApprove: () => void;
  onRevise: (providerId: string, providerRequest: Record<string, unknown>) => void;
  onAbandon: () => void;
}

function MessageEditor({
  value,
  capabilities,
  sources,
  embeddedInstructions,
  onChange,
}: {
  value: unknown;
  capabilities: ModelCapabilities;
  sources: ModelCallReviewCard["effective_context"]["history_and_knowledge"];
  embeddedInstructions: boolean;
  onChange: (value: unknown) => void;
}) {
  if (!Array.isArray(value)) {
    return <FixedValueEditor fieldKey="input" onChange={onChange} value={value} />;
  }
  const instructionIndex = embeddedInstructions
    ? value.findIndex((message) => isRecord(message) && message.role === "system")
    : -1;
  return (
    <div className="section-stack">
      {value.map((messageValue, index) => {
        const message = isRecord(messageValue) ? messageValue : {};
        const role = typeof message.role === "string" ? message.role : "";
        const stringContent = typeof message.content === "string";
        const fallbackType = contentTypesForRole(capabilities, role)[0] ?? "text";
        const content = stringContent
          ? [{ type: fallbackType, text: message.content }]
          : Array.isArray(message.content)
            ? message.content
            : [];
        const sourcesAlreadyIncludeInstructions = sources.length === value.length;
        const sourceIndex = contextSourceIndexForMessage(
          index,
          value.length,
          sources.length,
          instructionIndex,
        );
        const instructionTokenEstimate = sourcesAlreadyIncludeInstructions
          ? sources[index]?.token_estimate
          : undefined;
        const source =
          index === instructionIndex
            ? {
                source_label: "Agent Instructions",
                adoption_reason: "当前Agent行为约束；在该协议中作为system消息发送",
                token_estimate: instructionTokenEstimate,
              }
            : sources[sourceIndex];
        const providerItemType = typeof message.type === "string" ? message.type : "";
        if (
          !role &&
          ["function_call", "function_call_output", "reasoning"].includes(providerItemType)
        ) {
          return (
            <article className="structured-card" key={`message-${index}`}>
              <header>
                <div>
                  <span className="item-index">Provider上下文项 {index + 1}</span>
                  <small>{providerItemType} · 已显式纳入本次请求</small>
                </div>
                <button
                  aria-label={`删除Provider上下文项${index + 1}`}
                  className="structured-remove"
                  disabled={value.length === 1}
                  onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                  type="button"
                >
                  <Trash2 size={15} />
                </button>
              </header>
              <div className="structured-object">
                {Object.entries(message).map(([key, child]) => (
                  <div className="kv-row" key={key}>
                    <KeyLabel name={key} />
                    <div className="kv-value">
                      {key === "type" ||
                      (key === "name" && providerItemType === "function_call") ? (
                        <input disabled value={String(child ?? "")} />
                      ) : (
                        <FixedValueEditor
                          fieldKey={key}
                          onChange={(next) =>
                            onChange(
                              value.map((current, itemIndex) =>
                                itemIndex === index ? { ...message, [key]: next } : current,
                              ),
                            )
                          }
                          value={child}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </article>
          );
        }
        return (
          <article className="structured-card" key={`message-${index}`}>
            <header>
              <div>
                <span className="item-index">
                  消息 {index + 1} · {source?.source_label ?? "未标注来源"}
                </span>
                <small>
                  {source?.adoption_reason ?? "该内容已进入本次Provider请求"} ·{" "}
                  {source?.token_estimate === undefined
                    ? "保存后重算Token"
                    : `约 ${source.token_estimate} Tokens`}
                </small>
              </div>
              <button
                aria-label={`删除消息${index + 1}`}
                className="structured-remove"
                disabled={value.length === 1}
                onClick={() => onChange(value.filter((_, itemIndex) => itemIndex !== index))}
                title={value.length === 1 ? "至少保留一条消息" : "从本次模型上下文移除"}
                type="button"
              >
                <Trash2 size={15} />
              </button>
            </header>
            <div className="structured-object">
              <div className="kv-row">
                <KeyLabel name="role" />
                <div className="kv-value">
                  <select
                    aria-label={`消息${index + 1}角色`}
                    onChange={(event) => {
                      const next = changeMessageRole(message, event.target.value, capabilities);
                      onChange(
                        value.map((current, itemIndex) => (itemIndex === index ? next : current)),
                      );
                    }}
                    value={capabilities.roles.includes(role) ? role : ""}
                  >
                    {!capabilities.roles.includes(role) && <option value="">请选择有效角色</option>}
                    {capabilities.roles.map((option) => (
                      <option key={option} value={option}>
                        {ROLE_LABELS[option] ?? option}（{option}）
                      </option>
                    ))}
                  </select>
                  <small>Role决定模型如何理解该消息；切换后内容类型会同步调整。</small>
                </div>
              </div>
              <div className="kv-row">
                <KeyLabel name="content" />
                <div className="kv-value structured-array">
                  {content.map((part, contentIndex) => (
                    <div
                      className="structured-array-item"
                      key={`message-${index}-content-${contentIndex}`}
                    >
                      <div className="structured-item-heading">
                        <span>内容 {contentIndex + 1}</span>
                        <button
                          aria-label={`删除消息${index + 1}内容${contentIndex + 1}`}
                          className="structured-remove"
                          disabled={content.length === 1}
                          onClick={() => {
                            const nextMessage = {
                              ...message,
                              content: content.filter((_, itemIndex) => itemIndex !== contentIndex),
                            };
                            onChange(
                              value.map((current, itemIndex) =>
                                itemIndex === index ? nextMessage : current,
                              ),
                            );
                          }}
                          type="button"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <ContentPartEditor
                        capabilities={capabilities}
                        onChange={(nextPart) => {
                          const nextMessage = {
                            ...message,
                            content:
                              stringContent && nextPart.type === "text"
                                ? String(nextPart.text ?? "")
                                : content.map((current, itemIndex) =>
                                    itemIndex === contentIndex ? nextPart : current,
                                  ),
                          };
                          onChange(
                            value.map((current, itemIndex) =>
                              itemIndex === index ? nextMessage : current,
                            ),
                          );
                        }}
                        role={role}
                        value={part}
                      />
                    </div>
                  ))}
                  <button
                    className="structured-add"
                    onClick={() => {
                      const nextType = contentTypesForRole(capabilities, role)[0] ?? "input_text";
                      const nextMessage = {
                        ...message,
                        content: [...content, { type: nextType, text: "" }],
                      };
                      onChange(
                        value.map((current, itemIndex) =>
                          itemIndex === index ? nextMessage : current,
                        ),
                      );
                    }}
                    type="button"
                  >
                    <Plus size={15} /> 添加内容片段
                  </button>
                </div>
              </div>
            </div>
          </article>
        );
      })}
      <button
        className="structured-add"
        onClick={() => {
          const contentType = contentTypesForRole(capabilities, "user")[0] ?? "input_text";
          onChange([
            ...value,
            {
              role: "user",
              content: contentType === "text" ? "" : [{ type: contentType, text: "" }],
            },
          ]);
        }}
        type="button"
      >
        <Plus size={15} /> 高级：添加一条手动上下文消息
      </button>
      <p className="structured-empty">
        只有确实需要补充本次模型上下文时才添加；它不是发送新的聊天消息。
      </p>
    </div>
  );
}

function ReviewSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="friendly-section">
      <header>
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

export function ModelCallReview({
  card,
  busy,
  requestError,
  onApprove,
  onRevise,
  onAbandon,
}: ModelCallReviewProps) {
  const [tab, setTab] = useState<"effective" | "provider">("effective");
  const [workingProviderId, setWorkingProviderId] = useState(card.provider_id);
  const [workingRequest, setWorkingRequest] = useState<Record<string, unknown>>(
    () => card.provider_request,
  );
  const [rawJson, setRawJson] = useState(() => JSON.stringify(card.provider_request, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);

  useEffect(() => {
    setWorkingProviderId(card.provider_id);
    setWorkingRequest(card.provider_request);
    setRawJson(JSON.stringify(card.provider_request, null, 2));
    setRawError(null);
  }, [card]);

  const originalFingerprint = useMemo(
    () =>
      stableStringify({ provider_id: card.provider_id, provider_request: card.provider_request }),
    [card],
  );
  const currentFingerprint = useMemo(
    () => stableStringify({ provider_id: workingProviderId, provider_request: workingRequest }),
    [workingProviderId, workingRequest],
  );
  const dirty = originalFingerprint !== currentFingerprint;
  const selectedProvider = providerFor(card.provider_catalog, workingProviderId);
  const selectedModel = modelFor(card.provider_catalog, workingProviderId, workingRequest.model);
  const runtimeAllowsUnknown = card.effective_context.model_capabilities.allow_unknown_parameters;
  const selectedCapabilities = selectedModel
    ? runtimeAllowsUnknown
      ? { ...selectedModel.capabilities, allow_unknown_parameters: true }
      : selectedModel.capabilities
    : card.effective_context.model_capabilities;
  const localIssues = policyIssues(workingProviderId, card.provider_catalog, workingRequest, {
    capabilities: selectedCapabilities,
    allowedToolNames: card.execution_context?.allowed_tool_names ?? [],
  });
  const valid = !rawError && localIssues.length === 0;
  const approveReason = busy
    ? "系统正在处理当前操作"
    : dirty
      ? "内容已经修改，请先保存；保存会生成新版本和新审批Hash"
      : !valid
        ? "当前请求存在校验问题，请先修正"
        : "当前版本已绑定审批 Hash，可以批准并发送此模型请求";
  const approveLabel = busy
    ? "处理中…"
    : dirty
      ? "请先保存修改"
      : !valid
        ? "请先修正内容"
        : "批准并发送此模型请求";

  const updateRequest = (next: Record<string, unknown>) => {
    setWorkingRequest(next);
    setRawJson(JSON.stringify(next, null, 2));
    setRawError(null);
  };

  return (
    <div className="review-backdrop" role="presentation">
      <section
        aria-labelledby="review-title"
        aria-modal="true"
        className="review-panel"
        role="dialog"
      >
        <header className="review-header">
          <div className="review-heading">
            <span className="review-icon">
              <ShieldCheck size={20} />
            </span>
            <div>
              <p className="eyebrow">每次模型调用审批</p>
              <h2 id="review-title">确认真正发给模型的内容</h2>
              {card.execution_context?.agent_name && (
                <small className="review-agent-context">
                  {card.execution_context.agent_name} · 第{" "}
                  {card.execution_context.call_position ?? "—"}/
                  {card.execution_context.total_calls ?? "—"} 次模型调用 · Agent r
                  {card.execution_context.agent_revision ?? "—"}
                </small>
              )}
            </div>
          </div>
          <div className="review-meta">
            <span>v{card.version}</span>
            <span title={card.binding_hash}>Hash {card.binding_hash.slice(0, 10)}…</span>
            <span>
              {dirty ? "保存后重算Token" : `约 ${card.effective_context.token_estimate} Tokens`}
            </span>
          </div>
        </header>

        <div className="review-tabs" role="tablist">
          <button
            aria-selected={tab === "effective"}
            className={tab === "effective" ? "active" : ""}
            onClick={() => setTab("effective")}
            role="tab"
            type="button"
          >
            <Eye size={16} /> 可读编辑
          </button>
          <button
            aria-selected={tab === "provider"}
            className={tab === "provider" ? "active" : ""}
            onClick={() => setTab("provider")}
            role="tab"
            type="button"
          >
            <Code2 size={16} /> Provider JSON
          </button>
          <p>可读表单与高级JSON编辑同一份请求草稿</p>
        </div>

        <div className="review-body">
          {tab === "effective" ? (
            <div className="readable-editor">
              <ReviewSection
                description="Provider决定可用模型和实际发送路由；这里不能自由填写。"
                title="Provider 与模型"
              >
                <div className="review-grid review-grid--provider">
                  <label className="review-field">
                    <span>Provider</span>
                    <select
                      aria-label="Provider"
                      onChange={(event) => {
                        const provider = providerFor(card.provider_catalog, event.target.value);
                        if (!provider) return;
                        setWorkingProviderId(provider.id);
                        updateRequest(convertRequestForProvider(workingRequest, provider));
                      }}
                      value={workingProviderId}
                    >
                      {card.provider_catalog.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="review-field">
                    <span>模型</span>
                    <select
                      aria-label="模型"
                      onChange={(event) =>
                        updateRequest({ ...workingRequest, model: event.target.value })
                      }
                      value={typeof workingRequest.model === "string" ? workingRequest.model : ""}
                    >
                      {!selectedProvider?.models.some(
                        (model) => model.id === workingRequest.model,
                      ) && <option value="">请选择有效模型</option>}
                      {selectedProvider?.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </ReviewSection>

              <ReviewSection
                description={card.effective_context.adoption_reasons.instructions}
                title="Instructions"
              >
                <label className="review-field review-field--wide">
                  <span>instructions</span>
                  <textarea
                    onChange={(event) =>
                      updateRequest(withRequestInstructions(workingRequest, event.target.value))
                    }
                    rows={4}
                    value={requestInstructions(workingRequest)}
                  />
                  {"messages" in workingRequest && (
                    <small>
                      当前Provider使用Chat Completions协议；这里编辑的是同一请求中的system消息。
                    </small>
                  )}
                </label>
              </ReviewSection>

              <ReviewSection
                description={card.effective_context.adoption_reasons.history_and_knowledge}
                title="完整消息、历史与知识内容"
              >
                <section className="context-summary" aria-label="上下文Token估算">
                  <span>Instructions 约 {card.effective_context.token_breakdown.instructions}</span>
                  <span>
                    消息约{" "}
                    {card.effective_context.token_breakdown.messages.reduce(
                      (sum, item) => sum + item,
                      0,
                    )}
                  </span>
                  <span>Tool约 {card.effective_context.token_breakdown.tools}</span>
                  <span>参数约 {card.effective_context.token_breakdown.parameters}</span>
                  <small>Unicode启发式估算，不是Provider最终计费Token。</small>
                </section>
                <MessageEditor
                  capabilities={selectedCapabilities}
                  embeddedInstructions={"messages" in workingRequest}
                  onChange={(value) => updateRequest(withRequestMessages(workingRequest, value))}
                  sources={card.effective_context.history_and_knowledge}
                  value={requestMessages(workingRequest) ?? []}
                />
                {card.effective_context.knowledge_sources.length === 0 && (
                  <p className="structured-empty">
                    本次没有独立知识库、附件或检索结果进入模型请求。
                  </p>
                )}
              </ReviewSection>

              <ReviewSection
                description={
                  card.execution_context?.allowed_tool_names?.length
                    ? "Tool来自本次执行已绑定的真实能力目录；name锁定，说明与Schema可编辑但必须保持执行合同兼容。"
                    : "Tool只能从服务端已注册、可执行且通过权限检查的目录选择；本次没有可用Tool。"
                }
                title="Tool"
              >
                <ToolEditor
                  onChange={(value) => updateRequest({ ...workingRequest, tools: value })}
                  registeredToolNames={card.execution_context?.allowed_tool_names ?? []}
                  value={workingRequest.tools ?? []}
                />
              </ReviewSection>

              <ReviewSection
                description="固定Key不可改名；Value按布尔、数值、枚举或文字类型编辑。"
                title="Reasoning、输出和传输参数"
              >
                <ParameterEditor
                  capabilities={selectedCapabilities}
                  onChange={(value) => updateRequest(withOtherParameters(workingRequest, value))}
                  value={otherParameters(workingRequest)}
                />
              </ReviewSection>
            </div>
          ) : (
            <div className="provider-editor">
              <div className="provider-route-summary">
                <span>发送路由</span>
                <strong>{selectedProvider?.label ?? workingProviderId}</strong>
                <small>Provider路由不属于HTTP Body，但会与下方Body共同绑定审批Hash。</small>
              </div>
              <label className="raw-editor">
                <span>即将发送的完整请求Body</span>
                <textarea
                  aria-invalid={Boolean(rawError)}
                  onChange={(event) => {
                    const next = event.target.value;
                    setRawJson(next);
                    try {
                      const parsed: unknown = JSON.parse(next);
                      if (!isRecord(parsed)) throw new Error("根节点必须是对象");
                      setWorkingRequest(parsed);
                      setRawError(null);
                    } catch (parseError) {
                      setRawError(
                        parseError instanceof Error ? parseError.message : "JSON格式错误",
                      );
                    }
                  }}
                  rows={24}
                  spellCheck={false}
                  value={rawJson}
                />
                {rawError && <small className="field-error">{rawError}</small>}
              </label>
            </div>
          )}
        </div>

        <div className="review-validation" aria-live="polite" id="review-action-status">
          {requestError && <p className="review-error">{requestError}</p>}
          {rawError && <p className="review-error">Provider JSON格式错误：{rawError}</p>}
          {localIssues.map((issue) => (
            <p className="review-error" key={issue}>
              {issue}
            </p>
          ))}
          {!requestError && valid && dirty && (
            <p className="review-warning">
              <Save size={14} /> 检测到未保存修改：请先保存，系统会生成新版本和新
              Hash，然后才能批准发送。
            </p>
          )}
          {!requestError && valid && !dirty && (
            <p>
              <Check size={14} /> 当前版本已绑定审批 Hash，可以批准并发送此模型请求。
            </p>
          )}
        </div>

        <footer className="review-actions">
          <button
            className="review-button review-button--abandon"
            disabled={busy}
            onClick={onAbandon}
            type="button"
          >
            放弃本次模型调用并返回输入框
          </button>
          <div>
            <button
              aria-describedby="review-action-status"
              className="review-button review-button--save"
              disabled={busy || !dirty || !valid}
              onClick={() => onRevise(workingProviderId, workingRequest)}
              title={
                !dirty
                  ? "当前没有未保存修改"
                  : !valid
                    ? "请先修正校验问题"
                    : "保存后生成新版本并重新审批"
              }
              type="button"
            >
              <Save size={16} /> 保存为新版本并重新审批
            </button>
            <button
              aria-describedby="review-action-status"
              className="review-button review-button--approve"
              disabled={busy || dirty || !valid}
              onClick={onApprove}
              title={approveReason}
              type="button"
            >
              <ShieldCheck size={16} /> {approveLabel}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
