import assert from "node:assert/strict";
import test from "node:test";
import { HttpAgent } from "@ag-ui/client";

import {
  authenticatedFetch,
  authenticationRecoveryUrl,
  subscribeAuthenticationRequired,
} from "../src/authentication-recovery.js";

test("401保留原响应并通知App Shell进入重新登录", async () => {
  const events: Array<{ status: 401; url: string }> = [];
  let observedInit: RequestInit | undefined;
  const unsubscribe = subscribeAuthenticationRequired((event) => events.push(event));

  try {
    const response = await authenticatedFetch(
      "/chat-api/api/ready",
      { headers: { accept: "application/json" } },
      async (_input, init) => {
        observedInit = init;
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="Chat private workspace"' },
        });
      },
    );

    assert.equal(response.status, 401);
    assert.equal(observedInit?.credentials, "same-origin");
    assert.deepEqual(events, [{ status: 401, url: "/chat-api/api/ready" }]);
  } finally {
    unsubscribe();
  }
});

test("非401失败不触发登录恢复，调用方仍处理原错误", async () => {
  let notificationCount = 0;
  const unsubscribe = subscribeAuthenticationRequired(() => {
    notificationCount += 1;
  });

  try {
    const response = await authenticatedFetch("/api/ready", {}, async () =>
      Promise.resolve(new Response("Unavailable", { status: 503 })),
    );
    assert.equal(response.status, 503);
    assert.equal(notificationCount, 0);
  } finally {
    unsubscribe();
  }
});

test("重新登录目标位于当前PWA基路径内", () => {
  assert.equal(authenticationRecoveryUrl("/chat/"), "/chat/auth-refresh.html");
  assert.equal(authenticationRecoveryUrl("/chat"), "/chat/auth-refresh.html");
});

test("AG-UI HttpAgent同样通过统一401认证边界", async () => {
  const events: Array<{ status: 401; url: string }> = [];
  const unsubscribe = subscribeAuthenticationRequired((event) => events.push(event));
  const originalConsoleError = console.error;
  console.error = () => undefined;
  const agent = new HttpAgent({
    url: "/chat-api/api/agent",
    threadId: "thread-auth-test",
    fetch: (url, init) =>
      authenticatedFetch(url, init, async () =>
        Promise.resolve(
          new Response("Unauthorized", {
            status: 401,
            headers: { "www-authenticate": 'Basic realm="Chat private workspace"' },
          }),
        ),
      ),
  });
  agent.addMessage({ id: "message-auth-test", role: "user", content: "test" });

  try {
    await assert.rejects(agent.runAgent({ runId: "run-auth-test" }));
    assert.deepEqual(events, [{ status: 401, url: "/chat-api/api/agent" }]);
  } finally {
    console.error = originalConsoleError;
    unsubscribe();
  }
});
