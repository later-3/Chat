import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionControlForwardedProps,
  toAguiMessages,
  type ProductMessage,
} from "../src/session-api.js";


function productMessage(
  ordinal: number,
  role: "user" | "assistant",
  content: unknown,
): ProductMessage {
  return {
    id: `product-${ordinal}`,
    agui_message_id: `agui-${ordinal}`,
    session_id: "session-1",
    interaction_id: "interaction-1",
    run_id: "run-1",
    role,
    content,
    status: "committed",
    context_eligible: true,
    ordinal,
    revision: ordinal,
    created_at: "2026-07-21T00:00:00Z",
  };
}


test("Product Message恢复为AG-UI投影时保留稳定消息ID、角色和内容", () => {
  const values = toAguiMessages([
    productMessage(1, "user", "第一问"),
    productMessage(2, "assistant", [{ type: "text", text: "第一答" }]),
  ]);

  assert.deepEqual(values, [
    { id: "agui-1", role: "user", content: "第一问" },
    { id: "agui-2", role: "assistant", content: [{ type: "text", text: "第一答" }] },
  ]);
});


test("前端恢复投影不把Product主键冒充AG-UI message id", () => {
  const [value] = toAguiMessages([productMessage(1, "user", "保持ID边界")]);

  assert.equal(value.id, "agui-1");
  assert.notEqual(value.id, "product-1");
});


test("失败重试控制显式携带来源Run和retry/restart语义", () => {
  assert.deepEqual(
    sessionControlForwardedProps({ kind: "restart", sourceRunId: "failed-run" }),
    { sessionControl: { kind: "restart", sourceRunId: "failed-run" } },
  );
});
