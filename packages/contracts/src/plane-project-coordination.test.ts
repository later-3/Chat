import { describe, expect, it } from "vitest";
import {
  planeAgentWritableStateNameSchema,
  planeProviderExternalIdSchema,
} from "./plane-project-coordination.js";

describe("Plane项目协调公开合同", () => {
  it("在Operation形成前拒绝Plane CE超长external_id和Agent Ready前置终态", () => {
    expect(
      planeProviderExternalIdSchema.safeParse(`chat-work:${"p".repeat(80)}:${"w".repeat(180)}`)
        .success,
    ).toBe(false);
    expect(planeAgentWritableStateNameSchema.safeParse("Ready").success).toBe(false);
  });
});
