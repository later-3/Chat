import assert from "node:assert/strict";
import test from "node:test";

import { runtimeReconnectDelayMs } from "../src/features/chat/use-runtime-reconnect.js";

test("runtime reconnect applies a bounded exponential delay", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 8].map((attempt) => runtimeReconnectDelayMs(attempt)),
    [400, 800, 1_600, 3_200, 5_000, 5_000],
  );
});

test("offline reconnect waits for a stable polling interval", () => {
  assert.equal(runtimeReconnectDelayMs(6, false), 1_000);
});
