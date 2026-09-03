export const MAX_TOOL_RESULT_IMAGE_BYTES = 10 * 1024 * 1024;

export const TOOL_RESULT_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
]);

interface Base64ToolResultImage {
  readonly data: string;
  readonly mime: string;
  readonly bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function estimatedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding);
}

export function readBase64ToolResultImage(block: unknown): Base64ToolResultImage | null {
  if (!isRecord(block) || block.type !== "image") return null;

  if (typeof block.data === "string" && typeof block.mimeType === "string") {
    return { data: block.data, mime: block.mimeType, bytes: estimatedBase64Bytes(block.data) };
  }

  if (
    isRecord(block.source) &&
    block.source.type === "base64" &&
    typeof block.source.data === "string" &&
    typeof block.source.media_type === "string"
  ) {
    return {
      data: block.source.data,
      mime: block.source.media_type,
      bytes: estimatedBase64Bytes(block.source.data),
    };
  }

  return null;
}

export function decodeBoundedToolResultImage(data: string): Uint8Array | null {
  if (
    data.length === 0 ||
    data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 4 ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    return null;
  }

  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_TOOL_RESULT_IMAGE_BYTES) return null;
  return new Uint8Array(bytes);
}
