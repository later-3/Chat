import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureChatHome } from "../chat-home.js";
import { withFileLock } from "../persistence/versioned-file.js";

export type LongAgentSocialAudience = "friends" | "self";
export interface LongAgentSocialPost {
  readonly id: string;
  readonly longAgentId: string;
  /** Set when the post was produced by an LA4 artifact task; absent for older or manual posts. */
  readonly artifactKey?: string | null;
  /** friends (default, visible to all long agents) or self (owner only). */
  readonly audience?: LongAgentSocialAudience;
  readonly date: string;
  readonly text: string;
  readonly sourceSummaryDate: string | null;
  readonly createdAt: string;
  readonly comments: readonly {
    readonly id: string;
    readonly longAgentId: string;
    readonly text: string;
    readonly createdAt: string;
  }[];
}

export class LongAgentSocialError extends Error {}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** Hard limit for one post or comment body; longer content must be rejected, never truncated. */
export const MAX_POST_TEXT_CHARS = 4_000;

interface PostRow {
  readonly id: string;
  readonly longAgentId: string;
  readonly artifactKey?: string | null;
  readonly audience?: LongAgentSocialAudience;
  readonly date: string;
  readonly text: string;
  readonly sourceSummaryDate: string | null;
  readonly createdAt: string;
}

interface CommentRow {
  readonly id: string;
  readonly postId: string;
  readonly longAgentId: string;
  readonly text: string;
  readonly createdAt: string;
}

async function feedPaths(chatHome?: string): Promise<{ posts: string; comments: string }> {
  const home = await ensureChatHome(chatHome);
  const dir = resolve(home.root, "social");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { posts: resolve(dir, "posts.jsonl"), comments: resolve(dir, "comments.jsonl") };
}

async function readRows<T>(path: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // 单行损坏不应让整个 feed 不可读。
    }
  }
  return rows;
}

async function appendRow(path: string, row: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
}

function assertText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new LongAgentSocialError(`${field}不能为空`);
  const text = value.trim();
  if (text.length > MAX_POST_TEXT_CHARS)
    throw new LongAgentSocialError(`${field}超过${MAX_POST_TEXT_CHARS}字符上限（实际${text.length}）；请缩短内容，不能截断后发布`);
  return text;
}

/** 发布一条动态（A4：总结完成后由 Agent 发出）。 */
export async function publishLongAgentPost(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly text: unknown;
  readonly date?: string;
  readonly sourceSummaryDate?: string | null;
  readonly artifactKey?: string;
  readonly audience?: LongAgentSocialAudience;
  /** Final authorization gate, executed inside the same lock as the dedupe check and the append. */
  readonly confirmPublish?: () => Promise<void>;
}): Promise<LongAgentSocialPost> {
  if (input.audience !== undefined && input.audience !== "friends" && input.audience !== "self")
    throw new LongAgentSocialError("受众必须是 friends 或 self");
  if (input.artifactKey !== undefined) {
    // Stable artifact identity must be resolved and appended atomically: a concurrent retry of the
    // same artifact may not see "absent" twice and publish two posts.
    const locked = await feedPaths(input.chatHome);
    return withFileLock(`${locked.posts}.lock`, async () => {
      const existing = (await readRows<PostRow>(locked.posts)).find((row) => row.artifactKey === input.artifactKey);
      if (existing !== undefined) {
        const comments = (await commentsFor(locked.comments)).filter((item) => item.postId === existing.id);
        return { ...existing, comments: comments.map(({ postId: _postId, ...rest }) => rest) };
      }
      // Last-moment authorization gate: a revocation that completed while this publish was in
      // flight still blocks the append. The residual window between this check and the append
      // is documented in the deliverables contract.
      if (input.confirmPublish) await input.confirmPublish();
      return appendPost(input);
    });
  }
  return appendPost(input);
}

