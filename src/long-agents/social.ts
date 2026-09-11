import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureChatHome } from "../chat-home.js";

export interface LongAgentSocialPost {
  readonly id: string;
  readonly longAgentId: string;
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
const MAX_TEXT_CHARS = 4_000;

interface PostRow {
  readonly id: string;
  readonly longAgentId: string;
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
  return value.trim().slice(0, MAX_TEXT_CHARS);
}

/** 发布一条动态（A4：总结完成后由 Agent 发出）。 */
export async function publishLongAgentPost(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly text: unknown;
  readonly date?: string;
  readonly sourceSummaryDate?: string | null;
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
  if (post === undefined) throw new LongAgentSocialError(`找不到动态: ${postId}`);
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

/** 读取时间流：默认最近 N 天，含评论。 */
export async function listLongAgentFeed(input: {
  readonly chatHome?: string;
  readonly from?: string;
  readonly to?: string;
  readonly longAgentId?: string;
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
    .filter((post) => (input.longAgentId === undefined || post.longAgentId === input.longAgentId))
    .filter((post) => (input.from === undefined || post.date >= input.from) && (input.to === undefined || post.date <= input.to))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.limit ?? 50)
    .map((post) => ({ ...post, comments: byPost.get(post.id) ?? [] }));
}
