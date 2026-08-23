import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexSessionSourceAdapter } from "./codex-session-source-adapter.js";

const SESSION_ID = "019db07f-953c-7fc2-95b6-d38228810e64";

describe("Codex Session只读Adapter", () => {
  it("只投影user/assistant可见正文，并按turn_id合并同轮消息", async () => {
    const home = await mkdtemp(join(tmpdir(), "chat-codex-source-"));
    const sessions = join(home, "sessions", "2026", "08", "24");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(home, "session_index.jsonl"),
      `${JSON.stringify({ id: SESSION_ID, thread_name: "Session 导入测试", updated_at: "2026-08-24T09:00:00.000Z" })}\n`,
    );
    const lines = [
      {
        type: "session_meta",
        timestamp: "2026-08-24T08:00:00.000Z",
        ordinal: 0,
        payload: { id: SESSION_ID, timestamp: "2026-08-24T08:00:00.000Z" },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T08:00:01.000Z",
        ordinal: 1,
        payload: {
          type: "message",
          id: "msg-user-1",
          role: "user",
          content: [{ type: "input_text", text: "第一段" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T08:00:02.000Z",
        ordinal: 2,
        payload: {
          type: "message",
          id: "msg-user-2",
          role: "user",
          content: [{ type: "input_text", text: "第二段" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T08:00:03.000Z",
        ordinal: 3,
        payload: {
          type: "message",
          id: "msg-developer",
          role: "developer",
          content: [{ type: "input_text", text: "绝不能导入的Developer正文" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-08-24T08:00:04.000Z",
        ordinal: 4,
        payload: {
          type: "message",
          id: "msg-assistant",
          role: "assistant",
          content: [
            { type: "output_text", text: "可见答复" },
            { type: "encrypted_content", text: "隐藏正文" },
          ],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
        },
      },
    ];
    const filePath = join(sessions, `rollout-2026-08-24T08-00-00-${SESSION_ID}.jsonl`);
    await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await symlink(filePath, join(sessions, `rollout-2026-08-24T09-00-00-${SESSION_ID}.jsonl.link`));

    const adapter = new CodexSessionSourceAdapter({ codexHome: home });
    await expect(adapter.list({ limit: 10 })).resolves.toEqual([
      {
        sourceSessionId: SESSION_ID,
        title: "Session 导入测试",
        updatedAt: "2026-08-24T09:00:00.000Z",
      },
    ]);
    const loaded = await adapter.load(SESSION_ID as never);

    expect(loaded?.messages).toEqual([
      {
        sourceMessageKey: "turn-1:user",
        role: "user",
        text: "第一段\n\n第二段",
        createdAt: "2026-08-24T08:00:01.000Z",
      },
      {
        sourceMessageKey: "turn-1:assistant",
        role: "assistant",
        text: "可见答复",
        createdAt: "2026-08-24T08:00:01.000Z",
      },
    ]);
    expect(JSON.stringify(loaded)).not.toContain("Developer正文");
    expect(JSON.stringify(loaded)).not.toContain("隐藏正文");
  });

  it("拒绝通过Session根目录符号链接越过配置边界", async () => {
    const home = await mkdtemp(join(tmpdir(), "chat-codex-source-link-"));
    const external = await mkdtemp(join(tmpdir(), "chat-codex-source-external-"));
    await symlink(external, join(home, "sessions"));

    const adapter = new CodexSessionSourceAdapter({ codexHome: home });
    await expect(adapter.list({ limit: 10 })).rejects.toMatchObject({
      code: "memory.session_source.root_invalid",
    });
  });
});
