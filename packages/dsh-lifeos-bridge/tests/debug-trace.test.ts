import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { traceEventSchema } from "@chat/contracts";
import { createDshBridgeTraceEmitter, DSH_BRIDGE_TRACE_EVENTS } from "../src/debug-trace.ts";

const dshEvent = {
  level: "info" as const,
  eventName: DSH_BRIDGE_TRACE_EVENTS.dshAdapterRequestCaptured,
  outcome: "success" as const,
  traceId: "trd_debugtrace1",
  spanId: "spd_debugtrace1",
  dshSessionIdSha256: "a".repeat(64),
  requestSha256: "b".repeat(64),
  userTextSha256: "c".repeat(64),
  sectionCount: 4,
};

test("DSH/Bridge Trace默认关闭且不创建目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-dsh-trace-off-"));
  try {
    assert.equal(createDshBridgeTraceEmitter({ scope: "dsh", repoRoot: root, env: {} }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH Trace按模块写入兼容的严格摘要且拒绝正文通道", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-dsh-trace-full-"));
  try {
    const emit = createDshBridgeTraceEmitter({
      scope: "dsh",
      repoRoot: root,
      env: { CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "dsh" },
    });
    assert.notEqual(emit, undefined);
    emit?.(dshEvent);

    const directory = join(root, ".data", "traces");
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    const file = files[0];
    if (file === undefined) throw new Error("Trace文件未创建");
    const stored = JSON.parse(await readFile(join(directory, file), "utf8")) as unknown;
    traceEventSchema.parse(stored);
    assert.doesNotMatch(JSON.stringify(stored), /用户正文|prompt|payload/iu);

    assert.throws(() => emit?.({ ...dshEvent, body: "用户正文" } as never));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH Trace接受全局Scope选择但不会为未选模块创建Emitter", () => {
  assert.equal(
    createDshBridgeTraceEmitter({
      scope: "bridge",
      repoRoot: "/tmp/chat-dsh-trace-scope",
      env: { CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "api,workflow" },
    }),
    undefined,
  );
  assert.throws(() =>
    createDshBridgeTraceEmitter({
      scope: "dsh",
      repoRoot: "/tmp/chat-dsh-trace-scope",
      env: { CHAT_TRACE_MODE: "full", CHAT_TRACE_SCOPES: "unknown" },
    }),
  );
});
