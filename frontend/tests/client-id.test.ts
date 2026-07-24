import assert from "node:assert/strict";
import test from "node:test";

import { createClientId } from "../src/client-id.js";

test("client ID prefers native randomUUID when available", () => {
  assert.equal(
    createClientId({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }),
    "11111111-1111-4111-8111-111111111111",
  );
});

test("client ID falls back to getRandomValues on an HTTP browser", () => {
  const value = createClientId({
    getRandomValues(array) {
      if (array instanceof Uint8Array) array.fill(9);
      return array;
    },
  });
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
