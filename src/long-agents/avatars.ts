import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveChatHome } from "../chat-home.js";
import { appendChatAuditEvent } from "../audit-log.js";
import { readLongAgentRegistry, updateLongAgentRegistry } from "./storage.js";
import { longAgentConfigRevision, type LongAgentAvatar } from "./types.js";

/**
 * Managed avatar assets for Long Agent display identity. The registry file
 * keeps only a reference (`avatar.<ext>` + revision); bytes live under
 * `<CHAT_HOME>/long-agents-assets/<longAgentId>/` and never leave the Backend
 * as absolute paths.
 */

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

type AvatarMime = "image/png" | "image/jpeg" | "image/webp";

const FILE_BY_MIME: Record<AvatarMime, string> = {
  "image/png": "avatar.png",
  "image/jpeg": "avatar.jpg",
  "image/webp": "avatar.webp",
};

export class LongAgentAvatarError extends Error {
  readonly statusCode: 400 | 404 | 409 | 413 | 415;

  constructor(message: string, statusCode: 400 | 404 | 409 | 413 | 415) {
    super(message);
    this.name = "LongAgentAvatarError";
    this.statusCode = statusCode;
  }
}

function sniffAvatarMime(bytes: Uint8Array): AvatarMime | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

function avatarDir(chatHome: string, longAgentId: string): string {
  return resolve(resolveChatHome(chatHome), "long-agents-assets", longAgentId);
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, bytes, { mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

async function removeAvatarAssets(dir: string, keep?: string): Promise<void> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  await Promise.all(entries
    .filter((entry) => /^avatar\.(png|jpe?g|webp)$/.test(entry) && entry !== keep)
    .map((entry) => rm(join(dir, entry), { force: true })));
}

/** Removes all managed avatar assets for one Agent; used when the display kind leaves `image`. */
export async function removeLongAgentAvatarAssets(longAgentId: string, chatHome?: string): Promise<void> {
  await removeAvatarAssets(avatarDir(resolveChatHome(chatHome), longAgentId));
}

export interface LongAgentAvatarImage {
  readonly bytes: Uint8Array;
  readonly mime: AvatarMime;
  readonly revision: number;
}

/** Reads the current image avatar; `null` when the Agent uses auto/emoji or the asset is gone. */
export async function readLongAgentAvatarImage(
  longAgentId: string,
  chatHome?: string,
): Promise<LongAgentAvatarImage | null> {
  const root = resolveChatHome(chatHome);
  const registry = await readLongAgentRegistry(root);
  const agent = registry.agents.find((candidate) => candidate.id === longAgentId);
  if (agent === undefined) throw new LongAgentAvatarError(`找不到Long Agent: ${longAgentId}`, 404);
  if (agent.avatar.kind !== "image") return null;
  const dir = avatarDir(root, agent.id);
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, agent.avatar.file));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const mime = sniffAvatarMime(bytes);
  if (mime === null || FILE_BY_MIME[mime] !== agent.avatar.file) {
    throw new LongAgentAvatarError("头像资产内容无效", 415);
  }
  return { bytes, mime, revision: agent.avatar.revision };
}

/** Stores a new image avatar and bumps its revision in the same registry write. */
export async function saveLongAgentAvatarImage(
  longAgentId: string,
  bytes: Uint8Array,
  expectedRevision: string,
  chatHome?: string,
): Promise<{ readonly avatar: Extract<LongAgentAvatar, { kind: "image" }> }> {
  const root = resolveChatHome(chatHome);
  if (bytes.byteLength === 0) throw new LongAgentAvatarError("头像内容为空", 400);
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    throw new LongAgentAvatarError(`头像不能超过${MAX_AVATAR_BYTES}字节`, 413);
  }
  const mime = sniffAvatarMime(bytes);
  if (mime === null) throw new LongAgentAvatarError("头像必须是PNG、JPEG或WebP图片", 415);
  const file = FILE_BY_MIME[mime];
  return updateLongAgentRegistry(root, async (registry) => {
    const index = registry.agents.findIndex((candidate) => candidate.id === longAgentId);
    const previous = index < 0 ? undefined : registry.agents[index];
    if (previous === undefined) throw new LongAgentAvatarError(`找不到Long Agent: ${longAgentId}`, 404);
    if (longAgentConfigRevision(previous) !== expectedRevision) {
      throw new LongAgentAvatarError("Long Agent配置已被其他操作更新，请重新加载后再保存", 409);
    }
    const avatar: Extract<LongAgentAvatar, { kind: "image" }> = {
      kind: "image",
      file,
      revision: previous.avatar.kind === "image" ? previous.avatar.revision + 1 : 1,
    };
    const dir = avatarDir(root, previous.id);
    await atomicWriteBytes(join(dir, file), bytes);
    await removeAvatarAssets(dir, file);
    const agents = [...registry.agents];
    agents[index] = { ...previous, avatar };
    return { registry: { ...registry, agents }, result: { avatar } };
  }).then(async (result) => {
    await appendChatAuditEvent({
      action: "long-agent.avatar.update",
      target: { type: "long-agent", longAgentId },
      details: { kind: "image", revision: result.avatar.revision },
    }, root);
    return result;
  });
}

/** Removes the image avatar and resets the display identity to `auto`. */
export async function clearLongAgentAvatarImage(
  longAgentId: string,
  expectedRevision: string,
  chatHome?: string,
): Promise<void> {
  const root = resolveChatHome(chatHome);
  await updateLongAgentRegistry(root, async (registry) => {
    const index = registry.agents.findIndex((candidate) => candidate.id === longAgentId);
    const previous = index < 0 ? undefined : registry.agents[index];
    if (previous === undefined) throw new LongAgentAvatarError(`找不到Long Agent: ${longAgentId}`, 404);
    if (longAgentConfigRevision(previous) !== expectedRevision) {
      throw new LongAgentAvatarError("Long Agent配置已被其他操作更新，请重新加载后再保存", 409);
    }
    if (previous.avatar.kind === "image") await removeAvatarAssets(avatarDir(root, previous.id));
    const agents = [...registry.agents];
    agents[index] = { ...previous, avatar: { kind: "auto" } };
    return { registry: { ...registry, agents }, result: undefined };
  });
  await appendChatAuditEvent({
    action: "long-agent.avatar.clear",
    target: { type: "long-agent", longAgentId },
    details: { kind: "auto" },
  }, root);
}
