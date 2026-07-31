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
      recovery_action: "refresh",
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

test("403表示当前Principal无权限，不冒充登录失效", async () => {
  const response = new Response(
    JSON.stringify({
      code: "PROJECTION_FORBIDDEN",
      message: "当前身份不能查看这个Project。",
      request_id: "request-forbidden",
      retryable: false,
      recovery_action: "forbidden",
      details: null,
    }),
    { status: 403 },
  );

  const error = await apiErrorFromResponse(response);

  assert.equal(error.status, 403);
  assert.equal(error.recoveryAction, "forbidden");
  assert.equal(error.retryable, false);
});

test("结果未知使用对账动作，不被HTTP 409误判成普通刷新", async () => {
  const response = new Response(
    JSON.stringify({
      code: "TOOL_OPERATION_OUTCOME_UNKNOWN",
      message: "外部动作结果未知，必须先对账。",
      request_id: "request-reconcile",
      retryable: false,
      recovery_action: "reconcile",
      details: null,
    }),
    { status: 409 },
  );

  const error = await apiErrorFromResponse(response);

  assert.equal(error.recoveryAction, "reconcile");
  assert.equal(error.retryable, false);
});

test("未知恢复动作不会穿透到UI，迁移客户端按HTTP状态安全降级", async () => {
  const response = new Response(
    JSON.stringify({
      code: "SESSION_CONFLICT",
      message: "状态已变化。",
      request_id: "request-unknown-action",
      retryable: false,
      recovery_action: "run_untrusted_script",
      details: null,
    }),
    { status: 409, headers: { "x-request-id": "request-unknown-action" } },
  );

  const error = await apiErrorFromResponse(response);

  assert.equal(error.recoveryAction, "refresh");
  assert.equal(error.code, "HTTP_409");
});
