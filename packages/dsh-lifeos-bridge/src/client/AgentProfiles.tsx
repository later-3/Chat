import { useEffect, useState } from "react";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  type AgentKey,
  type AgentProfileDto,
} from "@chat/contracts/public";
import { browserCommandId, requestSameOriginJson } from "./same-origin-json.ts";

/** Agent是独立配置对象；Workflow节点只引用它，会话Prompt不在这里出现。 */
export function AgentProfiles(_props: SettingsSectionOwnerProps) {
  const [items, setItems] = useState<readonly AgentProfileDto[]>([]);
  const [selectedKey, setSelectedKey] = useState<AgentKey | null>(null);
  const [draft, setDraft] = useState("");
  const [runtimeVariantKey, setRuntimeVariantKey] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const selected = items.find((item) => item.agentKey === selectedKey) ?? items[0] ?? null;
  const runtimeVariant =
    selected?.runtimeBaseline?.variants.find((item) => item.variantKey === runtimeVariantKey) ??
    selected?.runtimeBaseline?.variants[0] ??
    null;
  const editablePrompt = (profile: AgentProfileDto): string =>
    profile.systemPrompt.source === "runtime_default" ? "" : profile.systemPrompt.bodyMarkdown;

  const publish = (profile: AgentProfileDto) => {
    setItems((current) =>
      current.map((item) => (item.agentKey === profile.agentKey ? profile : item)),
    );
    setDraft(editablePrompt(profile));
    setStatus("ready");
  };

  const load = async () => {
    setStatus("loading");
    setError(null);
    try {
      const response = await requestSameOriginJson("/lifeos/agents", agentProfilesDtoSchema);
      setItems(response.items);
      const nextKey = selectedKey ?? response.items[0]?.agentKey ?? null;
      setSelectedKey(nextKey);
      setDraft(
        response.items.find((item) => item.agentKey === nextKey) === undefined
          ? ""
          : editablePrompt(response.items.find((item) => item.agentKey === nextKey)!),
      );
      setStatus("ready");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Agent读取失败");
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (selected !== null) setDraft(editablePrompt(selected));
  }, [selected?.agentKey, selected?.systemPrompt.sha256]);

  useEffect(() => {
    setRuntimeVariantKey(
      selected?.systemPrompt.source === "runtime_default"
        ? selected.systemPrompt.runtimeVariantKey
        : (selected?.runtimeBaseline?.variants[0]?.variantKey ?? null),
    );
  }, [
    selected?.agentKey,
    selected?.runtimeBaseline?.packageVersion,
    selected?.systemPrompt.source,
    selected?.systemPrompt.source === "runtime_default"
      ? selected.systemPrompt.runtimeVariantKey
      : undefined,
  ]);

  const save = async () => {
    if (selected === null) return;
    setStatus("saving");
    setError(null);
    try {
      publish(
        await requestSameOriginJson(
          `/lifeos/agents/${encodeURIComponent(selected.agentKey)}/prompt-revisions`,
          agentProfileDtoSchema,
          {
            method: "POST",
            body: JSON.stringify({
              commandId: browserCommandId(),
              payload: {
                expectedAggregateRevision: selected.systemPrompt.aggregateRevision,
                ...(selected.systemPrompt.source === "principal_override"
                  ? {
                      currentRevisionId: selected.systemPrompt.promptFragmentRevisionId,
                      currentRevisionSha256: selected.systemPrompt.sha256,
                    }
                  : {}),
                bodyMarkdown: draft,
              },
            }),
          },
        ),
      );
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Agent Prompt保存失败");
    }
  };

  const restore = async () => {
    if (selected === null || selected.systemPrompt.source !== "principal_override") return;
    setStatus("saving");
    setError(null);
    try {
      publish(
        await requestSameOriginJson(
          `/lifeos/agents/${encodeURIComponent(selected.agentKey)}/restore-default`,
          agentProfileDtoSchema,
          {
            method: "POST",
            body: JSON.stringify({
              commandId: browserCommandId(),
              payload: {
                expectedAggregateRevision: selected.systemPrompt.aggregateRevision,
                currentRevisionId: selected.systemPrompt.promptFragmentRevisionId,
                currentRevisionSha256: selected.systemPrompt.sha256,
              },
            }),
          },
        ),
      );
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Agent Prompt恢复失败");
    }
  };

  if (status === "loading" && items.length === 0) return <p>正在读取 Agent…</p>;
  if (selected === null) return <p className="lifeos-error">{error ?? "没有可用Agent"}</p>;

  return (
    <section className="lifeos-agent-settings" data-testid="lifeos-agent-settings">
      <header>
        <div>
          <h2>Agent</h2>
          <p>
            这里区分上游Agent运行时基线与Chat可管理的完整覆盖；Workflow节点只引用Agent，不复制上游实现。
          </p>
        </div>
        <button type="button" onClick={() => void load()} disabled={status === "saving"}>
          刷新
        </button>
      </header>
      {error === null ? null : (
        <p className="lifeos-error" role="alert">
          {error}
        </p>
      )}
      <div className="lifeos-agent-settings-layout">
        <nav aria-label="Agent列表">
          {items.map((agent) => (
            <button
              key={agent.agentKey}
              type="button"
              data-active={agent.agentKey === selected.agentKey ? "true" : "false"}
              onClick={() => setSelectedKey(agent.agentKey)}
            >
              <strong>{agent.title}</strong>
              <span>{agent.description}</span>
              <code>{agent.profileVersion}</code>
            </button>
          ))}
        </nav>
        <article>
          <header>
            <div>
              <small>
                {selected.runtimeBaseline === undefined ? "Agent System Prompt" : "Agent 配置"}
              </small>
              <h3>{selected.title}</h3>
            </div>
            <span>
              {selected.systemPrompt.source === "runtime_default"
                ? "继承 Pi 默认"
                : selected.systemPrompt.source === "builtin"
                  ? "Chat 内置默认"
                  : `我的覆盖 v${String(selected.systemPrompt.revision)}`}
            </span>
          </header>
          {selected.runtimeBaseline === undefined || runtimeVariant === null ? null : (
            <section
              className="lifeos-agent-runtime-baseline"
              data-testid="lifeos-agent-runtime-baseline"
            >
              <header>
                <div>
                  <h4>Pi Coding Agent 运行时基线</h4>
                  <p>来自受管Pi Fork的真实AgentSession构造结果，不是Chat手写的近似模板。</p>
                </div>
                <code>
                  {selected.runtimeBaseline.packageName}@{selected.runtimeBaseline.packageVersion}
                </code>
              </header>
              {selected.runtimeBaseline.variants.length <= 1 ? null : (
                <nav className="lifeos-agent-runtime-variants" aria-label="Pi运行能力预览">
                  {selected.runtimeBaseline.variants.map((variant) => (
                    <button
                      key={variant.variantKey}
                      type="button"
                      data-active={
                        variant.variantKey === runtimeVariant.variantKey ? "true" : "false"
                      }
                      onClick={() => setRuntimeVariantKey(variant.variantKey)}
                    >
                      {variant.title}
                    </button>
                  ))}
                </nav>
              )}
              <p className="lifeos-agent-runtime-description">{runtimeVariant.description}</p>
              <div className="lifeos-agent-runtime-layers">
                <details open>
                  <summary>
                    <strong>Pi 默认 System Prompt</strong>
                    <span>
                      运行时生成 · SHA {runtimeVariant.piSystemPrompt.sha256.slice(0, 12)}
                    </span>
                  </summary>
                  <pre>{runtimeVariant.piSystemPrompt.bodyMarkdown}</pre>
                </details>
                <details>
                  <summary>
                    <strong>Chat 固定运行约束（随后追加）</strong>
                    <span>
                      appendSystemPrompt · SHA{" "}
                      {selected.runtimeBaseline.chatRuntimeAppend.sha256.slice(0, 12)}
                    </span>
                  </summary>
                  <pre>{selected.runtimeBaseline.chatRuntimeAppend.bodyMarkdown}</pre>
                </details>
              </div>
              <section className="lifeos-agent-runtime-tools">
                <header>
                  <strong>本能力实际Tool Schema</strong>
                  <span>{runtimeVariant.enabledToolNames.length} 个工具</span>
                </header>
                {runtimeVariant.tools.length === 0 ? (
                  <p>该能力不向模型提供Workspace工具。</p>
                ) : (
                  runtimeVariant.tools.map((tool) => (
                    <details key={tool.name}>
                      <summary>
                        <code>{tool.name}</code>
                        <span>{tool.description}</span>
                      </summary>
                      <pre>{tool.parametersJson}</pre>
                    </details>
                  ))
                )}
              </section>
              <p className="lifeos-agent-runtime-note">
                {selected.runtimeBaseline.finalReviewNote}
              </p>
            </section>
          )}
          <label>
            {selected.runtimeBaseline === undefined
              ? "身份、长期职责与工作方式"
              : selected.systemPrompt.source === "runtime_default"
                ? "自定义 System Prompt（留空继承 Pi；填写并保存后完整覆盖）"
                : "自定义 System Prompt（完整覆盖 Pi 默认，可修改并版本化）"}
            <textarea
              aria-label="Agent System Prompt"
              value={draft}
              placeholder={
                selected.systemPrompt.source === "runtime_default"
                  ? "当前直接继承上方 Pi 默认 System Prompt；需要替换时在这里输入完整正文。"
                  : undefined
              }
              disabled={status === "saving"}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <div className="lifeos-agent-settings-actions">
            {selected.systemPrompt.source === "principal_override" ? (
              <button type="button" disabled={status === "saving"} onClick={() => void restore()}>
                {selected.runtimeBaseline === undefined ? "恢复 Chat 内置默认" : "恢复 Pi 默认"}
              </button>
            ) : null}
            <button
              type="button"
              className="lifeos-primary"
              disabled={
                status === "saving" ||
                draft.trim() === "" ||
                (selected.systemPrompt.source !== "runtime_default" &&
                  draft === selected.systemPrompt.bodyMarkdown)
              }
              onClick={() => void save()}
            >
              {status === "saving" ? "正在保存…" : "保存为新Revision"}
            </button>
          </div>
          {selected.runtimeBaseline !== undefined ? null : (
            <section className="lifeos-agent-tools">
              <header>
                <h4>可用工具</h4>
                <span>Runtime锁定；Workflow可以进一步收窄，Prompt不能扩权</span>
              </header>
              {selected.tools.map((tool) => (
                <div key={tool.name}>
                  <code>{tool.name}</code>
                  <span>{tool.description}</span>
                </div>
              ))}
            </section>
          )}
          <dl>
            <div>
              <dt>适用节点类型</dt>
              <dd>{selected.supportedNodeTypes.join(" / ")}</dd>
            </div>
            <div>
              <dt>Prompt Revision</dt>
              <dd>
                {selected.systemPrompt.source === "runtime_default" ? (
                  <code>Pi runtime · {selected.systemPrompt.runtimeVariantKey}</code>
                ) : (
                  <code>{selected.systemPrompt.promptFragmentRevisionId}</code>
                )}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}
