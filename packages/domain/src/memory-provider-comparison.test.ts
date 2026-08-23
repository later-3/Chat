import { describe, expect, it } from "vitest";
import {
  buildMemoryProviderPairwiseComparisons,
  type ComparableMemoryProviderOutcome,
} from "./memory-provider-comparison.js";

function completed(
  providerId: string,
  items: Array<{ readonly contentSha256: string; readonly labels: readonly string[] }>,
): ComparableMemoryProviderOutcome {
  return {
    providerId,
    status: "completed",
    items: items.map((item) => ({
      contentSha256: item.contentSha256,
      labels: [...item.labels],
    })),
  };
}

describe("Memory Provider差异报告", () => {
  it("只计算精确正文与标签交集，不比较Provider score", () => {
    const report = buildMemoryProviderPairwiseComparisons([
      completed("mbk_zeta", [{ contentSha256: "1".repeat(64), labels: ["release", "browser"] }]),
      completed("mbk_alpha", [
        { contentSha256: "1".repeat(64), labels: ["release"] },
        { contentSha256: "2".repeat(64), labels: ["local"] },
      ]),
    ]);
    expect(report).toEqual([
      {
        leftProviderId: "mbk_alpha",
        rightProviderId: "mbk_zeta",
        exactContentOverlapCount: 1,
        leftUniqueContentCount: 1,
        rightUniqueContentCount: 0,
        sharedLabels: ["release"],
        scoreComparisonAllowed: false,
      },
    ]);
  });
});
