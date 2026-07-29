import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, apiErrorFromResponse } from "../src/api-client.js";

test("统一Problem Detail保留稳定错误码、请求ID和恢复动作", async () => {
  const response = new Response(
    JSON.stringify({
      code: "SESSION_CONFLICT",
      message: "会话状态已变化，请刷新后重试。",
      request_id: "request-42",
      retryable: false,
      details: { expected_revision: 2, actual_revision: 3 },
    }),
    {
      status: 409,
      headers: { "content-type": "application/json", "x-request-id": "request-42" },
    },
  );

  const error = await apiErrorFromResponse(response);

  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 409);
  assert.equal(error.code, "SESSION_CONFLICT");
  assert.equal(error.requestId, "request-42");
  assert.equal(error.retryable, false);
  assert.equal(error.recoveryAction, "refresh");
  assert.deepEqual(error.details, { expected_revision: 2, actual_revision: 3 });
});

test("迁移期间仍能读取旧detail错误而不让调用方解析中文结构", async () => {
  const response = new Response(JSON.stringify({ detail: "旧服务错误" }), {
    status: 503,
    headers: { "x-request-id": "legacy-request" },
  });

  const error = await apiErrorFromResponse(response, "服务不可用");

  assert.equal(error.message, "旧服务错误");
  assert.equal(error.code, "HTTP_503");
  assert.equal(error.requestId, "legacy-request");
  assert.equal(error.retryable, true);
  assert.equal(error.recoveryAction, "retry");
});

test("401统一映射为重新认证而不是普通重试", async () => {
  const response = new Response("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Chat private workspace"' },
  });

  const error = await apiErrorFromResponse(response);

  assert.equal(error.status, 401);
  assert.equal(error.code, "HTTP_401");
  assert.equal(error.recoveryAction, "authenticate");
  assert.equal(error.retryable, false);
});
