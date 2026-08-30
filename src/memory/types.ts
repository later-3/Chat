export const MEMORY_KINDS = [
  "preference",
  "fact",
  "decision",
  "lesson",
  "goal",
  "constraint",
  "session_summary",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];
export type MemoryScope = "personal" | "project";
export type MemoryTarget =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string };

export interface MemoryAddress {
  readonly target: MemoryTarget;
  readonly memoryId: string;
}
export type MemoryStatus = "active" | "archived";
export type MemoryIndexStatus = "pending" | "indexed" | "failed";

export interface MemorySource {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly entryIds?: readonly string[];
  readonly workflowInvocationId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly text: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScope;
  readonly projectId: string | null;
  readonly groupId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly sourceSessionId: string | null;
  readonly sourceProjectId: string | null;
  readonly sourceEntryIds: readonly string[];
  readonly sourceWorkflowInvocationId: string | null;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly mem0Id: string | null;
  readonly indexStatus: MemoryIndexStatus;
  readonly indexError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateMemoryInput {
  readonly text: string;
  readonly kind?: MemoryKind;
  readonly scope?: MemoryScope;
  readonly projectId?: string;
  readonly groupId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source?: MemorySource;
}

export interface UpdateMemoryInput {
  readonly text?: string;
  readonly kind?: MemoryKind;
  readonly scope?: MemoryScope;
  readonly projectId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly status?: MemoryStatus;
}

export interface ListMemoriesInput {
  readonly scope?: MemoryScope;
  readonly projectId?: string;
  readonly kind?: MemoryKind;
  readonly status?: MemoryStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export interface MemoryListPage {
  readonly items: readonly MemoryRecord[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface SearchMemoriesInput {
  readonly query: string;
  readonly scope?: MemoryScope;
  readonly projectId?: string;
  readonly kind?: MemoryKind;
  readonly topK?: number;
  readonly threshold?: number;
}

export interface MemorySearchHit {
  readonly memory: MemoryRecord;
  readonly score: number | null;
}

export interface SearchMemoryStoresInput {
  readonly query: string;
  readonly targets: readonly MemoryTarget[];
  readonly kind?: MemoryKind;
  readonly topK?: number;
  readonly threshold?: number;
}

export interface MemoryTargetWriteResult {
  readonly target: MemoryTarget;
  readonly memory?: MemoryRecord;
  readonly error?: string;
}

export interface MemoryIndexSearchHit {
  readonly mem0Id: string;
  readonly chatMemoryId: string | null;
  readonly score: number | null;
}

export interface MemoryRebuildResult {
  readonly total: number;
  readonly indexed: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly memoryId: string;
    readonly error: string;
  }[];
}

export interface DeleteMemoryResult {
  readonly id: string;
  readonly deleted: true;
  readonly indexCleanup: "completed" | "pending";
}

export interface MemoryHealth {
  readonly records: number;
  readonly indexed: number;
  readonly pending: number;
  readonly failed: number;
  readonly pendingDeletions: number;
}
