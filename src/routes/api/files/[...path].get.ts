import fs from "node:fs";
import path from "node:path";
import { defineEventHandler, getHeader, getQuery, getRouterParam } from "nitro/h3";
import {
  getAllowedFileRoots,
  isExistingFilePathAllowed,
  isFilePathAllowed,
  isWindowsAbsolutePath,
  normalizeSlashes,
} from "../../../files/access.js";
import {
  DOCX_PREVIEW_MAX_BYTES,
  IMAGE_PREVIEW_MAX_BYTES,
  TEXT_PREVIEW_MAX_BYTES,
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "../../../files/file-types.js";

const IGNORED_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__", ".turbo",
  ".cache", "coverage", ".pytest_cache", ".mypy_cache", "target", "vendor", ".DS_Store",
]);
const REQUEST_TYPES = new Set(["list", "read", "download", "meta", "preview", "watch"]);
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rb: "ruby", go: "go",
  rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", cpp: "cpp",
  h: "c", hpp: "cpp", cs: "csharp", html: "html", htm: "html", css: "css",
  scss: "css", less: "css", json: "json", jsonl: "json", yaml: "yaml", yml: "yaml",
  toml: "toml", xml: "xml", md: "markdown", mdx: "markdown", sh: "bash",
  bash: "bash", zsh: "bash", fish: "bash", sql: "sql", graphql: "graphql",
  gql: "graphql", dockerfile: "dockerfile", tf: "hcl", hcl: "hcl", env: "bash",
  gitignore: "bash", txt: "text",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routeFilePath(value: string): string {
  const segments = value.split("/").filter(Boolean).map(decodeSegment);
  const joined = normalizeSlashes(segments.join("/"));
  return isWindowsAbsolutePath(joined) ? joined : `/${joined.replace(/^\/+/, "")}`;
}

function languageFor(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === ".env" || base.startsWith(".env.")) return "bash";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  return EXT_TO_LANGUAGE[base.split(".").pop() ?? ""] ?? "text";
}

function encodeHeaderValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function contentDisposition(filePath: string, download = false): string {
  const fileName = path.basename(filePath);
  const fallback = fileName.replace(/[^\x20-\x7E]|["\\;\r\n]/g, "_") || "download";
  return `${download ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encodeHeaderValue(fileName)}`;
}

function fileBody(filePath: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const input = fs.createReadStream(filePath, range);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk: string | Buffer) => controller.enqueue(new Uint8Array(Buffer.from(chunk))));
      input.once("end", () => controller.close());
      input.once("error", (error) => controller.error(error));
    },
    cancel() {
      input.destroy();
    },
  });
}

function streamFile(
  filePath: string,
  stat: fs.Stats,
  contentType: string,
  rangeHeader: string | undefined,
  download = false,
): Response {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "bytes",
    "Content-Disposition": contentDisposition(filePath, download),
  };
  if (!rangeHeader) {
    headers["Content-Length"] = String(stat.size);
    return new Response(fileBody(filePath), { headers });
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!match[1] && match[2]) {
    start = Math.max(stat.size - Number(match[2]), 0);
    end = stat.size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= stat.size) {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
  }
  end = Math.min(end, stat.size - 1);
  headers["Content-Length"] = String(end - start + 1);
  headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  return new Response(fileBody(filePath, { start, end }), { status: 206, headers });
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function docxHtml(body: string, fileName: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:#eef1f5;color:#171717}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:28px}main{box-sizing:border-box;max-width:840px;min-height:calc(100vh - 56px);margin:auto;padding:56px 64px;background:#fff;box-shadow:0 8px 28px rgba(15,23,42,.14)}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}.file-title{color:#6b7280;font:12px ui-monospace,monospace;border-bottom:1px solid #e5e7eb;padding-bottom:10px;margin-bottom:28px}</style></head><body><main><div class="file-title">${escapeHtml(fileName)}</div>${body}</main></body></html>`;
}

