import assert from "node:assert/strict";
import test from "node:test";

import { productSessionLocator } from "../src/features/session/session-identifier.js";

test("Product Session locator is short, stable and visibly namespaced", () => {
  assert.equal(productSessionLocator("a022e7ed-ef78-4961-80a5-56a7b5d83fa0"), "PS-A022E7ED");
});
