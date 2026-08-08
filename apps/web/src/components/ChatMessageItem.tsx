import { useEffect, useMemo, useRef, useState } from "react";
import type {
  CreateMemoryImportPayload,
  MemoryBackendProfileDto,
  MemoryImportDto,
  MessageDto,
} from "@chat/contracts/public";
import type { RealChainState } from "../real/use-real-chain.js";

interface TextRangeSelection {
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly text: string;
}

function selectedRangeWithin(element: HTMLElement): TextRangeSelection | null | "invalid" {
  const selection = window.getSelection();
  if (selection === null || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return "invalid";
  const before = document.createRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  const text = range.toString();
  if (text.trim().length === 0) return null;
  const startUtf16 = before.toString().length;
  return { startUtf16, endUtf16: startUtf16 + text.length, text };
}

async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const STATUS_LABEL: Record<MemoryImportDto["status"], string> = {
  queued: "等待写入",
  dispatching: "正在写入",
  accepted: "已接收，正在验证",
  materialized: "已写入并可查询",
  failed: "写入失败",
  outcome_unknown: "写入结果未知",
};

function importStatusLabel(
  item: MemoryImportDto,
  backends: readonly MemoryBackendProfileDto[],
): string {
  if (
    item.status === "accepted" &&
    backends.find((backend) => backend.backendId === item.backendId)?.kind === "tencent_memorycore"
  ) {
    return "已接收，等待异步提炼";
  }
  return STATUS_LABEL[item.status];
}

function latestImport(imports: readonly MemoryImportDto[], messageId: string) {
  return imports
    .filter((item) => item.sourceMessageId === messageId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function ChatMessageItem({
  message,
  chain,
  backends,
}: {
  message: MessageDto;
  chain: RealChainState;
  backends: readonly MemoryBackendProfileDto[];
}) {
  const contentRef = useRef<HTMLPreElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // 按钮获得焦点时浏览器可能清除选区，pointerdown先冻结本次用户选择。
  const pendingSelectionRef = useRef<TextRangeSelection | null | "invalid" | undefined>(undefined);
  const importBackends = useMemo(
    () => backends.filter((backend) => backend.capabilities.import !== undefined),
    [backends],
  );
  const availableImportBackends = useMemo(
    () => importBackends.filter((backend) => backend.configured && backend.health === "ready"),
    [importBackends],
  );
  const [dialogSelection, setDialogSelection] = useState<TextRangeSelection | null | undefined>();
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [backendId, setBackendId] = useState("");
  const [submittedHere, setSubmittedHere] = useState(false);
  const [preparingImport, setPreparingImport] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const currentImport = latestImport(chain.memoryImports.data ?? [], message.messageId);
  const selectedImportBackend = importBackends.find((backend) => backend.backendId === backendId);
  const pendingForMessage =
    chain.pendingMemoryImport?.payload.sourceSelection.sourceMessageId === message.messageId;

  function closeImportDialog() {
    setDialogSelection(undefined);
    queueMicrotask(() => triggerRef.current?.focus());
  }

  function openImportDialog() {
    if (message.sha256 === undefined || importBackends.length === 0) return;
    const selection =
      pendingSelectionRef.current !== undefined
        ? pendingSelectionRef.current
        : contentRef.current === null
          ? null
          : selectedRangeWithin(contentRef.current);
    pendingSelectionRef.current = undefined;
    if (selection === "invalid") {
      setSelectionError("选区必须完整位于这一条消息内，请重新选择。");
      return;
    }
    setSelectionError(null);
    setDialogSelection(selection);
    setTitle(message.content.text.split("\n")[0]?.trim().slice(0, 120) || "会话事实");
    setTagsText("");
    setBackendId(availableImportBackends[0]?.backendId ?? "");
    setSubmittedHere(false);
  }

  useEffect(() => {
    if (dialogSelection === undefined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeImportDialog();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const controls = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ];
      const first = controls[0];
      const last = controls.at(-1);
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [dialogSelection]);

  async function confirmImport() {
    if (
      message.sha256 === undefined ||
      backendId === "" ||
      title.trim() === "" ||
      dialogSelection === undefined ||
      preparingImport
    )
      return;
    setPreparingImport(true);
    try {
      const sourceSelection: CreateMemoryImportPayload["sourceSelection"] =
        dialogSelection === null
          ? {
              kind: "full_message",
              sourceMessageId: message.messageId,
              sourceMessageSha256: message.sha256,
            }
          : {
              kind: "utf16_range",
              sourceMessageId: message.messageId,
              sourceMessageSha256: message.sha256,
              startUtf16: dialogSelection.startUtf16,
              endUtf16: dialogSelection.endUtf16,
              selectedTextSha256: (await sha256Text(dialogSelection.text)) as never,
            };
      chain.importMemory({
        sourceSelection,
        backendId: backendId as never,
        title: title.trim(),
        tags: tagsText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      });
      setSubmittedHere(true);
      closeImportDialog();
    } finally {
      setPreparingImport(false);
    }
  }

  return (
    <li className="chat-message" data-role={message.role}>
      {message.role === "assistant" && <span className="message-author">Assistant</span>}
      <div className="message-bubble">
        <pre className="message-markdown" ref={contentRef}>
          {message.content.text}
        </pre>
      </div>
      <div className="message-actions">
        <button
          ref={triggerRef}
          className="message-action-button"
          onPointerDown={() => {
            pendingSelectionRef.current =
              contentRef.current === null ? null : selectedRangeWithin(contentRef.current);
          }}
          onClick={openImportDialog}
          disabled={
            message.sha256 === undefined ||
            availableImportBackends.length === 0 ||
            chain.importingMemory ||
            preparingImport
          }
        >
          导入记忆
        </button>
        {currentImport !== undefined && (
          <span className="memory-import-status" data-status={currentImport.status} role="status">
            {importStatusLabel(currentImport, backends)}
          </span>
        )}
        {currentImport?.allowedActions[0] === "reconcile" && (
          <button
            className="message-action-button"
            disabled={chain.reconcilingMemory}
            onClick={() => chain.reconcileMemoryImport(currentImport)}
          >
            {currentImport.status === "accepted" ? "再次验证" : "对账"}
          </button>
        )}
      </div>
      {selectionError !== null && (
        <p className="memory-import-error" role="alert">
          {selectionError}
        </p>
      )}
      {(submittedHere || pendingForMessage) && chain.memoryImportError !== null && (
        <p className="memory-import-error" role="alert">
          导入请求结果未知或失败（{chain.memoryImportError.code}）。
          <button
            className="small-button"
            disabled={chain.importingMemory}
            onClick={chain.retryPendingMemoryImport}
          >
            用同一命令重试
          </button>
        </p>
      )}
      {dialogSelection !== undefined && (
        <div className="memory-import-backdrop" role="presentation">
          <section
            ref={dialogRef}
            className="memory-import-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`memory-import-title-${message.messageId}`}
          >
            <header>
              <div>
                <h3 id={`memory-import-title-${message.messageId}`}>导入事实记忆</h3>
                <p>这会把你确认的内容写入外部 Memory 服务。</p>
              </div>
              <button className="dialog-close" aria-label="关闭" onClick={closeImportDialog}>
                ×
              </button>
            </header>
            <div className="memory-import-preview">
              <strong>{dialogSelection === null ? "整条消息" : "当前选区"}</strong>
              <p>
                {(dialogSelection === null ? message.content.text : dialogSelection.text).slice(
                  0,
                  500,
                )}
                {(dialogSelection === null ? message.content.text : dialogSelection.text).length >
                500
                  ? "…"
                  : ""}
              </p>
            </div>
            <label>
              <span>Memory 服务</span>
              <select value={backendId} onChange={(event) => setBackendId(event.target.value)}>
                {importBackends.map((backend) => (
                  <option
                    value={backend.backendId}
                    key={backend.backendId}
                    disabled={!backend.configured || backend.health !== "ready"}
                  >
                    {backend.displayName}
                    {!backend.configured || backend.health !== "ready" ? "（不可用）" : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="memory-import-kind">
              <strong>
                {selectedImportBackend?.capabilities.import?.mode === "conversation_capture"
                  ? "会话捕获（L0）"
                  : "事实记忆（L2）"}
              </strong>
              <span>
                {selectedImportBackend?.capabilities.import?.mode === "conversation_capture"
                  ? "先保存原始事实，再由 MemoryCore 异步提炼"
                  : "适合长期有效的事实、要求和偏好"}
              </span>
            </div>
            {selectedImportBackend?.capabilities.import?.title !== false && (
              <label>
                <span>标题</span>
                <input
                  autoFocus
                  maxLength={200}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
            )}
            {selectedImportBackend?.capabilities.import?.tags !== false && (
              <label>
                <span>标签</span>
                <input
                  maxLength={400}
                  placeholder="project, release"
                  value={tagsText}
                  onChange={(event) => setTagsText(event.target.value)}
                />
              </label>
            )}
            <footer>
              <button className="pane-button" onClick={closeImportDialog}>
                取消
              </button>
              <button
                className="send-button"
                disabled={
                  chain.importingMemory ||
                  preparingImport ||
                  title.trim() === "" ||
                  backendId === ""
                }
                onClick={() => void confirmImport()}
              >
                {chain.importingMemory || preparingImport ? "正在提交…" : "确认导入"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </li>
  );
}
