import { afterEach, describe, expect, it } from "vitest";
import {
  clearNoteDraft,
  pendingNoteMutationKey,
  readPendingNoteMutation,
  writePendingNoteMutation,
} from "./note-drafts.js";

const pendingKey = pendingNoteMutationKey("ses_notes1", "nte_notes1");

afterEach(() => window.localStorage.clear());

describe("Note mutation pending command", () => {
  it("刷新后保留同一commandId、CAS与strict payload", () => {
    writePendingNoteMutation(window.localStorage, pendingKey, {
      kind: "revise",
      commandId: "cmd_noteretry1" as never,
      expectedRevision: 3,
      payload: {
        currentRevisionId: "ntr_revision1" as never,
        currentRevisionSha256: "a".repeat(64) as never,
        revision: {
          title: "修订标题",
          kind: "idea",
          contentMarkdown: "正文",
          tagLabels: ["想法"],
        },
      },
    });

    expect(readPendingNoteMutation(window.localStorage, pendingKey)).toEqual({
      kind: "revise",
      commandId: "cmd_noteretry1",
      expectedRevision: 3,
      payload: {
        currentRevisionId: "ntr_revision1",
        currentRevisionSha256: "a".repeat(64),
        revision: {
          title: "修订标题",
          kind: "idea",
          contentMarkdown: "正文",
          tagLabels: ["想法"],
        },
      },
    });
  });

  it("unknown字段、错误ID或损坏JSON失败关闭，成功后可清理", () => {
    window.localStorage.setItem(
      pendingKey,
      JSON.stringify({
        kind: "archive",
        commandId: "bad",
        expectedRevision: 1,
        payload: {
          currentRevisionId: "ntr_revision1",
          currentRevisionSha256: "b".repeat(64),
        },
        secret: "must-not-survive",
      }),
    );
    expect(readPendingNoteMutation(window.localStorage, pendingKey)).toBeNull();

    window.localStorage.setItem(pendingKey, "{");
    expect(readPendingNoteMutation(window.localStorage, pendingKey)).toBeNull();
    clearNoteDraft(window.localStorage, pendingKey);
    expect(window.localStorage.getItem(pendingKey)).toBeNull();
  });
});
