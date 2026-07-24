import * as Dialog from "@radix-ui/react-dialog";
import { Check, ShieldAlert, Wrench, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { ToolExecutionReviewCard } from "./use-chat-agent";

interface ToolCallReviewProps {
  card: ToolExecutionReviewCard;
  busy: boolean;
  error: string | null;
  onApprove: (argumentsValue: Record<string, unknown>) => void;
  onAbandon: () => void;
}

function cloneArguments(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function ToolCallReview({ card, busy, error, onApprove, onAbandon }: ToolCallReviewProps) {
  const [argumentsValue, setArgumentsValue] = useState(() => cloneArguments(card.arguments));
  const [complexValues, setComplexValues] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    setArgumentsValue(cloneArguments(card.arguments));
    setComplexValues(
      Object.fromEntries(
        Object.entries(card.arguments)
          .filter(([, value]) => value !== null && typeof value === "object")
          .map(([key, value]) => [key, JSON.stringify(value, null, 2)]),
      ),
    );
    setEditError(null);
  }, [card]);

  const updateComplex = (key: string, raw: string) => {
    setComplexValues((value) => ({ ...value, [key]: raw }));
    try {
      const parsed = JSON.parse(raw) as unknown;
      setArgumentsValue((value) => ({ ...value, [key]: parsed }));
      setEditError(null);
    } catch {
      setEditError(`${key} 的结构化值不是有效JSON`);
    }
  };

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay tool-review-overlay" />
        <Dialog.Content className="dialog-content tool-review-dialog">
          <header className="tool-review-header">
            <span>
              <Wrench size={19} />
            </span>
            <div>
              <p className="eyebrow">PI 内部 TOOL · 执行前审批</p>
              <Dialog.Title>{card.tool_name}</Dialog.Title>
              <Dialog.Description>{card.message}</Dialog.Description>
            </div>
          </header>

          <div className="tool-review-facts">
            <div>
              <span>风险</span>
              <strong>
                <ShieldAlert size={14} />
                {card.risk}
              </strong>
            </div>
            <div>
              <span>工作目录</span>
              <code>{card.working_directory}</code>
            </div>
            <div>
              <span>Tool Call</span>
              <code>{card.tool_call_id}</code>
            </div>
            <div>
              <span>配置版本</span>
              <strong>r{card.config_revision}</strong>
            </div>
          </div>

          <section className="tool-argument-section">
            <div className="tool-argument-heading">
              <div>
                <strong>即将执行的参数</strong>
                <span>Key固定，所有Value可修改</span>
              </div>
              <small>修改只对本次Tool Call生效</small>
            </div>
            <div className="tool-argument-list">
              {Object.entries(argumentsValue).map(([key, value]) => (
                <label className="tool-argument-row" key={key}>
                  <span>
                    <strong>{key}</strong>
                    <small>{typeof value}</small>
                  </span>
                  {typeof value === "boolean" ? (
                    <select
                      disabled={busy}
                      onChange={(event) =>
                        setArgumentsValue((current) => ({
                          ...current,
                          [key]: event.target.value === "true",
                        }))
                      }
                      value={String(value)}
                    >
                      <option value="true">是（true）</option>
                      <option value="false">否（false）</option>
                    </select>
                  ) : typeof value === "number" ? (
                    <input
                      disabled={busy}
                      onChange={(event) =>
                        setArgumentsValue((current) => ({
                          ...current,
                          [key]: Number(event.target.value),
                        }))
                      }
                      type="number"
                      value={value}
                    />
                  ) : value !== null && typeof value === "object" ? (
                    <textarea
                      disabled={busy}
                      onChange={(event) => updateComplex(key, event.target.value)}
                      rows={5}
                      value={complexValues[key] ?? JSON.stringify(value, null, 2)}
                    />
                  ) : (
                    <textarea
                      disabled={busy}
                      onChange={(event) =>
                        setArgumentsValue((current) => ({
                          ...current,
                          [key]: event.target.value,
                        }))
                      }
                      rows={Math.max(2, String(value ?? "").split("\n").length)}
                      value={String(value ?? "")}
                    />
                  )}
                </label>
              ))}
            </div>
          </section>

          {(editError || error) && (
            <p className="workflow-error" role="alert">
              {editError ?? error}
            </p>
          )}
          <footer className="tool-review-actions">
            <button className="archive-button" disabled={busy} onClick={onAbandon} type="button">
              <X size={15} />
              放弃本次 pi 运行
            </button>
            <button
              className="save-settings-button"
              disabled={busy || Boolean(editError)}
              onClick={() => onApprove(argumentsValue)}
              type="button"
            >
              <Check size={15} />
              {busy ? "继续中…" : "确认参数并执行"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
