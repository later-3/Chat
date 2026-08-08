import { useMemo, useState } from "react";
import type { MemoryBackendProfileDto, SubmitMessagePayload } from "@chat/contracts/public";

type ContextSelection = SubmitMessagePayload["context"];
type MemorySelection = NonNullable<ContextSelection>["memory"];

const DEFAULT_LIMIT = 8;
const DEFAULT_CONTEXT_BUDGET = 1_800;

function defaultSelection(profile: MemoryBackendProfileDto): MemorySelection {
  return {
    backendId: profile.backendId,
    requirement: "optional",
    tags: [],
    layers: [...profile.capabilities.layers],
    limit: Math.min(DEFAULT_LIMIT, profile.capabilities.maxLimit),
    contextBudget: Math.min(DEFAULT_CONTEXT_BUDGET, profile.capabilities.maxContextBudget),
  };
}

function parseTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，]/u)
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0 && tag.length <= 64),
    ),
  ].slice(0, 20);
}

export function ContextPicker({
  backends,
  loading,
  disabled,
  value,
  onChange,
  expanded,
  onExpandedChange,
}: {
  backends: readonly MemoryBackendProfileDto[];
  loading: boolean;
  disabled: boolean;
  value: ContextSelection | undefined;
  onChange: (value: ContextSelection | undefined) => void;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const memory = value?.memory;
  const [tagsText, setTagsText] = useState(() => memory?.tags.join(", ") ?? "");
  const [limitText, setLimitText] = useState(() => String(memory?.limit ?? DEFAULT_LIMIT));
  const [budgetText, setBudgetText] = useState(() =>
    String(memory?.contextBudget ?? DEFAULT_CONTEXT_BUDGET),
  );
  const usableBackends = useMemo(
    () => backends.filter((backend) => backend.configured && backend.health === "ready"),
    [backends],
  );
  const selectedProfile =
    backends.find((backend) => backend.backendId === memory?.backendId) ?? usableBackends[0];

  const updateMemory = (next: MemorySelection) => onChange({ memory: next });
  const enabled = memory !== undefined;

  function toggleEnabled(checked: boolean) {
    if (!checked) {
      onChange(undefined);
      return;
    }
    const profile = usableBackends[0];
    if (profile !== undefined) {
      const selection = defaultSelection(profile);
      setTagsText("");
      setLimitText(String(selection.limit));
      setBudgetText(String(selection.contextBudget));
      updateMemory(selection);
    }
  }

  function switchBackend(backendId: string) {
    const profile = usableBackends.find((backend) => backend.backendId === backendId);
    if (profile !== undefined) {
      const selection = defaultSelection(profile);
      setTagsText("");
      setLimitText(String(selection.limit));
      setBudgetText(String(selection.contextBudget));
      updateMemory(selection);
    }
  }

  return (
    <div className="context-picker" aria-label="本轮上下文">
      <button
        type="button"
        className="context-picker-trigger"
        aria-expanded={expanded}
        aria-controls="memory-context-editor"
        onClick={() => onExpandedChange(!expanded)}
      >
        <span>
          <strong>上下文</strong>
          <small>
            {loading
              ? "正在读取后端…"
              : usableBackends.length === 0
                ? "memmy 尚未就绪"
                : enabled
                  ? `${selectedProfile?.displayName ?? "Memory"} · ${memory.requirement === "required" ? "必需" : "可选"}`
                  : "本轮不查询 Memory"}
          </small>
        </span>
        <span aria-hidden="true">{expanded ? "收起" : "编辑"}</span>
      </button>

      {expanded && (
        <section
          id="memory-context-editor"
          className="context-picker-panel"
          aria-label="Memory 上下文设置"
        >
          <header>
            <strong>本轮 Memory 上下文</strong>
            <button
              type="button"
              onClick={() => onExpandedChange(false)}
              aria-label="关闭上下文设置"
            >
              完成
            </button>
          </header>
          <label className="context-enable-row">
            <input
              type="checkbox"
              checked={enabled}
              disabled={disabled || loading || usableBackends.length === 0}
              onChange={(event) => toggleEnabled(event.target.checked)}
            />
            <span>
              <strong>使用 Memory 上下文</strong>
              <small>
                {loading
                  ? "正在读取后端…"
                  : usableBackends.length === 0
                    ? "memmy 尚未就绪"
                    : enabled
                      ? "本轮查询已启用"
                      : "本轮不查询"}
              </small>
            </span>
          </label>

          {enabled && memory !== undefined && selectedProfile !== undefined && (
            <div className="context-picker-options">
              <label>
                <span>后端</span>
                <select
                  aria-label="Memory 后端"
                  value={memory.backendId}
                  disabled={disabled}
                  onChange={(event) => switchBackend(event.target.value)}
                >
                  {usableBackends.map((backend) => (
                    <option key={backend.backendId} value={backend.backendId}>
                      {backend.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>失败策略</span>
                <select
                  aria-label="Memory 失败策略"
                  value={memory.requirement}
                  disabled={disabled}
                  onChange={(event) =>
                    updateMemory({
                      ...memory,
                      requirement: event.target.value === "required" ? "required" : "optional",
                    })
                  }
                >
                  <option value="optional">可选：失败后继续规划</option>
                  <option value="required">必需：失败时停止</option>
                </select>
              </label>
              <label className="context-tags-field">
                <span>标签（逗号分隔）</span>
                <input
                  aria-label="Memory 标签"
                  value={tagsText}
                  disabled={disabled}
                  placeholder="例如：项目, 决策"
                  onChange={(event) => {
                    setTagsText(event.target.value);
                    updateMemory({ ...memory, tags: parseTags(event.target.value) });
                  }}
                />
              </label>
              <fieldset className="context-layers">
                <legend>层级</legend>
                {selectedProfile.capabilities.layers.map((layer) => (
                  <label key={layer}>
                    <input
                      type="checkbox"
                      checked={memory.layers.includes(layer)}
                      disabled={
                        disabled || (memory.layers.length === 1 && memory.layers[0] === layer)
                      }
                      onChange={(event) => {
                        const layers = event.target.checked
                          ? [...memory.layers, layer]
                          : memory.layers.filter((candidate) => candidate !== layer);
                        updateMemory({
                          ...memory,
                          layers: selectedProfile.capabilities.layers.filter((candidate) =>
                            layers.includes(candidate),
                          ),
                        });
                      }}
                    />
                    <span>{layer}</span>
                  </label>
                ))}
              </fieldset>
              <label>
                <span>最多采用</span>
                <input
                  aria-label="Memory 条目上限"
                  type="number"
                  min={1}
                  max={Math.min(20, selectedProfile.capabilities.maxLimit)}
                  value={limitText}
                  disabled={disabled}
                  onChange={(event) => setLimitText(event.target.value)}
                  onBlur={() => {
                    const maximum = Math.min(20, selectedProfile.capabilities.maxLimit);
                    const limit = Math.max(1, Math.min(maximum, Number(limitText) || 1));
                    setLimitText(String(limit));
                    updateMemory({ ...memory, limit });
                  }}
                />
              </label>
              <label>
                <span>上下文预算</span>
                <input
                  aria-label="Memory 上下文预算"
                  type="number"
                  min={128}
                  max={Math.min(8_192, selectedProfile.capabilities.maxContextBudget)}
                  step={128}
                  value={budgetText}
                  disabled={disabled}
                  onChange={(event) => setBudgetText(event.target.value)}
                  onBlur={() => {
                    const maximum = Math.min(8_192, selectedProfile.capabilities.maxContextBudget);
                    const contextBudget = Math.max(
                      128,
                      Math.min(maximum, Number(budgetText) || 128),
                    );
                    setBudgetText(String(contextBudget));
                    updateMemory({ ...memory, contextBudget });
                  }}
                />
              </label>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
