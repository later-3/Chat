import { useEffect, useMemo, useState } from "react";
import type { HostObservable, InjectFace } from "@deepseek-ai/dsh-client-ui-slots";
import type { SettingsSectionOwnerProps } from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  MemoryAgentEvidenceRef,
  MemoryAgentWriteCandidate,
  MemorySessionSourceRef,
} from "@chat/contracts/public";
import type { MemoryManagementState } from "./memory-management-controller.ts";

export interface MemoryManagementInjected {
  hooks: { memoryManagement: HostObservable<MemoryManagementState> };
  refresh: () => Promise<void>;
  selectCandidate: (candidateId: string) => Promise<void>;
  closeCandidate: () => void;
  decideCandidate: (kind: "approve" | "reject", reason?: string) => Promise<void>;
  loadSources: (kind: "chat" | "codex") => Promise<void>;
  selectSource: (source: MemorySessionSourceRef) => void;
  previewImport: (providerId: string) => Promise<void>;
  createImport: () => Promise<void>;
  compare: (input: {
    query: string;
    providerIds: readonly string[];
    maxResults?: number;
    maxContextCharacters?: number;
  }) => Promise<void>;
}

export type MemoryManagementProps = SettingsSectionOwnerProps &
  InjectFace<MemoryManagementInjected>;
type Tab = "candidates" | "comparison" | "imports";

function sourceKey(source: MemorySessionSourceRef): string {
  return source.kind === "chat"
    ? `chat:${source.productSessionId}`
    : `codex:${source.codexSessionId}`;
}

function evidenceLabel(evidence: MemoryAgentEvidenceRef): string {
  return evidence.kind === "message"
    ? `Chat Message · ${evidence.role} · ${evidence.messageId}`
    : `Direct Agent Candidate · ${evidence.directAgentCandidateId}`;
}

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