async function appendPost(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly text: unknown;
  readonly date?: string;
  readonly sourceSummaryDate?: string | null;
  readonly artifactKey?: string;
  readonly audience?: LongAgentSocialAudience;
}): Promise<LongAgentSocialPost> {
  const paths = await feedPaths(input.chatHome);
  const now = new Date();
  const date = input.date !== undefined && DATE_PATTERN.test(input.date)
    ? input.date
    : `${String(now.getFullYear())}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (input.sourceSummaryDate !== undefined && input.sourceSummaryDate !== null && !DATE_PATTERN.test(input.sourceSummaryDate)) {
    throw new LongAgentSocialError("sourceSummaryDate必须是YYYY-MM-DD");
  }
  const row: PostRow = {
    id: `post-${randomUUID()}`,
    longAgentId: input.longAgentId,
    ...(input.artifactKey === undefined ? {} : { artifactKey: input.artifactKey }),
    audience: input.audience ?? "friends",
    date,
    text: assertText(input.text, "text"),
    sourceSummaryDate: input.sourceSummaryDate ?? null,
    createdAt: now.toISOString(),
  };
  await appendRow(paths.posts, row);
  return { ...row, comments: [] };
}

/** 评论一条动态（A4 的“互动”）。 */
export async function commentOnLongAgentPost(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly postId: unknown;
  readonly text: unknown;
}): Promise<LongAgentSocialPost> {
  const paths = await feedPaths(input.chatHome);
  const postId = assertText(input.postId, "postId");
  const posts = await readRows<PostRow>(paths.posts);
  const post = posts.find((candidate) => candidate.id === postId);
  // Visibility is checked before reading, writing or returning any body: a self post is invisible
  // to other agents, and invisible objects must not reveal their text.
  if (post === undefined || ((post.audience ?? "friends") === "self" && post.longAgentId !== input.longAgentId))
    throw new LongAgentSocialError(`找不到动态: ${postId}`);
  const comment: CommentRow = {
    id: `comment-${randomUUID()}`,
    postId,
    longAgentId: input.longAgentId,
    text: assertText(input.text, "text"),
    createdAt: new Date().toISOString(),
  };
  await appendRow(paths.comments, comment);
  return { ...post, comments: [...(await commentsFor(paths.comments)).filter((item) => item.postId === postId).map(({ postId: _postId, ...rest }) => rest)] };
}

async function commentsFor(path: string): Promise<CommentRow[]> {
  return readRows<CommentRow>(path);
}

/** Look up a post by its artifact identity (LA4 idempotent commit / receipt backfill). */
export async function findPostByArtifactKey(input: { readonly chatHome?: string; readonly artifactKey: string }): Promise<LongAgentSocialPost | null> {
  const paths = await feedPaths(input.chatHome);
  const row = (await readRows<PostRow>(paths.posts)).find((post) => post.artifactKey === input.artifactKey);
  return row === undefined ? null : { ...row, comments: [] };
}

/** 读取时间流：默认最近 N 天，含评论。self 受众只对本人可见。 */
export async function listLongAgentFeed(input: {
  readonly chatHome?: string;
  readonly from?: string;
  readonly to?: string;
  readonly longAgentId?: string;
  /** Who is reading: posts with audience=self are only visible to their owner. */
  readonly viewerLongAgentId?: string;
  readonly limit?: number;
}): Promise<LongAgentSocialPost[]> {
  const paths = await feedPaths(input.chatHome);
  const posts = await readRows<PostRow>(paths.posts);
  const comments = await commentsFor(paths.comments);
  const byPost = new Map<string, LongAgentSocialPost["comments"][number][]>();
  for (const comment of comments) {
    byPost.set(comment.postId, [
      ...(byPost.get(comment.postId) ?? []),
      { id: comment.id, longAgentId: comment.longAgentId, text: comment.text, createdAt: comment.createdAt },
    ]);
  }
  return posts
    .filter((post) => (post.audience ?? "friends") === "friends" || post.longAgentId === input.viewerLongAgentId)
    .filter((post) => (input.longAgentId === undefined || post.longAgentId === input.longAgentId))
    .filter((post) => (input.from === undefined || post.date >= input.from) && (input.to === undefined || post.date <= input.to))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.limit ?? 50)
    .map((post) => ({ ...post, comments: byPost.get(post.id) ?? [] }));
}
