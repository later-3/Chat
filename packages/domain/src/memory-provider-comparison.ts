import { hashCanonical } from "./canonical-hash.js";

export interface ComparableMemoryProviderOutcome {
  readonly providerId: string;
  readonly status: "completed" | "failed";
  readonly items?:
    | readonly {
        readonly contentSha256: string;
        readonly labels: readonly string[];
      }[]
    | undefined;
}

export interface MemoryProviderPairwiseComparisonShape {
  readonly leftProviderId: string;
  readonly rightProviderId: string;
  readonly exactContentOverlapCount: number;
  readonly leftUniqueContentCount: number;
  readonly rightUniqueContentCount: number;
  readonly sharedLabels: readonly string[];
  readonly scoreComparisonAllowed: false;
}

type CompletedOutcome = ComparableMemoryProviderOutcome & {
  readonly status: "completed";
  readonly items: NonNullable<ComparableMemoryProviderOutcome["items"]>;
};

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): readonly string[] {
  return [...left].filter((value) => right.has(value)).sort();
}

/** 只比较精确正文Hash与规范化标签；Provider各自的score不可跨实现比较。 */
export function buildMemoryProviderPairwiseComparisons(
  outcomes: readonly ComparableMemoryProviderOutcome[],
): readonly MemoryProviderPairwiseComparisonShape[] {
  const completed = outcomes
    .filter(
      (outcome): outcome is CompletedOutcome =>
        outcome.status === "completed" && outcome.items !== undefined,
    )
    .sort((left, right) => left.providerId.localeCompare(right.providerId));
  const comparisons: MemoryProviderPairwiseComparisonShape[] = [];
  for (const [leftIndex, left] of completed.entries()) {
    for (const right of completed.slice(leftIndex + 1)) {
      const leftContent = new Set(left.items.map((item) => item.contentSha256));
      const rightContent = new Set(right.items.map((item) => item.contentSha256));
      const overlap = intersection(leftContent, rightContent);
      const leftLabels = new Set(left.items.flatMap((item) => item.labels));
      const rightLabels = new Set(right.items.flatMap((item) => item.labels));
      comparisons.push({
        leftProviderId: left.providerId,
        rightProviderId: right.providerId,
        exactContentOverlapCount: overlap.length,
        leftUniqueContentCount: leftContent.size - overlap.length,
        rightUniqueContentCount: rightContent.size - overlap.length,
        sharedLabels: intersection(leftLabels, rightLabels),
        scoreComparisonAllowed: false,
      });
    }
  }
  return comparisons;
}

export function computeMemoryProviderComparisonSha256(input: {
  readonly source: unknown;
  readonly sourceSnapshotSha256: string;
  readonly querySha256: string;
  readonly maxResults: number;
  readonly maxContextCharacters: number;
  readonly providers: readonly unknown[];
  readonly pairwise: readonly MemoryProviderPairwiseComparisonShape[];
}): string {
  return hashCanonical("memory-provider-comparison-preview.v1", input);
}