function SourcePicker({
  state,
  loadSources,
  selectSource,
  disabled,
}: Pick<MemoryManagementProps, "loadSources" | "selectSource"> & {
  state: MemoryManagementState;
  disabled: boolean;
}) {
  const selectedKey = state.selectedSource === null ? "" : sourceKey(state.selectedSource);
  return (
    <div className="lifeos-memory-source-picker">
      <label>
        会话来源
        <select
          value={state.sourceKind}
          disabled={disabled}
          onChange={(event) => void loadSources(event.currentTarget.value as "chat" | "codex")}
        >
          <option value="chat">Chat Session</option>
          <option value="codex">Codex Session</option>
        </select>
      </label>
      <label>
        具体会话
        <select
          value={selectedKey}
          disabled={disabled || state.sourcesStatus === "loading" || state.sources.length === 0}
          onChange={(event) => {
            const source = state.sources.find(
              (item) => sourceKey(item.source) === event.currentTarget.value,
            )?.source;
            if (source !== undefined) selectSource(source);
          }}
        >
          {state.sources.length === 0 ? <option value="">没有可用来源</option> : null}
          {state.sources.map((source) => (
            <option value={sourceKey(source.source)} key={sourceKey(source.source)}>
              {source.title} · {dateTime(source.updatedAt)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        disabled={disabled || state.sourcesStatus === "loading"}
        onClick={() => void loadSources(state.sourceKind)}
      >
        {state.sourcesStatus === "loading" ? "读取中…" : "刷新来源"}
      </button>
    </div>
  );
}

function CandidateDetail({
  candidate,
  saving,
  closeCandidate,
  decideCandidate,
}: Pick<MemoryManagementProps, "closeCandidate" | "decideCandidate"> & {
  candidate: MemoryAgentWriteCandidate;
  saving: boolean;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => setReason(""), [candidate.memoryAgentWriteCandidateId, candidate.revision]);
  return (
    <article className="lifeos-memory-detail" data-testid="lifeos-memory-candidate-detail">
      <header>
        <div>
          <small>Memory 写入候选</small>
          <h2>{candidate.items.length} 项待审核内容</h2>
        </div>
        <button type="button" disabled={saving} onClick={closeCandidate}>
          关闭详情
        </button>
      </header>
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{candidate.providerId}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{candidate.status}</dd>
        </div>
        <div>
          <dt>候选版本</dt>
          <dd>v{candidate.revision}</dd>
        </div>
        <div>
          <dt>Hash</dt>
          <dd>
            <code>{candidate.sha256}</code>
          </dd>
        </div>
      </dl>
      <div className="lifeos-memory-candidate-items">
        {candidate.items.map((item) => (
          <details key={item.itemKey} open>
            <summary>
              <span>
                <strong>{item.title}</strong>
                <small>{item.category}</small>
              </span>
              <code>{item.itemKey}</code>
            </summary>
            <div className="lifeos-memory-labels">
              {item.labels.map((label) => (
                <span key={label}>{label}</span>
              ))}
            </div>
            <pre>{item.content}</pre>
            <div className="lifeos-memory-evidence" aria-label="候选证据">
              <strong>证据引用</strong>
              {item.evidenceRefs.map((evidence) => (
                <code key={evidenceLabel(evidence)}>{evidenceLabel(evidence)}</code>
              ))}
            </div>
          </details>
        ))}
      </div>
      {candidate.status !== "pending_review" ? (
        <p className="lifeos-memory-note">该候选已完成决定，当前详情只读。</p>
      ) : (
        <footer className="lifeos-memory-actions">
          <label>
            拒绝说明（可选）
            <textarea value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
          </label>
          <div>
            <button
              type="button"
              disabled={saving}
              onClick={() => void decideCandidate("reject", reason).catch(() => undefined)}
            >
              拒绝候选
            </button>
            <button
              type="button"
              className="lifeos-primary"
              disabled={saving}
              onClick={() => void decideCandidate("approve").catch(() => undefined)}
            >
              批准并创建写入
            </button>
          </div>
        </footer>
      )}
    </article>
  );
}

function CandidatesTab({
  state,
  selectCandidate,
  closeCandidate,
  decideCandidate,
}: Pick<MemoryManagementProps, "selectCandidate" | "closeCandidate" | "decideCandidate"> & {
  state: MemoryManagementState;
}) {
  if (state.selectedCandidate !== null) {
    return (
      <CandidateDetail
        candidate={state.selectedCandidate}
        saving={state.saving}
        closeCandidate={closeCandidate}
        decideCandidate={decideCandidate}
      />
    );
  }
  return (
    <section className="lifeos-memory-list" data-testid="lifeos-memory-candidates">
      <p className="lifeos-memory-note">
        Agent 提案只会形成候选；批准时将当前观察到的版本与 Hash 一并提交给 Chat。
      </p>
      {state.candidates.length === 0 ? (
        <p className="lifeos-memory-empty">目前没有待审核的 Memory 写入候选。</p>
      ) : (
        state.candidates.map((candidate) => (
          <button
            className="lifeos-memory-list-card"
            type="button"
            key={candidate.memoryAgentWriteCandidateId}
            disabled={state.saving}
            onClick={() => void selectCandidate(candidate.memoryAgentWriteCandidateId)}
          >
            <span>
              <strong>{candidate.items.map((item) => item.title).join("、")}</strong>
              <small>
                {candidate.items.length} 项 · {candidate.providerId}
              </small>
            </span>
            <code>v{candidate.revision}</code>
          </button>
        ))
      )}
    </section>
  );
}

function ComparisonTab({
  state,
  loadSources,
  selectSource,
  compare,
}: Pick<MemoryManagementProps, "loadSources" | "selectSource" | "compare"> & {
  state: MemoryManagementState;
}) {
  const [query, setQuery] = useState("");
  const [providerIds, setProviderIds] = useState<readonly string[]>([]);
  useEffect(() => {
    setProviderIds((current) => {
      const valid = current.filter((id) =>
        state.providers.some((provider) => provider.providerId === id),
      );
      return valid.length >= 2
        ? valid
        : state.providers.slice(0, 2).map((provider) => provider.providerId);
    });
  }, [state.providers]);
  const toggleProvider = (providerId: string) => {
    setProviderIds((current) =>
      current.includes(providerId)
        ? current.filter((item) => item !== providerId)
        : current.length >= 4
          ? current
          : [...current, providerId],
    );
  };
  return (
    <section className="lifeos-memory-panel" data-testid="lifeos-memory-comparison">
      <p className="lifeos-memory-note">
        比较是只读 Preview：各 Provider 独立返回成功或失败，分数只在各自实现内展示。
      </p>
      <SourcePicker
        state={state}
        loadSources={loadSources}
        selectSource={selectSource}
        disabled={state.saving}
      />
      <label className="lifeos-memory-field">
        查询内容
        <textarea
          value={query}
          placeholder="例如：发布前需要完成什么？"
          disabled={state.saving}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <fieldset className="lifeos-memory-provider-options">
        <legend>选择 2–4 个 Provider</legend>
        {state.providers.map((provider) => (
          <label key={provider.providerId}>
            <input
              type="checkbox"
              checked={providerIds.includes(provider.providerId)}
              disabled={state.saving}
              onChange={() => toggleProvider(provider.providerId)}
            />
            <span>{provider.displayName}</span>
            <code>{provider.writeMaterialization ?? "仅查询"}</code>
          </label>
        ))}
      </fieldset>
      <div className="lifeos-memory-actions">
        <button
          type="button"
          className="lifeos-primary"
          disabled={
            state.saving ||
            query.trim() === "" ||
            providerIds.length < 2 ||
            state.selectedSource === null
          }
          onClick={() => void compare({ query, providerIds }).catch(() => undefined)}
        >
          {state.saving ? "比较中…" : "开始比较"}
        </button>
      </div>
      {state.comparison === null ? null : (
        <div className="lifeos-memory-comparison-result">
          <header>
            <strong>{state.comparison.sourceTitle}</strong>
            <span>{state.comparison.providers.length} 个 Provider</span>
          </header>
          {state.comparison.providers.map((provider) => (
            <article key={provider.providerId} data-status={provider.status}>
              <header>
                <strong>{provider.displayName}</strong>
                <code>{provider.providerId}</code>
              </header>
              {provider.status === "failed" ? (
                <p className="lifeos-error">
                  {provider.errorCode} · {provider.retryable ? "可重试" : "不可重试"}
                </p>
              ) : (
                <>
                  <p>
                    {provider.hitCount} 命中，采用 {provider.selectedCount} 项，共{" "}
                    {provider.selectedCharacters} 字符。
                  </p>
                  {provider.items.map((item) => (
                    <details key={item.contentSha256}>
                      <summary>
                        <span>{item.title}</span>
                        {item.providerScore === undefined ? null : (
                          <small>Provider score: {item.providerScore}</small>
                        )}
                      </summary>
                      <pre>{item.content}</pre>
                    </details>
                  ))}
                </>
              )}
            </article>
          ))}
          <section className="lifeos-memory-pairwise">
            <strong>交集与唯一项</strong>
            {state.comparison.pairwise.map((pair) => (
              <p key={`${pair.leftProviderId}:${pair.rightProviderId}`}>
                {pair.leftProviderId} / {pair.rightProviderId}：精确正文交集{" "}
                {pair.exactContentOverlapCount}， 左侧唯一 {pair.leftUniqueContentCount}，右侧唯一{" "}
                {pair.rightUniqueContentCount}；不允许比较分数。
              </p>
            ))}
          </section>
        </div>
      )}
    </section>
  );
}

function ImportsTab({
  state,
  loadSources,
  selectSource,
  previewImport,
  createImport,
}: Pick<
  MemoryManagementProps,
  "loadSources" | "selectSource" | "previewImport" | "createImport"
> & {
  state: MemoryManagementState;
}) {
  const [providerId, setProviderId] = useState("");
  useEffect(() => {
    if (state.providers.some((provider) => provider.providerId === providerId)) return;
    setProviderId(state.providers[0]?.providerId ?? "");
  }, [providerId, state.providers]);
  return (
    <section className="lifeos-memory-panel" data-testid="lifeos-memory-imports">
      <p className="lifeos-memory-note">
        导入先进行零写入 Preview；创建时只采用当前 Preview 冻结的来源快照与预览 Hash。
      </p>
      <SourcePicker
        state={state}
        loadSources={loadSources}
        selectSource={selectSource}
        disabled={state.saving}
      />
      <label className="lifeos-memory-field">
        写入 Provider
        <select
          value={providerId}
          disabled={state.saving || providerId === ""}
          onChange={(event) => setProviderId(event.currentTarget.value)}
        >
          {state.providers.length === 0 ? <option value="">没有可用 Provider</option> : null}
          {state.providers.map((provider) => (
            <option key={provider.providerId} value={provider.providerId}>
              {provider.displayName} · {provider.writeMaterialization ?? "不可写"}
            </option>
          ))}
        </select>
      </label>
      <div className="lifeos-memory-actions">
        <button
          type="button"
          disabled={state.saving || state.selectedSource === null || providerId === ""}
          onClick={() => void previewImport(providerId)}
        >
          {state.saving ? "处理中…" : "预览导入"}
        </button>
      </div>
      {state.importPreview === null ? null : (
        <section className="lifeos-memory-import-preview">
          <header>
            <div>
              <strong>{state.importPreview.sourceTitle}</strong>
              <small>{state.importPreview.providerDisplayName}</small>
            </div>
            <span>
              新增 {state.importPreview.newItemCount}，已存在{" "}
              {state.importPreview.existingItemCount}
            </span>
          </header>
          <div>
            {state.importPreview.items.map((item) => (
              <details key={item.sourceItemKey}>
                <summary>
                  <span>{item.title}</span>
                  <small>
                    {item.alreadyImported ? "已导入" : "将导入"} · {item.contentCharacters} 字符
                  </small>
                </summary>
                <pre>{item.contentPreview}</pre>
              </details>
            ))}
          </div>
          <footer className="lifeos-memory-actions">
            <button
              type="button"
              className="lifeos-primary"
              disabled={state.saving}
              onClick={() => void createImport().catch(() => undefined)}
            >
              确认创建导入批次
            </button>
          </footer>
        </section>
      )}
      <section className="lifeos-memory-import-history">
        <h2>导入批次</h2>
        {state.imports.length === 0 ? (
          <p className="lifeos-memory-empty">还没有导入批次。</p>
        ) : (
          state.imports.map((item) => (
            <article key={item.memorySessionImportId}>
              <header>
                <strong>{item.sourceTitle}</strong>
                <span data-status={item.status}>{item.status}</span>
              </header>
              <p>
                {item.providerDisplayName} · 新增 {item.createdItemCount} · 已存在{" "}
                {item.existingItemCount}
              </p>
              {item.status === "needs_attention" ? (
                <p className="lifeos-warning">存在结果未知或失败项，需要在后续对账表面处理。</p>
              ) : null}
            </article>
          ))
        )}
      </section>
    </section>
  );
}

/** 全局管理表面：不把跨会话 Memory 事实塞入 DSH Composer 或 Session Dock。 */
export function MemoryManagement({
  useMemoryManagement,
  refresh,
  selectCandidate,
  closeCandidate,
  decideCandidate,
  loadSources,
  selectSource,
  previewImport,
  createImport,
  compare,
}: MemoryManagementProps) {
  const state = useMemoryManagement((value) => value);
  const [tab, setTab] = useState<Tab>("candidates");
  useEffect(() => {
    if (state.sourcesStatus === "idle") void loadSources(state.sourceKind);
  }, [loadSources, state.sourceKind, state.sourcesStatus]);
  const pendingCount = useMemo(
    () => state.candidates.filter((candidate) => candidate.status === "pending_review").length,
    [state.candidates],
  );
  return (
    <section className="lifeos-memory-management" data-testid="lifeos-memory-management">
      <header>
        <div>
          <h1>Memory</h1>
          <p>审核 Agent 写入候选、只读比较 Provider，并按冻结快照导入会话。</p>
        </div>
        <button
          type="button"
          disabled={state.saving || state.status === "loading"}
          onClick={() => void refresh()}
        >
          {state.status === "loading" ? "刷新中…" : "刷新"}
        </button>
      </header>
      {state.error === null ? null : (
        <p className="lifeos-memory-error" role="alert">
          {state.error}
        </p>
      )}
      <nav className="lifeos-memory-tabs" role="tablist" aria-label="Memory 管理">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "candidates"}
          onClick={() => setTab("candidates")}
        >
          写入候选{pendingCount === 0 ? "" : ` (${pendingCount})`}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "comparison"}
          onClick={() => setTab("comparison")}
        >
          Provider 比较
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "imports"}
          onClick={() => setTab("imports")}
        >
          Session 导入
        </button>
      </nav>
      {tab === "candidates" ? (
        <CandidatesTab
          state={state}
          selectCandidate={selectCandidate}
          closeCandidate={closeCandidate}
          decideCandidate={decideCandidate}
        />
      ) : null}
      {tab === "comparison" ? (
        <ComparisonTab
          state={state}
          loadSources={loadSources}
          selectSource={selectSource}
          compare={compare}
        />
      ) : null}
      {tab === "imports" ? (
        <ImportsTab
          state={state}
          loadSources={loadSources}
          selectSource={selectSource}
          previewImport={previewImport}
          createImport={createImport}
        />
      ) : null}
    </section>
  );
}
