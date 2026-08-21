import { describe, expect, it } from "vitest";

import { assertManagedPiForkCapabilities } from "./pi-fork-capabilities.js";

describe("Later Pi Fork能力门", () => {
  it("当前分支同时提供Provider Gate与未完成Turn恢复", () => {
    const evidence = assertManagedPiForkCapabilities();
    expect(evidence.branch).toBe("codex/later-custom");
    expect(evidence.origin).toMatch(/later-3\/pi/u);
    expect(evidence.checkoutRoot).toMatch(/\/opc-os\/pi$/u);
  });
});
