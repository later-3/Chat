import { Archive, Check, Copy } from "lucide-react";
import { useState } from "react";

import type { ModelProviderOption } from "../../use-chat-agent";
import { copyProductSessionId, productSessionLocator } from "../session/session-identifier";

export interface SessionSettingsView {
  id: string;
  revision: number;
}

export interface RunSettingsView {
  status: string;
  attempts: unknown[];
}

interface SessionSettingsPanelProps {
  interactionBusy: boolean;
  latestRun: RunSettingsView | null;
  model: string;
  onArchive: () => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
  provider: ModelProviderOption | null;
  providers: ModelProviderOption[];
  providerId: string;
  runLabel: (status: string) => string;
  saving: boolean;
  session: SessionSettingsView | null;
  title: string;
}

export function SessionSettingsPanel({
  interactionBusy,
  latestRun,
  model,
  onArchive,
  onModelChange,
  onProviderChange,
  onSave,
  onTitleChange,
  provider,
  providers,
  providerId,
  runLabel,
  saving,
  session,
  title,
}: SessionSettingsPanelProps) {
  const [sessionIdCopied, setSessionIdCopied] = useState(false);

  async function copySessionId(): Promise<void> {
    if (!session) return;
    await copyProductSessionId(session.id);
    setSessionIdCopied(true);
    window.setTimeout(() => setSessionIdCopied(false), 1800);
  }

  return (
    <section className="configuration-section session-configuration">
      <header>
        <p className="eyebrow">PRODUCT SESSION</p>
        <h2>当前会话</h2>
        <p>配置会话名称和默认模型。每次真实模型请求仍会单独进入发送前审批。</p>
      </header>
      <label className="settings-field">
        <span>会话名称</span>
        <input
          maxLength={160}
          onChange={(event) => onTitleChange(event.target.value)}
          value={title}
        />
      </label>
      {providers.length > 0 && (
        <div className="settings-grid">
          <label className="settings-field">
            <span>Provider</span>
            <select onChange={(event) => onProviderChange(event.target.value)} value={providerId}>
              <option value="">使用系统默认</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="settings-field">
            <span>模型</span>
            <select
              disabled={!provider}
              onChange={(event) => onModelChange(event.target.value)}
              value={model}
            >
              <option value="">选择模型</option>
              {provider?.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <dl className="system-grid session-facts">
        <div>
          <dt>Product Session ID</dt>
          <dd className="session-id-setting">
            <span className="mono">
              {session ? `${productSessionLocator(session.id)} · ${session.id}` : "—"}
            </span>
            {session && (
              <button
                aria-label="复制完整 Product Session ID"
                onClick={() => void copySessionId()}
                type="button"
              >
                {sessionIdCopied ? <Check size={14} /> : <Copy size={14} />}
                {sessionIdCopied ? "已复制" : "复制"}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>会话版本</dt>
          <dd>{session?.revision ?? "—"}</dd>
        </div>
        <div>
          <dt>最近 Product Run</dt>
          <dd>
            {latestRun
              ? `${runLabel(latestRun.status)} · ${latestRun.attempts.length} 次尝试`
              : "尚无"}
          </dd>
        </div>
      </dl>
      <div className="settings-actions">
        <button
          className="archive-button"
          disabled={saving || interactionBusy}
          onClick={onArchive}
          type="button"
        >
          <Archive size={15} />
          归档会话
        </button>
        <button
          className="save-settings-button"
          disabled={saving || !title.trim()}
          onClick={onSave}
          type="button"
        >
          {saving ? "保存中…" : "保存会话配置"}
        </button>
      </div>
    </section>
  );
}
