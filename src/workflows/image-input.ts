import type { ImageContent } from "@earendil-works/pi-ai";
import { decodeBoundedToolResultImage } from "../session-tool-result-images.js";

/**
 * Workflow用户输入图片的公共校验与能力检查。
 * Chat Web的图片附件上限与Pi Tool结果图片上限保持一致：
 * 单张解码后不超过10MB，一条消息最多10张，避免超大base64进入Pi Session。
 */
export const MAX_WORKFLOW_IMAGES = 10;
export const MAX_WORKFLOW_IMAGE_BYTES = 10 * 1024 * 1024;

/** Subset of the Pi Model contract needed to decide image-input capability. */
export interface ImageInputModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly input: readonly ("text" | "image")[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strictly parses the browser-submitted `images` field of a Workflow prompt.
 * Returns undefined when the field is absent; throws an actionable error for
 * malformed, oversized or non-image entries. The accepted wire shape matches
 * Pi's ImageContent: `{ type: "image", data, mimeType }`.
 */
export function parseWorkflowImages(value: unknown): ImageContent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("images必须是数组");
  if (value.length > MAX_WORKFLOW_IMAGES) {
    throw new Error(`一条消息最多包含${String(MAX_WORKFLOW_IMAGES)}张图片`);
  }
  const images: ImageContent[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) throw new Error(`images[${String(index)}]必须是对象`);
    const unknownFields = Object.keys(item).filter((field) => !["type", "data", "mimeType"].includes(field));
    if (unknownFields.length > 0) {
      throw new Error(`images[${String(index)}]包含未知字段: ${unknownFields.join(", ")}`);
    }
    if (item.type !== "image") throw new Error(`images[${String(index)}].type必须是image`);
    if (typeof item.data !== "string" || item.data.trim() === "") {
      throw new Error(`images[${String(index)}].data必须是非空base64字符串`);
    }
    if (typeof item.mimeType !== "string" || !item.mimeType.startsWith("image/")) {
      throw new Error(`images[${String(index)}].mimeType必须是image/*类型`);
    }
    if (decodeBoundedToolResultImage(item.data) === null) {
      throw new Error(
        `images[${String(index)}]不是有效的base64图片数据，或超过${String(MAX_WORKFLOW_IMAGE_BYTES / (1024 * 1024))}MB`,
      );
    }
    images.push({ type: "image", data: item.data, mimeType: item.mimeType });
  }
  return images;
}

/**
 * Guards a prompt carrying images against a model that cannot consume them.
 * The effective Pi model is the single source of truth: built-in vision models
 * declare `input: ["text", "image"]`; custom models default to text-only, and
 * an absent model is treated as unknown and left for the provider to reject.
 */
export function assertModelSupportsImages(
  model: ImageInputModel | undefined,
  images: readonly ImageContent[] | undefined,
): void {
  if (images === undefined || images.length === 0 || model === undefined) return;
  if (model.input.includes("image")) return;
  throw new Error(
    `当前模型 ${model.name}（${model.provider}/${model.id}）不支持图片输入，请更换支持图片的模型后重试，或移除图片`,
  );
}
