import { canonicalJsonStringify, hashCanonical, sha256Hex } from "./canonical-hash.js";

export const NOTE_TAG_KEY_NORMALIZATION_VERSION = "note-tag-key.nfkc-simple-fold.v1";

const NOTE_TITLE_MAX_CHARACTERS = 200;
const NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS = 100_000;
const NOTE_TAG_LABEL_MAX_CHARACTERS = 64;
const NOTE_TAG_MAX_COUNT = 20;
const NOTE_SOURCE_REF_MAX_COUNT = 20;

export type NoteKindShape = "idea" | "project_idea" | "learning" | "general";
export type NoteStatusShape = "active" | "archived";
export type NoteCandidateStatusShape =
  "under_review" | "confirmed" | "revision_requested" | "rejected" | "failed";
export type NoteDecisionKindShape = "confirm" | "request_revision" | "reject";

export interface NoteTagShape {
  readonly key: string;
  readonly label: string;
}

export type NoteSourceRefShape =
  | {
      readonly kind: "full_message";
      readonly sourceMessageId: string;
      readonly sourceMessageSha256: string;
    }
  | {
      readonly kind: "utf16_range";
      readonly sourceMessageId: string;
      readonly sourceMessageSha256: string;
      readonly startUtf16: number;
      readonly endUtf16: number;
      readonly selectedTextSha256: string;
    };

export interface NoteDraftShape {
  readonly title: string;
  readonly kind: NoteKindShape;
  readonly contentMarkdown: string;
  readonly tags: readonly NoteTagShape[];
}

export interface NoteRevisionSnapshotShape extends NoteDraftShape {
  readonly schemaVersion?: "note-revision.v1" | undefined;
  readonly noteRevisionId: string;
  readonly noteId: string;
  readonly noteRevision: number;
  readonly sourceRefs: readonly NoteSourceRefShape[];
  readonly createdByPrincipalId: string;
  readonly sha256: string;
  readonly createdAt: string;
}

