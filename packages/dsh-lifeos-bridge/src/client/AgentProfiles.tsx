import { useEffect, useState } from "react";
import type { HostObservable, InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  agentProfileDtoSchema,
  agentProfilesDtoSchema,
  promptWorkspacesDtoSchema,
  type AgentKey,
  type AgentProfileDto,
  type AgentResources,
  type AgentVersion,
  type PromptWorkspaceDto,
} from "@chat/contracts/public";
import { browserCommandId, requestSameOriginJson } from "./same-origin-json.ts";
import type { PromptStudioState } from "./prompt-studio-controller.ts";
import { RuntimeResourceInventory } from "./RuntimeResourceInventory.tsx";

export interface AgentProfilesInjected {
  hooks: { promptStudio: HostObservable<PromptStudioState> };
  openSourceFile: (
    relativePath: string,
    openerId: PromptStudioState["sourceOpeners"][number]["id"],
  ) => Promise<void>;
}

export type AgentProfilesProps = SettingsSectionOwnerProps & InjectFace<AgentProfilesInjected>;

const RESOURCE_LABEL: Readonly<Record<keyof AgentResources, string>> = {
  contextFiles: "上下文文件",
  skills: "Skills",
  promptTemplates: "Prompt Templates",
  extensions: "Extensions",
};

const INHERIT_RUNTIME_RESOURCES: AgentResources = {
  contextFiles: "inherit_runtime_default",
  skills: "inherit_runtime_default",
  promptTemplates: "inherit_runtime_default",
  extensions: "inherit_runtime_default",
};

function agentProfilesPath(workspaceRootId: string | null): string {
  return workspaceRootId === null
    ? "/lifeos/agents"
    : `/lifeos/agents?workspaceRootId=${encodeURIComponent(workspaceRootId)}`;
}

