import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryBackendProfileDto, MemoryImportDto, MessageDto } from "@chat/contracts/public";
import type { RealChainState } from "../real/use-real-chain.js";
import { ChatMessageItem } from "./ChatMessageItem.js";

const message: MessageDto = {
  schemaVersion: "chat-product-api.v1",
  messageId: "msg_importui1" as never,
  sessionId: "psn_importui1" as never,
  sessionSequence: 1,
  role: "user",
  content: { format: "markdown", text: "前缀😀需要导入的事实后缀" },
  sha256: "a".repeat(64) as never,
  createdAt: "2026-08-08T00:00:00.000Z",
};

const backend: MemoryBackendProfileDto = {
  schemaVersion: "chat-product-api.v1",
  backendId: "mbk_memmy" as never,
  displayName: "memmy",
  kind: "memmy",
  configured: true,
  health: "ready",
  capabilities: {
    query: true,
    tags: true,
    layers: ["L2"],
    maxLimit: 20,
    maxContextBudget: 8192,
    import: {
      mode: "explicit_fact",
      layers: ["L2"],
      title: true,
      tags: true,
      maxContentChars: 50_000,
    },
  },
};

function chain(imports: readonly MemoryImportDto[] = []) {
  return {
    memoryImports: { data: imports },
    importMemory: vi.fn(),
    retryPendingMemoryImport: vi.fn(),
    importingMemory: false,
    memoryImportError: null,
    reconcileMemoryImport: vi.fn(),
    reconcilingMemory: false,
  } as unknown as RealChainState;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
});

describe("ChatMessageItem Memory Import", () => {
  it("无选区时确认整条正式Message，并支持Escape关闭与焦点落入Dialog", async () => {
    const user = userEvent.setup();
    const state = chain();
    render(<ChatMessageItem message={message} chain={state} backends={[backend]} />);
    await user.click(screen.getByRole("button", { name: "导入记忆" }));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByText("整条消息")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("标题"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: "导入记忆" }));
    await user.click(screen.getByRole("button", { name: "确认导入" }));
    expect(state.importMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        backendId: "mbk_memmy",
        sourceSelection: {
          kind: "full_message",
          sourceMessageId: message.messageId,
          sourceMessageSha256: message.sha256,
        },
      }),
    );
  });

  it("把当前Message局部选区转换为UTF-16范围和原文SHA，不复制错误范围", async () => {
    const user = userEvent.setup();
    const state = chain();
    const { container } = render(
      <ChatMessageItem message={message} chain={state} backends={[backend]} />,
    );
    const content = container.querySelector("pre")!;
    const node = content.firstChild!;
    const range = document.createRange();
    // JS DOM Range偏移与产品合同一致，Emoji占两个UTF-16 code unit。
    range.setStart(node, 4);
    range.setEnd(node, 10);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    await user.click(screen.getByRole("button", { name: "导入记忆" }));
    expect(screen.getByText("当前选区")).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(state.importMemory).toHaveBeenCalledTimes(1));
    expect(state.importMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceSelection: expect.objectContaining({
          kind: "utf16_range",
          startUtf16: 4,
          endUtf16: 10,
          selectedTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        }),
      }),
    );
  });

  it("跨Message选区阻止打开Dialog；结果未知只显示服务端状态并提供对账", async () => {
    const user = userEvent.setup();
    const current: MemoryImportDto = {
      schemaVersion: "chat-product-api.v1",
      memoryImportIntentId: "mii_ui1" as never,
      memoryImportResultId: "mir_ui1" as never,
      sessionId: message.sessionId,
      sourceMessageId: message.messageId,
      selectionKind: "full_message",
      sourcePreview: "preview",
      backendId: "mbk_memmy" as never,
      backendDisplayName: "memmy",
      memoryLayer: "L2",
      title: "标题",
      tags: [],
      status: "outcome_unknown",
      errorCode: "memory.import.connection_lost",
      resultRevision: 3,
      allowedActions: ["reconcile"],
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
    };
    const state = chain([current]);
    const { container } = render(
      <>
        <ChatMessageItem message={message} chain={state} backends={[backend]} />
        <p data-testid="other-message">另一条消息</p>
      </>,
    );
    const range = document.createRange();
    range.setStart(container.querySelector("pre")!.firstChild!, 0);
    range.setEnd(screen.getByTestId("other-message").firstChild!, 2);
    window.getSelection()!.addRange(range);

    await user.click(screen.getByRole("button", { name: "导入记忆" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("选区必须完整位于这一条消息内");
    expect(screen.getByRole("status").textContent).toContain("写入结果未知");
    await user.click(screen.getByRole("button", { name: "对账" }));
    expect(state.reconcileMemoryImport).toHaveBeenCalledWith(current);
  });
});
