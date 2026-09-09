import { createError, defineEventHandler, getQuery, setResponseHeader } from "nitro/h3";
import { stat } from "node:fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "../../../files/directory-browser.js";

/** Lists readable subdirectories for the browser directory picker; names only, never file content. */
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "no-store");
  const query = getQuery(event);
  const requested = typeof query.path === "string" ? query.path.trim() : undefined;

  if (shouldShowWindowsDrivePicker(requested)) {
    return { path: "", parentPath: null, drives: await listWindowsDrives(), directories: [] };
  }

  let resolved: string;
  try {
    resolved = await resolveDirectory(getBrowseStartDirectory(requested));
  } catch {
    throw createError({ statusCode: 404, statusMessage: "目录不存在" });
  }
  const directoryStat = await stat(resolved);
  if (!directoryStat.isDirectory()) {
    throw createError({ statusCode: 400, statusMessage: "路径不是目录" });
  }
  return {
    path: resolved,
    parentPath: getParentDirectory(resolved),
    directories: await listDirectories(resolved),
  };
});
