import { describe, expect, it } from "vitest";
import { projectProfileRevisionSchema } from "@chat/contracts";
import {
  compileBuiltInProjectProfileRevision,
  compileProjectProfileRevision,
  getBuiltInProjectProfileDefinition,
} from "@chat/domain";

const NOW = "2026-08-25T10:00:00.000Z";

describe("K1 Profile跨包合同", () => {
  it.each(["software-delivery", "content-production", "learning", "personal-journal"] as const)(
    "%s编译结果通过严格网络Schema",
    (profileKey) => {
      const compiled = compileBuiltInProjectProfileRevision({ profileKey, now: NOW });
      expect(projectProfileRevisionSchema.parse(compiled)).toEqual(compiled);
    },
  );

  it("合成第五Profile复用同一编译与网络Schema，不需要核心Router或Store类型分支", () => {
    const base = getBuiltInProjectProfileDefinition("learning");
    const compiled = compileProjectProfileRevision({
      projectProfileRevisionId: "pfr_researchfixture1",
      version: 1,
      definition: {
        ...base,
        profileKey: "research-goal.fixture.v1",
        title: "研究目标Fixture",
        purpose: "验证Profile扩展接缝。",
      },
      now: NOW,
    });
    expect(projectProfileRevisionSchema.parse(compiled).profileKey).toBe(
      "research-goal.fixture.v1",
    );
  });
});
