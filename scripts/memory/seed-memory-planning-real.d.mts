export declare const MEMORY_REAL_FACT: string;
export declare const MEMORY_REAL_DISTRACTOR: string;
export declare const MEMORY_REAL_TAG: string;

export declare function seedMemoryPlanningReal(options?: {
  readonly baseUrl?: string;
  readonly evidencePath?: string;
}): Promise<{
  readonly addedIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly evidencePath: string;
}>;