function AgentSourceFiles({
  paths,
  openers,
  openSourceFile,
}: {
  paths: readonly string[];
  openers: PromptStudioState["sourceOpeners"];
  openSourceFile: AgentProfilesInjected["openSourceFile"];
}) {
  const preferred = openers.find((opener) => opener.id === "vscode") ?? openers[0];
  return (
    <div className="lifeos-agent-source-files" aria-label="真实来源文件">
      {paths.map((path) => (
        <div key={path}>
          <code title={path}>{path}</code>
          {preferred === undefined ? (
            <span>本机打开不可用</span>
          ) : (
            <button
              type="button"
              aria-label={`用 ${preferred.label} 打开 ${path}`}
              onClick={() => void openSourceFile(path, preferred.id).catch(() => undefined)}
            >
              {preferred.id === "vscode" ? "用 VS Code 打开" : `用 ${preferred.label} 打开`}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Agent是独立配置对象；Workflow节点只引用它，会话Prompt不在这里出现。 */
export function AgentProfiles({ usePromptStudio, openSourceFile }: AgentProfilesProps) {
  const promptStudio = usePromptStudio((value) => value);
  const [items, setItems] = useState<readonly AgentProfileDto[]>([]);
  const [workspaces, setWorkspaces] = useState<readonly PromptWorkspaceDto[]>([]);
  const [profileWorkspaceRootId, setProfileWorkspaceRootId] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<AgentKey | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [runtimeVariantKey, setRuntimeVariantKey] = useState<string | null>(null);
  const [versionTitle, setVersionTitle] = useState("");
  const [versionDescription, setVersionDescription] = useState("");
  const [versionScopeKind, setVersionScopeKind] = useState<"global" | "workspace">("global");
  const [versionWorkspaceRootId, setVersionWorkspaceRootId] = useState("");
  const [versionPromptMode, setVersionPromptMode] = useState<"inherit_runtime" | "replace">(
    "inherit_runtime",
  );
  const [versionPrompt, setVersionPrompt] = useState("");
  const [versionTools, setVersionTools] = useState<readonly string[]>([]);
  const [versionResources, setVersionResources] =
    useState<AgentResources>(INHERIT_RUNTIME_RESOURCES);
  const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const visibleError = error ?? promptStudio.error;
  const selected = items.find((item) => item.agentKey === selectedKey) ?? items[0] ?? null;
  const canManageVersions = selected?.allowedActions.includes("create_version") ?? false;
  const selectedAgentVersion =
    selected?.versions.find((version) => version.agentVersionId === selectedVersionId) ?? null;
  const runtimeVariant =
    selected?.runtimeBaseline?.variants.find((item) => item.variantKey === runtimeVariantKey) ??
    selected?.runtimeBaseline?.variants[0] ??
    null;
  const editablePrompt = (profile: AgentProfileDto): string =>
    profile.systemPrompt.source === "runtime_default" ? "" : profile.systemPrompt.bodyMarkdown;

  const editVersion = (
    profile: AgentProfileDto,
    version: AgentVersion | null,
    defaultWorkspaceRootId = profileWorkspaceRootId,
  ): void => {
    const defaultVariant =
      profile.runtimeBaseline?.variants.find(
        (candidate) =>
          candidate.variantKey ===
          (profile.systemPrompt.source === "runtime_default"
            ? profile.systemPrompt.runtimeVariantKey
            : undefined),
      ) ?? profile.runtimeBaseline?.variants[0];
    if (version === null) {
      setSelectedVersionId(null);
      setVersionTitle(`${profile.title} · 自定义版本`);
      setVersionDescription("基于当前Pi运行时基线创建的不可变Agent版本");
      setVersionScopeKind(defaultWorkspaceRootId === null ? "global" : "workspace");
      setVersionWorkspaceRootId(defaultWorkspaceRootId ?? workspaces[0]?.rootId ?? "");
      setRuntimeVariantKey(defaultVariant?.variantKey ?? null);
      setVersionPromptMode("inherit_runtime");
      setVersionPrompt("");
      setVersionTools(defaultVariant?.enabledToolNames ?? []);
      setVersionResources(INHERIT_RUNTIME_RESOURCES);
      return;
    }
    setSelectedVersionId(version.agentVersionId);
    setVersionTitle(version.title);
    setVersionDescription(version.description);
    setVersionScopeKind(version.scope.kind);
    setVersionWorkspaceRootId(version.scope.kind === "workspace" ? version.scope.rootId : "");
    setRuntimeVariantKey(version.runtime.baseVariantKey);
    setVersionPromptMode(version.systemPrompt.mode);
    setVersionPrompt(
      version.systemPrompt.mode === "replace" ? version.systemPrompt.bodyMarkdown : "",
    );
    setVersionTools(version.enabledToolNames);
    setVersionResources(version.resources);
  };

  const publish = (profile: AgentProfileDto) => {
    setItems((current) =>
      current.map((item) => (item.agentKey === profile.agentKey ? profile : item)),
    );
    setDraft(editablePrompt(profile));
    setStatus("ready");
  };

  const load = async (
    workspaceRootId: string | null = profileWorkspaceRootId,
    versionToOpen?: string,
  ) => {
    setStatus("loading");
    setError(null);
    try {
      const [response, workspaceResponse] = await Promise.all([
        requestSameOriginJson(agentProfilesPath(workspaceRootId), agentProfilesDtoSchema),
        requestSameOriginJson("/lifeos/prompts/workspaces", promptWorkspacesDtoSchema),
      ]);
      setItems(response.items);
      setWorkspaces(workspaceResponse.items);
      const nextKey = selectedKey ?? response.items[0]?.agentKey ?? null;
      setSelectedKey(nextKey);
      setDraft(
        response.items.find((item) => item.agentKey === nextKey) === undefined
          ? ""
          : editablePrompt(response.items.find((item) => item.agentKey === nextKey)!),
      );
      const nextProfile = response.items.find((item) => item.agentKey === nextKey);
      if (nextProfile !== undefined) {
        const version = nextProfile.versions.find(
          (candidate) => candidate.agentVersionId === versionToOpen,
        );
        editVersion(nextProfile, version ?? null, workspaceRootId);
      }
      setStatus("ready");
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Agent读取失败");
    }
  };

  useEffect(() => {
    void load(null);
  }, []);

  useEffect(() => {
    if (selected !== null) setDraft(editablePrompt(selected));
  }, [selected?.agentKey, selected?.systemPrompt.sha256]);

  useEffect(() => {
    if (selected !== null) editVersion(selected, null);
  }, [
    selected?.agentKey,
    selected?.runtimeBaseline?.packageVersion,
    selected?.systemPrompt.source,
    selected?.systemPrompt.source === "runtime_default"
      ? selected.systemPrompt.runtimeVariantKey
      : undefined,
  ]);

  const saveVersion = async () => {
    if (selected === null || runtimeVariant === null || !canManageVersions) return;
    if (versionScopeKind === "workspace" && versionWorkspaceRootId === "") {
      setError("Workspace范围需要选择目标工作区");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      const base = selected.versions.find(
        (version) => version.agentVersionId === selectedVersionId,
      );
      const profile = await requestSameOriginJson(
        `/lifeos/agents/${encodeURIComponent(selected.agentKey)}/versions`,
        agentProfileDtoSchema,
        {
          method: "POST",
          body: JSON.stringify({
            commandId: browserCommandId(),
            payload: {
              title: versionTitle,
              description: versionDescription,
              scope:
                versionScopeKind === "global"
                  ? { kind: "global" }
                  : { kind: "workspace", rootId: versionWorkspaceRootId },
              runtime: { kind: "pi_coding_agent", baseVariantKey: runtimeVariant.variantKey },
              systemPrompt:
                versionPromptMode === "inherit_runtime"
                  ? { mode: "inherit_runtime" }
                  : { mode: "replace", bodyMarkdown: versionPrompt },
              enabledToolNames: versionTools,
              enabledCapabilityRefs: runtimeVariant.tools
                .filter((tool) => versionTools.includes(tool.name))
                .map((tool) => ({
                  localName: tool.name,
                  capabilityId: tool.capability.capabilityId,
                  descriptorSha256: tool.capability.descriptorSha256,
                })),
              resources: versionResources,
              ...(base === undefined
                ? {}
                : {
                    basedOnVersionId: base.agentVersionId,
                    basedOnVersionSha256: base.sha256,
                  }),
            },
          }),
        },
      );
      const created = profile.versions.reduce<AgentVersion | null>(
        (latest, version) =>
          latest === null || version.version > latest.version ? version : latest,
        null,
      );
      await load(profileWorkspaceRootId, created?.agentVersionId);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "Agent Version保存失败");
    }
  };

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
        <div className="lifeos-agent-profile-scope">
          <label>
            Runtime Profile作用域
            <select
              aria-label="Agent Runtime Profile作用域"
              value={profileWorkspaceRootId ?? "__global__"}
              disabled={status === "saving"}
              onChange={(event) => {
                const next =
                  event.currentTarget.value === "__global__" ? null : event.currentTarget.value;
                setProfileWorkspaceRootId(next);
                void load(next);
              }}
            >
              <option value="__global__">Chat全局 / 空Workspace</option>
              {workspaces.map((workspace) => (
                <option value={workspace.rootId} key={workspace.rootId}>
                  {workspace.title}
                </option>
              ))}
            </select>
          </label>
          <small data-testid="lifeos-agent-profile-scope">
            {profileWorkspaceRootId === null
              ? "当前展示全局/空Workspace能力基线"
              : `当前展示 ${profileWorkspaceRootId} 的真实Workspace能力`}
          </small>
          <button
            type="button"
            onClick={() => void load(profileWorkspaceRootId)}
            disabled={status === "saving"}
          >
            刷新
          </button>
        </div>
      </header>
      {visibleError === null ? null : (
        <p className="lifeos-error" role="alert">
          {visibleError}
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
                <code className="lifeos-agent-runtime-package">
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
                  <AgentSourceFiles
                    paths={runtimeVariant.piSystemPrompt.sourceRelativePaths}
                    openers={promptStudio.sourceOpeners}
                    openSourceFile={openSourceFile}
                  />
                  <pre>{runtimeVariant.piSystemPrompt.bodyMarkdown}</pre>
                </details>
                {selected.runtimeBaseline.chatRuntimeAppend.appliesToVariantKeys.includes(
                  runtimeVariant.variantKey,
                ) ? (
                  <details>
                    <summary>
                      <strong>Chat运行约束（当前Variant会追加）</strong>
                      <span>
                        appendSystemPrompt · SHA{" "}
                        {selected.runtimeBaseline.chatRuntimeAppend.sha256.slice(0, 12)}
                      </span>
                    </summary>
                    <AgentSourceFiles
                      paths={[selected.runtimeBaseline.chatRuntimeAppend.sourceRelativePath]}
                      openers={promptStudio.sourceOpeners}
                      openSourceFile={openSourceFile}
                    />
                    <pre>{selected.runtimeBaseline.chatRuntimeAppend.bodyMarkdown}</pre>
                  </details>
                ) : (
                  <p className="lifeos-agent-runtime-description">
                    当前Pi默认Variant不追加Chat只读约束，保持与Pi CLI默认能力一致。
                  </p>
                )}
              </div>
              <section className="lifeos-agent-runtime-tools">
                <header>
                  <strong>当前Runtime可选 Tool 目录</strong>
                  <span>
                    {runtimeVariant.tools.length} 个可选 · {runtimeVariant.enabledToolNames.length}{" "}
                    个默认勾选
                  </span>
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
                      <AgentSourceFiles
                        paths={[tool.sourceRelativePath]}
                        openers={promptStudio.sourceOpeners}
                        openSourceFile={openSourceFile}
                      />
                      <p>
                        <code>{tool.capability.capabilityId}</code> · {tool.capability.effect} ·{" "}
                        {tool.capability.sourceRef.sourceKind} · descriptor{" "}
                        {tool.capability.descriptorSha256.slice(0, 12)}
                      </p>
                      <pre>{tool.parametersJson}</pre>
                    </details>
                  ))
                )}
              </section>
              {runtimeVariant.diagnostics.length === 0 ? null : (
                <div className="lifeos-warning" data-testid="lifeos-capability-diagnostics">
                  <strong>Runtime目录不可用</strong>
                  {runtimeVariant.diagnostics.map((diagnostic) => (
                    <p key={`${diagnostic.code}:${diagnostic.sourcePath ?? ""}`}>
                      {diagnostic.code}：{diagnostic.message}
                    </p>
                  ))}
                </div>
              )}
              <RuntimeResourceInventory inventory={runtimeVariant.resourceInventory} />
              <p className="lifeos-agent-runtime-note">
                {selected.runtimeBaseline.finalReviewNote}
              </p>
            </section>
          )}
          {selected.runtimeBaseline !== undefined && !canManageVersions ? (
            <p className="lifeos-agent-runtime-note" data-testid="lifeos-agent-version-readonly">
              当前Agent只读展示真实Runtime基线；尚未开放可执行的Agent Version创建与Workflow绑定。
            </p>
          ) : null}
          {selected.runtimeBaseline === undefined ||
          runtimeVariant === null ||
          !canManageVersions ? null : (
            <section className="lifeos-agent-version-manager" data-testid="lifeos-agent-versions">
              <header>
                <div>
                  <h4>Agent Version</h4>
                  <p>
                    Pi默认能力是基线；每次保存都会创建不可变Version。可用能力与调用审批分离，审批策略不在Prompt里授权。
                  </p>
                </div>
                <button type="button" onClick={() => editVersion(selected, null)}>
                  新建版本
                </button>
              </header>
              <nav aria-label="Agent Version列表" className="lifeos-agent-version-list">
                <button
                  type="button"
                  data-active={selectedVersionId === null ? "true" : "false"}
                  onClick={() => editVersion(selected, null)}
                >
                  <strong>Pi 默认基线</strong>
                  <small>{runtimeVariant.variantKey}</small>
                </button>
                {selected.versions.map((version) => (
                  <button
                    type="button"
                    key={version.agentVersionId}
                    data-active={selectedVersionId === version.agentVersionId ? "true" : "false"}
                    onClick={() => editVersion(selected, version)}
                  >
                    <strong>{version.title}</strong>
                    <small>
                      v{version.version} · {version.scope.kind === "global" ? "Chat" : "Workspace"}
                    </small>
                  </button>
                ))}
              </nav>
              {selectedAgentVersion === null ? null : (
                <dl className="lifeos-agent-version-identity">
                  <div>
                    <dt>Version事实</dt>
                    <dd>
                      <code>{selectedAgentVersion.agentVersionId}</code>
                      <code>SHA {selectedAgentVersion.sha256.slice(0, 12)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Pi基线</dt>
                    <dd>
                      <code>
                        {selectedAgentVersion.baselineRef.packageName}@
                        {selectedAgentVersion.baselineRef.packageVersion}
                      </code>
                      <code>
                        source {selectedAgentVersion.baselineRef.managedSourceRevision.slice(0, 12)}
                      </code>
                      <code>
                        catalog{" "}
                        {selectedAgentVersion.baselineRef.capabilityCatalogSha256.slice(0, 12)}
                      </code>
                    </dd>
                  </div>
                </dl>
              )}
              <div className="lifeos-agent-version-grid">
                <label>
                  名称
                  <input
                    aria-label="Agent Version名称"
                    value={versionTitle}
                    maxLength={160}
                    onChange={(event) => setVersionTitle(event.currentTarget.value)}
                  />
                </label>
                <label>
                  范围
                  <select
                    aria-label="Agent Version范围"
                    value={versionScopeKind}
                    onChange={(event) =>
                      setVersionScopeKind(event.currentTarget.value as "global" | "workspace")
                    }
                  >
                    <option value="global">Chat 全局</option>
                    <option value="workspace">目标工作区</option>
                  </select>
                </label>
                <label className="lifeos-agent-version-wide">
                  说明
                  <input
                    aria-label="Agent Version说明"
                    value={versionDescription}
                    maxLength={1000}
                    onChange={(event) => setVersionDescription(event.currentTarget.value)}
                  />
                </label>
                {versionScopeKind === "workspace" ? (
                  <label className="lifeos-agent-version-wide">
                    工作区
                    <select
                      aria-label="Agent Version工作区"
                      value={versionWorkspaceRootId}
                      onChange={(event) => setVersionWorkspaceRootId(event.currentTarget.value)}
                    >
                      <option value="">请选择工作区</option>
                      {workspaces.map((workspace) => (
                        <option value={workspace.rootId} key={workspace.rootId}>
                          {workspace.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="lifeos-agent-version-wide">
                  Pi Runtime Variant
                  <select
                    aria-label="Pi Runtime Variant"
                    value={runtimeVariant.variantKey}
                    onChange={(event) => {
                      const next = selected.runtimeBaseline?.variants.find(
                        (variant) => variant.variantKey === event.currentTarget.value,
                      );
                      setRuntimeVariantKey(event.currentTarget.value);
                      if (next !== undefined) setVersionTools(next.enabledToolNames);
                    }}
                  >
                    {selected.runtimeBaseline.variants.map((variant) => (
                      <option value={variant.variantKey} key={variant.variantKey}>
                        {variant.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="lifeos-agent-version-prompt">
                <legend>System Prompt</legend>
                <label>
                  <input
                    type="radio"
                    checked={versionPromptMode === "inherit_runtime"}
                    onChange={() => setVersionPromptMode("inherit_runtime")}
                  />
                  继承所选Pi运行时默认
                </label>
                <label>
                  <input
                    type="radio"
                    checked={versionPromptMode === "replace"}
                    onChange={() => setVersionPromptMode("replace")}
                  />
                  使用完整替换正文
                </label>
                {versionPromptMode === "replace" ? (
                  <textarea
                    aria-label="Agent Version System Prompt"
                    value={versionPrompt}
                    placeholder="输入发给Pi Coding Agent的完整System Prompt"
                    onChange={(event) => setVersionPrompt(event.currentTarget.value)}
                  />
                ) : (
                  <pre>{runtimeVariant.piSystemPrompt.bodyMarkdown}</pre>
                )}
              </fieldset>
              <fieldset className="lifeos-agent-version-capabilities">
                <legend>可选工具目录</legend>
                <p>
                  目录来自当前Runtime
                  Variant；勾选决定本Version向模型暴露哪些工具，具体调用是否需要审批由运行策略另行决定。
                </p>
                <div>
                  {runtimeVariant.tools.map((tool) => (
                    <label key={tool.name} title={tool.description}>
                      <input
                        type="checkbox"
                        checked={versionTools.includes(tool.name)}
                        onChange={(event) =>
                          setVersionTools((current) =>
                            event.currentTarget.checked
                              ? runtimeVariant.tools
                                  .map((candidate) => candidate.name)
                                  .filter(
                                    (candidate) =>
                                      current.includes(candidate) || candidate === tool.name,
                                  )
                              : current.filter((candidate) => candidate !== tool.name),
                          )
                        }
                      />
                      <code>{tool.name}</code>
                    </label>
                  ))}
                </div>
              </fieldset>
              <RuntimeResourceInventory inventory={runtimeVariant.resourceInventory} />
              <fieldset className="lifeos-agent-version-capabilities">
                <legend>运行时资源</legend>
                <p>下列开关按整类继承或禁用；上方清单仅展示当前Runtime实际发现的资源。</p>
                <div>
                  {(Object.keys(RESOURCE_LABEL) as Array<keyof AgentResources>).map((resource) => (
                    <label key={resource}>
                      <input
                        type="checkbox"
                        checked={versionResources[resource] === "inherit_runtime_default"}
                        onChange={(event) =>
                          setVersionResources((current) => ({
                            ...current,
                            [resource]: event.currentTarget.checked
                              ? "inherit_runtime_default"
                              : "disabled",
                          }))
                        }
                      />
                      {RESOURCE_LABEL[resource]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="lifeos-agent-settings-actions">
                <span>
                  {selectedVersionId === null ? "从Pi默认基线新建" : "基于所选Version创建后继版本"}
                </span>
                <button
                  type="button"
                  className="lifeos-primary"
                  disabled={
                    status === "saving" ||
                    versionTitle.trim() === "" ||
                    versionDescription.trim() === "" ||
                    (versionPromptMode === "replace" && versionPrompt === "")
                  }
                  onClick={() => void saveVersion()}
                >
                  {status === "saving" ? "正在保存…" : "保存为新 Agent Version"}
                </button>
              </div>
            </section>
          )}
          <details className="lifeos-agent-legacy-prompt">
            <summary>
              <strong>旧默认 Prompt Revision（兼容入口）</strong>
              <span>只修改旧Agent默认Prompt；不会覆盖或改写Agent Version</span>
            </summary>
            {selected.systemPrompt.source === "runtime_default" ? null : (
              <AgentSourceFiles
                paths={[selected.systemPrompt.sourceRelativePath]}
                openers={promptStudio.sourceOpeners}
                openSourceFile={openSourceFile}
              />
            )}
            <label>
              旧默认 System Prompt
              <textarea
                aria-label="旧默认 Agent System Prompt"
                value={draft}
                placeholder={
                  selected.systemPrompt.source === "runtime_default"
                    ? "当前继承Pi默认；此兼容入口保存后只更新旧默认Prompt。"
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
                disabled={
                  status === "saving" ||
                  draft.trim() === "" ||
                  (selected.systemPrompt.source !== "runtime_default" &&
                    draft === selected.systemPrompt.bodyMarkdown)
                }
                onClick={() => void save()}
              >
                {status === "saving" ? "正在保存…" : "保存旧Prompt Revision"}
              </button>
            </div>
          </details>
          {selected.runtimeBaseline !== undefined ? null : (
            <section className="lifeos-agent-tools">
              <header>
                <h4>可用工具</h4>
                <span>展示Runtime提供的可用能力；调用审批由运行策略另行决定</span>
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