export interface NoteAggregateShape {
  readonly schemaVersion?: "note.v1" | undefined;
  readonly noteId: string;
  readonly ownerPrincipalId: string;
  readonly sourceCandidateId: string;
  readonly currentRevisionId: string;
  readonly status: NoteStatusShape;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteCandidateSnapshotShape {
  readonly schemaVersion?: "note-candidate.v1" | undefined;
  readonly noteCandidateId: string;
  readonly productRunId: string;
  readonly candidateSequence: number;
  readonly supersedesCandidateId?: string | undefined;
  readonly proposed: NoteDraftShape;
  readonly sourceRefs: readonly NoteSourceRefShape[];
  readonly status: NoteCandidateStatusShape;
  readonly failure?: { readonly code: string; readonly summary: string } | undefined;
  readonly sha256: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NoteDecisionShape {
  readonly schemaVersion?: "note-decision.v1" | undefined;
  readonly noteDecisionId: string;
  readonly productRunId: string;
  readonly noteCandidateId: string;
  readonly candidateRevision: number;
  readonly candidateSha256: string;
  readonly kind: NoteDecisionKindShape;
  readonly revisionInstruction?: string | undefined;
  readonly reason?: string | undefined;
  readonly principalId: string;
  readonly commandId: string;
  readonly revision: 1;
  readonly createdAt: string;
}

interface MessageForNoteSource {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sessionSequence: number;
  readonly role: "user" | "assistant";
  readonly content: { readonly format: "markdown"; readonly text: string };
}

/**
 * Unicode规范化顺序被冻结为v1：NFKC → trim → Unicode空白折叠 → locale无关小写 → NFKC。
 * label保留规范化后的显示大小写，key用于过滤和唯一性；浏览器不拥有该算法。
 */
export function normalizeNoteTagLabel(label: string): NoteTagShape {
  const normalizedLabel = label
    .normalize("NFKC")
    .trim()
    .replace(/\p{White_Space}+/gu, " ");
  if (
    normalizedLabel.length === 0 ||
    normalizedLabel.length > NOTE_TAG_LABEL_MAX_CHARACTERS ||
    /[\p{Cc}\p{Cs}\u2028\u2029]/u.test(normalizedLabel)
  ) {
    throw new NoteDomainError("note.tag_label_invalid", "Note Tag label为空、过长或包含控制字符");
  }

  const key = normalizedLabel.toLowerCase().normalize("NFKC");
  if (key.length === 0 || key.length > NOTE_TAG_LABEL_MAX_CHARACTERS) {
    throw new NoteDomainError("note.tag_key_invalid", "Note Tag规范化key为空或过长");
  }
  return { key, label: normalizedLabel };
}

/** 重复canonical key是歧义输入，必须失败关闭，不能静默选择某个显示label。 */
export function normalizeNoteTags(labels: readonly string[]): NoteTagShape[] {
  if (labels.length > NOTE_TAG_MAX_COUNT) {
    throw new NoteDomainError("note.tags_too_many", "Note Tag数量超过上限");
  }
  const tags = labels.map(normalizeNoteTagLabel);
  const seen = new Set<string>();
  for (const tag of tags) {
    if (seen.has(tag.key)) {
      throw new NoteDomainError("note.tag_key_duplicate", `Note Tag key重复:${tag.key}`);
    }
    seen.add(tag.key);
  }
  return tags.sort((left, right) => left.key.localeCompare(right.key));
}

export function assertCanonicalNoteTags(tags: readonly NoteTagShape[]): void {
  if (tags.length > NOTE_TAG_MAX_COUNT) {
    throw new NoteDomainError("note.tags_too_many", "Note Tag数量超过上限");
  }
  const keys = new Set<string>();
  for (const tag of tags) {
    const expected = normalizeNoteTagLabel(tag.label);
    if (tag.label !== expected.label || tag.key !== expected.key) {
      throw new NoteDomainError(
        "note.tag_not_canonical",
        `Note Tag未按${NOTE_TAG_KEY_NORMALIZATION_VERSION}规范化`,
      );
    }
    if (keys.has(tag.key)) {
      throw new NoteDomainError("note.tag_key_duplicate", `Note Tag key重复:${tag.key}`);
    }
    keys.add(tag.key);
  }
}

export function normalizeNoteTitle(title: string): string {
  const normalized = title.trim();
  if (
    normalized.length === 0 ||
    normalized.length > NOTE_TITLE_MAX_CHARACTERS ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(normalized)
  ) {
    throw new NoteDomainError("note.title_invalid", "Note标题为空、过长或包含换行/控制字符");
  }
  return normalized;
}

export function assertNoteContentMarkdown(contentMarkdown: string): void {
  if (
    contentMarkdown.length === 0 ||
    contentMarkdown.length > NOTE_CONTENT_MARKDOWN_MAX_CHARACTERS
  ) {
    throw new NoteDomainError("note.content_size_invalid", "Note Markdown正文为空或超过上限");
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(contentMarkdown)) {
    throw new NoteDomainError("note.content_control_invalid", "Note Markdown包含不允许的控制字符");
  }
  if (!/[^\p{C}\s]/u.test(contentMarkdown)) {
    throw new NoteDomainError("note.content_empty", "Note Markdown必须包含可见内容");
  }
}

export function assertNoteDraftIntegrity(draft: NoteDraftShape): void {
  if (!(["idea", "project_idea", "learning", "general"] as const).includes(draft.kind)) {
    throw new NoteDomainError("note.kind_invalid", `未知Note kind:${String(draft.kind)}`);
  }
  if (normalizeNoteTitle(draft.title) !== draft.title) {
    throw new NoteDomainError("note.title_not_canonical", "Note标题必须使用trim后的规范值");
  }
  assertNoteContentMarkdown(draft.contentMarkdown);
  assertCanonicalNoteTags(draft.tags);
}

export function computeNoteSourceMessageSha256(message: MessageForNoteSource): string {
  return hashCanonical("message.v1", {
    messageId: message.messageId,
    sessionId: message.sessionId,
    sessionSequence: message.sessionSequence,
    role: message.role,
    content: message.content,
  });
}

/**
 * 来源正文始终从权威Message重建。UTF-16边界与浏览器Selection一致，同时禁止切开代理对，
 * 避免刷新或跨实现后同一范围得到损坏Unicode。
 */
export function resolveNoteSourceText(input: {
  readonly message: MessageForNoteSource;
  readonly sourceRef: NoteSourceRefShape;
}): string {
  const { message, sourceRef } = input;
  if (sourceRef.sourceMessageId !== message.messageId) {
    throw new NoteDomainError("note.source_message_mismatch", "Note来源不属于指定Message");
  }
  if (sourceRef.sourceMessageSha256 !== computeNoteSourceMessageSha256(message)) {
    throw new NoteDomainError("note.source_message_stale", "Note来源Message版本已变化");
  }

  let content: string;
  if (sourceRef.kind === "full_message") {
    content = message.content.text;
  } else {
    if (
      sourceRef.startUtf16 < 0 ||
      sourceRef.startUtf16 >= sourceRef.endUtf16 ||
      sourceRef.endUtf16 > message.content.text.length ||
      splitsUtf16SurrogatePair(message.content.text, sourceRef.startUtf16) ||
      splitsUtf16SurrogatePair(message.content.text, sourceRef.endUtf16)
    ) {
      throw new NoteDomainError("note.source_range_invalid", "Note UTF-16来源范围无效");
    }
    content = message.content.text.slice(sourceRef.startUtf16, sourceRef.endUtf16);
    if (sha256Hex(content) !== sourceRef.selectedTextSha256) {
      throw new NoteDomainError("note.source_selection_stale", "Note来源选区内容已变化");
    }
  }
  assertNoteContentMarkdown(content);
  return content;
}

export function assertNoteSourceRefsIntegrity(sourceRefs: readonly NoteSourceRefShape[]): void {
  if (sourceRefs.length === 0 || sourceRefs.length > NOTE_SOURCE_REF_MAX_COUNT) {
    throw new NoteDomainError("note.source_refs_count_invalid", "Note必须有有界的Message来源");
  }
  const canonicalRefs = sourceRefs.map((sourceRef) => canonicalJsonStringify(sourceRef));
  if (new Set(canonicalRefs).size !== canonicalRefs.length) {
    throw new NoteDomainError("note.source_ref_duplicate", "Note不能包含重复来源引用");
  }
  for (const sourceRef of sourceRefs) {
    if (
      sourceRef.kind === "utf16_range" &&
      (sourceRef.startUtf16 < 0 || sourceRef.startUtf16 >= sourceRef.endUtf16)
    ) {
      throw new NoteDomainError("note.source_range_invalid", "Note UTF-16来源范围无效");
    }
  }
}

/** Revision Hash覆盖内容、分类、Tag、来源和创建actor；createdAt与持久ID不参与。 */
export function computeNoteRevisionSha256(
  revision: Omit<NoteRevisionSnapshotShape, "noteRevisionId" | "sha256" | "createdAt">,
): string {
  return hashCanonical("note-revision.v1", {
    noteId: revision.noteId,
    noteRevision: revision.noteRevision,
    title: revision.title,
    kind: revision.kind,
    contentMarkdown: revision.contentMarkdown,
    tags: sortTags(revision.tags),
    sourceRefs: sortSourceRefs(revision.sourceRefs),
    createdByPrincipalId: revision.createdByPrincipalId,
  });
}

export function assertNoteRevisionIntegrity(revision: NoteRevisionSnapshotShape): void {
  if (!Number.isInteger(revision.noteRevision) || revision.noteRevision < 1) {
    throw new NoteDomainError("note.revision_sequence_invalid", "Note Revision序号必须从1递增");
  }
  assertNoteDraftIntegrity(revision);
  assertNoteSourceRefsIntegrity(revision.sourceRefs);
  if (computeNoteRevisionSha256(revision) !== revision.sha256) {
    throw new NoteDomainError("note.revision_hash_mismatch", "Note Revision Hash不匹配");
  }
}

export function assertNoteRevisionAppend(input: {
  readonly current: NoteRevisionSnapshotShape;
  readonly next: NoteRevisionSnapshotShape;
}): void {
  assertNoteRevisionIntegrity(input.current);
  assertNoteRevisionIntegrity(input.next);
  if (input.next.noteId !== input.current.noteId) {
    throw new NoteDomainError("note.revision_note_mismatch", "新旧Revision必须属于同一Note");
  }
  if (input.next.noteRevisionId === input.current.noteRevisionId) {
    throw new NoteDomainError("note.revision_identity_reused", "追加Revision必须使用新身份");
  }
  if (input.next.noteRevision !== input.current.noteRevision + 1) {
    throw new NoteDomainError("note.revision_sequence_invalid", "Note Revision必须严格递增一版");
  }
}

export function assertNoteRevisionUnchanged(input: {
  readonly original: NoteRevisionSnapshotShape;
  readonly persisted: NoteRevisionSnapshotShape;
}): void {
  if (canonicalJsonStringify(input.original) !== canonicalJsonStringify(input.persisted)) {
    throw new NoteDomainError(
      "note.revision_immutable_violation",
      "已持久Note Revision不可修改，必须追加新Revision",
    );
  }
}

export function assertNoteAggregateIntegrity(input: {
  readonly note: NoteAggregateShape;
  readonly revisions: readonly NoteRevisionSnapshotShape[];
}): void {
  if (input.revisions.length === 0) {
    throw new NoteDomainError("note.current_revision_missing", "Note必须至少拥有一个Revision");
  }
  const revisions = [...input.revisions].sort(
    (left, right) => left.noteRevision - right.noteRevision,
  );
  revisions.forEach((revision, index) => {
    assertNoteRevisionIntegrity(revision);
    if (revision.noteId !== input.note.noteId) {
      throw new NoteDomainError("note.revision_note_mismatch", "Revision不属于指定Note");
    }
    if (revision.noteRevision !== index + 1) {
      throw new NoteDomainError("note.revision_sequence_gap", "Note Revision序列不能跳号或重复");
    }
  });
  if (revisions.at(-1)?.noteRevisionId !== input.note.currentRevisionId) {
    throw new NoteDomainError(
      "note.current_revision_not_latest",
      "Note currentRevisionId必须指向最高已提交Revision",
    );
  }
}

export function assertNoteLifecycleTransition(from: NoteStatusShape, to: NoteStatusShape): void {
  const valid =
    (from === "active" && to === "archived") || (from === "archived" && to === "active");
  if (!valid) {
    throw new NoteDomainError("note.lifecycle_transition_invalid", `Note不允许${from} -> ${to}`);
  }
}

export function assertNoteCanRevise(note: Pick<NoteAggregateShape, "status">): void {
  if (note.status !== "active") {
    throw new NoteDomainError("note.archived_read_only", "已归档Note只能恢复，不能直接修订");
  }
}

/** Candidate Hash只覆盖不可变候选内容与来源；status、revision、时间戳不参与。 */
export function computeNoteCandidateSha256(
  candidate: Omit<
    NoteCandidateSnapshotShape,
    "sha256" | "status" | "failure" | "revision" | "createdAt" | "updatedAt"
  >,
): string {
  return hashCanonical("note-candidate.v1", {
    noteCandidateId: candidate.noteCandidateId,
    productRunId: candidate.productRunId,
    candidateSequence: candidate.candidateSequence,
    supersedesCandidateId: candidate.supersedesCandidateId ?? null,
    proposed: {
      ...candidate.proposed,
      tags: sortTags(candidate.proposed.tags),
    },
    sourceRefs: sortSourceRefs(candidate.sourceRefs),
  });
}

export function assertNoteCandidateIntegrity(candidate: NoteCandidateSnapshotShape): void {
  if (!Number.isInteger(candidate.candidateSequence) || candidate.candidateSequence < 1) {
    throw new NoteDomainError("note.candidate_sequence_invalid", "Candidate序号必须从1递增");
  }
  if (candidate.candidateSequence === 1 && candidate.supersedesCandidateId !== undefined) {
    throw new NoteDomainError(
      "note.candidate_initial_supersedes_invalid",
      "首个Candidate不能引用旧Candidate",
    );
  }
  if (candidate.candidateSequence > 1 && candidate.supersedesCandidateId === undefined) {
    throw new NoteDomainError(
      "note.candidate_supersedes_required",
      "后续Candidate必须引用被替代Candidate",
    );
  }
  assertNoteDraftIntegrity(candidate.proposed);
  assertNoteSourceRefsIntegrity(candidate.sourceRefs);
  if (candidate.status === "failed" && candidate.failure === undefined) {
    throw new NoteDomainError("note.candidate_failure_required", "failed Candidate必须有安全错误");
  }
  if (candidate.status !== "failed" && candidate.failure !== undefined) {
    throw new NoteDomainError(
      "note.candidate_failure_forbidden",
      "非failed Candidate不能携带错误字段",
    );
  }
  if (computeNoteCandidateSha256(candidate) !== candidate.sha256) {
    throw new NoteDomainError("note.candidate_hash_mismatch", "Note Candidate Hash不匹配");
  }
}

const NOTE_CANDIDATE_TRANSITIONS: Readonly<
  Record<NoteCandidateStatusShape, readonly NoteCandidateStatusShape[]>
> = {
  under_review: ["confirmed", "revision_requested", "rejected", "failed"],
  confirmed: [],
  revision_requested: [],
  rejected: [],
  failed: [],
};

export function assertNoteCandidateTransition(input: {
  readonly current: NoteCandidateSnapshotShape;
  readonly next: NoteCandidateSnapshotShape;
}): void {
  assertNoteCandidateIntegrity(input.current);
  assertNoteCandidateIntegrity(input.next);
  if (!NOTE_CANDIDATE_TRANSITIONS[input.current.status].includes(input.next.status)) {
    throw new NoteDomainError(
      "note.candidate_transition_invalid",
      `Note Candidate不允许${input.current.status} -> ${input.next.status}`,
    );
  }
  assertCandidateContentSame(input.current, input.next);
  if (input.next.revision !== input.current.revision + 1) {
    throw new NoteDomainError(
      "note.candidate_revision_invalid",
      "Candidate状态变化必须递增一个revision",
    );
  }
  if (input.next.updatedAt <= input.current.updatedAt) {
    throw new NoteDomainError("note.candidate_updated_at_invalid", "Candidate更新时间必须前进");
  }
}

/** request_revision或用户编辑都追加successor；旧Candidate内容和身份永远不覆盖。 */
export function assertNoteCandidateSuccessor(input: {
  readonly current: NoteCandidateSnapshotShape;
  readonly next: NoteCandidateSnapshotShape;
}): void {
  assertNoteCandidateIntegrity(input.current);
  assertNoteCandidateIntegrity(input.next);
  if (input.current.status !== "revision_requested") {
    throw new NoteDomainError(
      "note.candidate_successor_not_requested",
      "只有revision_requested Candidate允许追加successor",
    );
  }
  if (input.next.status !== "under_review") {
    throw new NoteDomainError(
      "note.candidate_successor_status_invalid",
      "新Candidate必须从under_review开始",
    );
  }
  if (input.next.productRunId !== input.current.productRunId) {
    throw new NoteDomainError(
      "note.candidate_successor_run_mismatch",
      "Candidate successor不能跨Product Run",
    );
  }
  if (input.next.noteCandidateId === input.current.noteCandidateId) {
    throw new NoteDomainError(
      "note.candidate_successor_identity_reused",
      "Candidate successor必须使用新身份",
    );
  }
  if (input.next.candidateSequence !== input.current.candidateSequence + 1) {
    throw new NoteDomainError(
      "note.candidate_successor_sequence_invalid",
      "Candidate successor必须严格递增一个sequence",
    );
  }
  if (input.next.supersedesCandidateId !== input.current.noteCandidateId) {
    throw new NoteDomainError(
      "note.candidate_successor_ref_mismatch",
      "Candidate successor必须精确引用旧Candidate",
    );
  }
  if (
    canonicalJsonStringify(sortSourceRefs(input.next.sourceRefs)) !==
    canonicalJsonStringify(sortSourceRefs(input.current.sourceRefs))
  ) {
    throw new NoteDomainError(
      "note.candidate_successor_source_mismatch",
      "Candidate successor不能改变冻结来源",
    );
  }
}

/** Decision必须绑定当前under_review Candidate的精确Run、revision和内容Hash。 */
export function assertNoteDecisionBinding(input: {
  readonly candidate: NoteCandidateSnapshotShape;
  readonly decision: NoteDecisionShape;
}): void {
  assertNoteCandidateIntegrity(input.candidate);
  if (input.candidate.status !== "under_review") {
    throw new NoteDomainError("note.decision_candidate_stale", "终态或旧Candidate不能再次决定");
  }
  if (
    input.decision.productRunId !== input.candidate.productRunId ||
    input.decision.noteCandidateId !== input.candidate.noteCandidateId
  ) {
    throw new NoteDomainError(
      "note.decision_candidate_mismatch",
      "Note Decision不属于指定Candidate或Product Run",
    );
  }
  if (
    input.decision.candidateRevision !== input.candidate.revision ||
    input.decision.candidateSha256 !== input.candidate.sha256
  ) {
    throw new NoteDomainError(
      "note.decision_binding_stale",
      "Note Decision绑定的Candidate revision或Hash已过期",
    );
  }
  if (
    input.decision.kind === "request_revision" &&
    (input.decision.revisionInstruction === undefined ||
      input.decision.revisionInstruction.trim().length === 0)
  ) {
    throw new NoteDomainError(
      "note.decision_revision_instruction_required",
      "request_revision必须说明修改要求",
    );
  }
  if (
    input.decision.kind !== "request_revision" &&
    input.decision.revisionInstruction !== undefined
  ) {
    throw new NoteDomainError(
      "note.decision_revision_instruction_forbidden",
      "只有request_revision允许revisionInstruction",
    );
  }
  if (input.decision.kind !== "reject" && input.decision.reason !== undefined) {
    throw new NoteDomainError("note.decision_reason_forbidden", "只有reject允许拒绝reason");
  }
}

/** 已持久Candidate整体不可原地改写；生命周期变更必须构造next并走transition校验。 */
export function assertNoteCandidateUnchanged(input: {
  readonly original: NoteCandidateSnapshotShape;
  readonly persisted: NoteCandidateSnapshotShape;
}): void {
  if (canonicalJsonStringify(input.original) !== canonicalJsonStringify(input.persisted)) {
    throw new NoteDomainError("note.candidate_immutable_violation", "已持久Candidate不能原地覆盖");
  }
}

function assertCandidateContentSame(
  current: NoteCandidateSnapshotShape,
  next: NoteCandidateSnapshotShape,
): void {
  const content = (candidate: NoteCandidateSnapshotShape) => ({
    noteCandidateId: candidate.noteCandidateId,
    productRunId: candidate.productRunId,
    candidateSequence: candidate.candidateSequence,
    supersedesCandidateId: candidate.supersedesCandidateId ?? null,
    proposed: candidate.proposed,
    sourceRefs: candidate.sourceRefs,
    sha256: candidate.sha256,
    createdAt: candidate.createdAt,
  });
  if (canonicalJsonStringify(content(current)) !== canonicalJsonStringify(content(next))) {
    throw new NoteDomainError(
      "note.candidate_content_immutable_violation",
      "Candidate状态变化不能覆盖候选内容或来源",
    );
  }
}

function sortTags(tags: readonly NoteTagShape[]): NoteTagShape[] {
  return [...tags].sort((left, right) => left.key.localeCompare(right.key));
}

function sortSourceRefs(sourceRefs: readonly NoteSourceRefShape[]): NoteSourceRefShape[] {
  return [...sourceRefs].sort((left, right) =>
    canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right)),
  );
}

function splitsUtf16SurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

export class NoteDomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NoteDomainError";
    this.code = code;
  }
}
