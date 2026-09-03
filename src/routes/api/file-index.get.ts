import fs from "node:fs";
import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
} from "../../files/access.js";
import {
  buildFileIndexEntries,
  FILE_INDEX_CLIENT_LIMIT,
  listFileIndex,
  searchFileIndex,
  type FileIndexEntry,
  type FileListing,
} from "../../files/file-index.js";

const MAX_QUERY_LENGTH = 500;
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 20;

interface CacheEntry {
  readonly listing: FileListing;
  entries?: FileIndexEntry[];
  readonly expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const requestQuery = getQuery(event);
  const cwd = typeof requestQuery.cwd === "string" ? requestQuery.cwd.trim() : "";
  if (cwd === "" || (!cwd.startsWith("/") && !isWindowsAbsolutePath(cwd))) {
    throw createError({ statusCode: 400, statusMessage: "cwd必须是绝对路径" });
  }
  const query = typeof requestQuery.q === "string" ? requestQuery.q.slice(0, MAX_QUERY_LENGTH) : "";

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(cwd, allowedRoots)) {
    throw createError({ statusCode: 403, statusMessage: "拒绝访问" });
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw createError({ statusCode: 404, statusMessage: "目录不存在" });
  }
  if (!stat.isDirectory()) throw createError({ statusCode: 400, statusMessage: "路径不是目录" });
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    throw createError({ statusCode: 403, statusMessage: "拒绝访问" });
  }

  const now = Date.now();
  let cached = cache.get(cwd);
  if (cached === undefined || cached.expiresAt <= now) {
    const listing = await listFileIndex(cwd);
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
    cached = { listing, expiresAt: now + CACHE_TTL_MS };
    cache.set(cwd, cached);
  }

  if (query !== "") {
    cached.entries ??= buildFileIndexEntries(cached.listing.files);
    return { matches: searchFileIndex(cached.entries, query) };
  }
  return {
    files: cached.listing.files.slice(0, FILE_INDEX_CLIENT_LIMIT),
    truncated: cached.listing.hardTruncated || cached.listing.files.length > FILE_INDEX_CLIENT_LIMIT,
  };
});