function sameFile(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export default defineEventHandler(async (event) => {
  try {
    const routePath = getRouterParam(event, "path");
    if (!routePath) return json({ error: "File path is required" }, 400);
    const filePath = routeFilePath(routePath);
    const query = getQuery(event);
    const type = typeof query.type === "string" ? query.type : "list";
    if (!REQUEST_TYPES.has(type)) return json({ error: "Invalid file request type" }, 400);

    const allowedRoots = await getAllowedFileRoots();
    if (!isFilePathAllowed(filePath, allowedRoots)) return json({ error: "Access denied" }, 403);

    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(filePath);
    } catch {
      if (type !== "watch") return json({ error: "Not found" }, 404);
    }
    const authorizationPath = stat ? filePath : path.dirname(filePath);
    if (!isExistingFilePathAllowed(authorizationPath, allowedRoots)) return json({ error: "Access denied" }, 403);

    if (type === "read" || type === "download") {
      if (!stat?.isFile()) return json({ error: "Not a file" }, 400);
      const imageMime = getImageMime(filePath);
      if (imageMime && stat.size > IMAGE_PREVIEW_MAX_BYTES && type === "read") {
        return json({ error: "Image too large (>10MB)" }, 413);
      }
      const mediaMime = imageMime ?? getAudioMime(filePath) ?? getDocumentMime(filePath);
      if (mediaMime || type === "download") {
        return streamFile(
          filePath,
          stat,
          mediaMime ?? "application/octet-stream",
          getHeader(event, "range"),
          type === "download",
        );
      }
      if (stat.size > TEXT_PREVIEW_MAX_BYTES) return json({ error: "File too large for preview (>256KB)" }, 413);
      return json({ content: fs.readFileSync(filePath, "utf8"), language: languageFor(filePath), size: stat.size });
    }

    if (type === "meta") {
      if (!stat?.isFile()) return json({ error: "Not a file" }, 400);
      return json({
        size: stat.size,
        language: languageFor(filePath),
        mime: getImageMime(filePath) ?? getAudioMime(filePath) ?? getDocumentMime(filePath) ?? "text/plain",
        previewKind: documentPreviewKind(filePath),
      });
    }

    if (type === "preview") {
      if (!stat?.isFile()) return json({ error: "Not a file" }, 400);
      if (getFileExt(filePath) !== "docx") return json({ error: "Preview not available for this file type" }, 400);
      if (stat.size > DOCX_PREVIEW_MAX_BYTES) return json({ error: "DOCX too large for preview (>10MB)" }, 413);
      const mammoth = await import("mammoth");
      const result = await mammoth.convertToHtml(
        { path: filePath },
        { externalFileAccess: false, convertImage: mammoth.images.dataUri },
      );
      return new Response(docxHtml(result.value, path.basename(filePath)), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
          "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    if (type === "watch") {
      if (stat && !stat.isFile()) return json({ error: "Not a file" }, 400);
      let watcher: fs.FSWatcher | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (eventName: string, data: Record<string, unknown>) => {
            controller.enqueue(new TextEncoder().encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`));
          };
          const directory = path.dirname(filePath);
          watcher = fs.watch(directory, (_type, name) => {
            if (name && !sameFile(path.join(directory, name.toString()), filePath)) return;
            try {
              const next = fs.statSync(filePath);
              send("change", { mtime: next.mtime.toISOString(), size: next.size });
            } catch {
              send("change", { mtime: new Date().toISOString(), size: 0 });
            }
          });
          watcher.on("error", () => controller.close());
          send("connected", { filePath });
        },
        cancel() {
          watcher?.close();
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (!stat?.isDirectory()) return json({ error: "Not a directory" }, 400);
    const entries = fs.readdirSync(filePath, { withFileTypes: true })
      .filter((entry) => !IGNORED_NAMES.has(entry.name) && !entry.name.endsWith(".pyc"))
      .flatMap((entry) => {
        let isDir: boolean;
        if (entry.isDirectory()) isDir = true;
        else if (entry.isFile()) isDir = false;
        else {
          try {
            isDir = fs.statSync(path.join(filePath, entry.name)).isDirectory();
          } catch {
            return [];
          }
        }
        return [{ name: entry.name, isDir, size: 0, modified: "" }];
      })
      .sort((left, right) => left.isDir === right.isDir
        ? left.name.localeCompare(right.name)
        : (left.isDir ? -1 : 1));
    return json({ entries, path: filePath });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
