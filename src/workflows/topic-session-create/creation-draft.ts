import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * The structured topic-creation draft carried alongside the human-readable review document.
 *
 * The collector agent appends ONE trailing HTML comment with this JSON; the review binds the VISIBLE
 * document (hash), and the create step later reads the draft that belongs to the APPROVED revision. The
 * model never re-submits the approved content: `commit_creation` reads exactly this record.
 */
export const TOPIC_CREATION_DRAFT_CUSTOM_TYPE = "chat.topic-creation-draft.v1";
const DRAFT_PREFIX = "<!-- chat-topic-draft ";
const DRAFT_SUFFIX = " -->";

export interface TopicCreationDraftMemoryRef {
  readonly storageProjectId: string;
  readonly sessionId: string;
  readonly entryId: string;
  readonly content: string;
}
export interface TopicCreationDraft {
  readonly title: string;
  readonly purpose: string;
  readonly integrationSummary: string;
  readonly frozenProjectContext: string | null;
  readonly initialMemory: readonly TopicCreationDraftMemoryRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`主题草稿${label}无效`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`主题草稿${label}超过${String(max)}字符`);
  return trimmed;
}

export function planSha256Hex(plan: string): string {
  return createHash("sha256").update(plan, "utf8").digest("hex");
}

/**
 * Splits the collector output into the structured draft. The collector MUST emit ONLY the planner
 * metadata line plus the draft JSON: the review preview is rendered from this draft server-side, so the
 * user-approved content and the created content can never be two independently authored documents.
 */
export function parseTopicCreationDraft(document: string): { draft: TopicCreationDraft } {
  const lines: string[] = document.split("\n");
  let draftIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").trim();
    if (line.startsWith(DRAFT_PREFIX) && line.endsWith(DRAFT_SUFFIX)) { draftIndex = index; break; }
  }
  if (draftIndex === -1) throw new Error("主题整理输出缺少 chat-topic-draft 草稿元数据");
  // Everything except the planner metadata line (line 0) and the draft comment must be empty: any second
  // prose copy could contradict the draft, which is exactly what we must prevent.
  const leftover = lines.filter((_line, index) => index !== draftIndex && index !== 0).join("").trim();
  if (leftover !== "") throw new Error("主题整理输出只能包含结构化草稿；不要另写一份正文");
  let parsed: unknown;
  try {
    parsed = JSON.parse((lines[draftIndex] ?? "").trim().slice(DRAFT_PREFIX.length, -DRAFT_SUFFIX.length)) as unknown;
  } catch {
    throw new Error("主题整理草稿元数据不是有效JSON");
  }
  if (!isRecord(parsed)) throw new Error("主题整理草稿元数据必须是对象");
  const initialMemory = parsed.initialMemory === undefined || parsed.initialMemory === null ? [] : parsed.initialMemory;
  if (!Array.isArray(initialMemory)) throw new Error("主题草稿initialMemory必须是数组");
  const draft: TopicCreationDraft = {
    title: text(parsed.title, "title", 200),
    purpose: text(parsed.purpose, "purpose", 2_000),
    integrationSummary: text(parsed.integrationSummary, "integrationSummary", 20_000),
    frozenProjectContext: parsed.frozenProjectContext === undefined || parsed.frozenProjectContext === null
      ? null
      : text(parsed.frozenProjectContext, "frozenProjectContext", 200),
    initialMemory: initialMemory.map((candidate) => {
      if (!isRecord(candidate)) throw new Error("主题草稿initialMemory条目无效");
      return {
        storageProjectId: text(candidate.storageProjectId, "initialMemory.storageProjectId", 200),
        sessionId: text(candidate.sessionId, "initialMemory.sessionId", 200),
        entryId: text(candidate.entryId, "initialMemory.entryId", 200),
        content: text(candidate.content, "initialMemory.content", 4_000),
      };
    }),
  };
  return { draft };
}

/** Stable canonical JSON of the draft: the review hash binds THIS, not a rendered string. */
export function canonicalTopicDraftJson(draft: TopicCreationDraft): string {
  return JSON.stringify({
    title: draft.title,
    purpose: draft.purpose,
    integrationSummary: draft.integrationSummary,
    frozenProjectContext: draft.frozenProjectContext,
    initialMemory: draft.initialMemory.map((ref) => ({ storageProjectId: ref.storageProjectId, sessionId: ref.sessionId, entryId: ref.entryId, content: ref.content })),
  });
}

/** Deterministic user-facing preview rendered from the draft — the ONLY thing the user reviews. */
export function renderTopicCreationPreview(draft: TopicCreationDraft): string {
  const lines = [
    `# ${draft.title}`,
    "## 目标",
    draft.purpose,
    "## 整合摘要",
    draft.integrationSummary,
    "## 协作项目",
    draft.frozenProjectContext === null ? "无协作项目" : draft.frozenProjectContext,
    "## 来源与初始记忆",
  ];
  if (draft.initialMemory.length === 0) lines.push("- 无可引用的既有记忆");
  else for (const ref of draft.initialMemory) lines.push(`- ${ref.storageProjectId}/${ref.sessionId}#${ref.entryId}：${ref.content}`);
  return lines.join("\n");
}

export function appendTopicCreationDraft(
  sessionManager: SessionManager,
  input: { readonly planRevision: number; readonly planSha256: string; readonly draft: TopicCreationDraft },
): string {
  return sessionManager.appendCustomEntry(TOPIC_CREATION_DRAFT_CUSTOM_TYPE, {
    schemaVersion: 1,
    planRevision: input.planRevision,
    planSha256: input.planSha256,
    draft: input.draft,
  });
}

/** Reads the draft that belongs to exactly this approved revision+hash. */
export function readTopicCreationDraft(
  entries: readonly unknown[],
  input: { readonly planRevision: number; readonly planSha256: string },
): TopicCreationDraft | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.customType !== TOPIC_CREATION_DRAFT_CUSTOM_TYPE) continue;
    const data = entry.data;
    if (!isRecord(data) || data.planRevision !== input.planRevision || data.planSha256 !== input.planSha256) continue;
    const draft = data.draft;
    if (!isRecord(draft)) continue;
    return draft as unknown as TopicCreationDraft;
  }
  return null;
}
