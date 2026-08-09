import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblemError } from "../api/client.js";
import { NotesPanel } from "./NotesPanel.js";

const mocks = vi.hoisted(() => ({
  revise: vi.fn(),
}));

vi.mock("../api/client.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api/client.js")>();
  return { ...original, apiReviseNote: mocks.revise };
});

const currentRevision = {
  schemaVersion: "chat-note-api.v1" as const,
  noteRevisionId: "ntr_retry1" as never,
  noteId: "nte_retry1" as never,
  noteRevision: 1,
  title: "原始标题",
  kind: "idea" as const,
  contentMarkdown: "原始正文",
  tags: [],
  sourceRefs: [
    {
      kind: "full_message" as const,
      sourceMessageId: "msg_retry1" as never,
      sourceMessageSha256: "a".repeat(64) as never,
    },
  ],
  createdByPrincipalId: "usr_owner1" as never,
  sha256: "b".repeat(64) as never,
  createdAt: "2026-08-10T00:00:00.000Z",
};

vi.mock("../notes/use-notes.js", () => ({
  useNotes: () => ({
    isPending: false,
    isError: false,
    data: {
      schemaVersion: "chat-note-api.v1",
      items: [
        {
          schemaVersion: "chat-note-api.v1",
          noteId: "nte_retry1",
          status: "active",
          currentRevision: {
            ...currentRevision,
            sourceCount: 1,
            noteId: undefined,
            contentMarkdown: undefined,
            sourceRefs: undefined,
            createdByPrincipalId: undefined,
          },
          allowedActions: ["revise", "archive"],
          revision: 1,
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        },
      ],
    },
  }),
  useNote: () => ({
    isPending: false,
    isError: false,
    data: {
      schemaVersion: "chat-note-api.v1",
      noteId: "nte_retry1",
      status: "active",
      currentRevision,
      allowedActions: ["revise", "archive"],
      revision: 1,
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    },
  }),
  useNoteHistory: () => ({ isPending: false, isError: false, data: { items: [] } }),
  useCurrentNoteCandidate: () => ({ isPending: false, isError: false }),
}));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("NotesPanel command recovery", () => {
  it("修订响应未知后保留同一commandId并由显式重试复用", async () => {
    mocks.revise
      .mockRejectedValueOnce(
        new ApiProblemError({
          code: "network_unknown",
          retryable: true,
          recoveryAction: "retry_same_command",
        }),
      )
      .mockResolvedValueOnce({});
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NotesPanel sessionId="psn_retry1" />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /原始标题/u }));
    await user.click(screen.getByRole("button", { name: "编辑当前 Revision" }));
    const title = screen.getByLabelText("标题");
    await user.clear(title);
    await user.type(title, "更新标题");
    await user.click(screen.getByRole("button", { name: "保存新 Revision" }));
    expect(await screen.findByText(/命令结果待确认/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "用同一命令重试" }));

    await waitFor(() => expect(mocks.revise).toHaveBeenCalledTimes(2));
    const first = mocks.revise.mock.calls[0]?.[0] as { commandId: string };
    const second = mocks.revise.mock.calls[1]?.[0] as { commandId: string };
    expect(second.commandId).toBe(first.commandId);
  });
});
