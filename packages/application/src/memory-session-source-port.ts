import type { CodexSessionId } from "@chat/contracts";
import type { NormalizedMemorySessionSnapshot } from "@chat/domain";

export interface MemorySessionSourceDescriptor {
  readonly sourceSessionId: string;
  readonly title: string;
  readonly updatedAt: string;
}

/** 外部Session来源是只读Port；路径、文件格式与索引都留在Adapter内部。 */
export interface MemorySessionSourcePort {
  readonly kind: "codex";
  list(input: { readonly limit: number }): Promise<readonly MemorySessionSourceDescriptor[]>;
  load(sourceSessionId: CodexSessionId): Promise<NormalizedMemorySessionSnapshot | undefined>;
}

export interface MemorySessionSourceRegistryPort {
  get(kind: "codex"): MemorySessionSourcePort | undefined;
}
