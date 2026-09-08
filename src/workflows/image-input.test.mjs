import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_WORKFLOW_IMAGES,
  assertModelSupportsImages,
  parseWorkflowImages,
} from "./image-input.ts";

// 1x1 transparent PNG; strictly-valid base64 within the 10MB bound.
const VALID_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VALID_IMAGE = { type: "image", data: VALID_BASE64, mimeType: "image/png" };

test("absent images stay undefined", () => {
  assert.equal(parseWorkflowImages(undefined), undefined);
});

test("a valid image list is parsed into Pi ImageContent", () => {
  assert.deepEqual(parseWorkflowImages([VALID_IMAGE]), [VALID_IMAGE]);
});

test("an empty image list is allowed (text-only prompt path)", () => {
  assert.deepEqual(parseWorkflowImages([]), []);
});

test("more than the maximum image count is rejected", () => {
  const images = Array.from({ length: MAX_WORKFLOW_IMAGES + 1 }, () => VALID_IMAGE);
  assert.throws(() => parseWorkflowImages(images), /最多包含/);
});

test("non-array images are rejected", () => {
  assert.throws(() => parseWorkflowImages({}), /images必须是数组/);
});

test("each image must be an image-typed object", () => {
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, type: "file" }]), /\.type必须是image/);
  assert.throws(() => parseWorkflowImages(["not-an-object"]), /必须是对象/);
});

test("image entries reject unknown fields", () => {
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, extra: 1 }]), /包含未知字段/);
});

test("image data must be non-empty valid base64 within the size bound", () => {
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, data: "" }]), /非空base64/);
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, data: "!!!not-base64!!!" }]), /有效的base64/);
  const oversized = { ...VALID_IMAGE, data: "AAAA".repeat((10 * 1024 * 1024) / 3 + 1024) };
  assert.throws(() => parseWorkflowImages([oversized]), /有效的base64|超过/);
});

test("mimeType must be an image type", () => {
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, mimeType: "text/plain" }]), /image\/\*/);
  assert.throws(() => parseWorkflowImages([{ ...VALID_IMAGE, mimeType: "image" }]), /image\/\*/);
});

const visionModel = { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", input: ["text", "image"] };
const textModel = { id: "qwen2.5-coder:7b", name: "Qwen Coder", provider: "ollama", input: ["text"] };

test("image-capable models pass the capability check", () => {
  assert.doesNotThrow(() => assertModelSupportsImages(visionModel, [VALID_IMAGE]));
});

test("text-only models are rejected with a friendly, model-naming error", () => {
  assert.throws(
    () => assertModelSupportsImages(textModel, [VALID_IMAGE]),
    /Qwen Coder（ollama\/qwen2\.5-coder:7b）不支持图片输入/,
  );
});

test("capability check is a no-op without images or without a resolved model", () => {
  assert.doesNotThrow(() => assertModelSupportsImages(textModel, undefined));
  assert.doesNotThrow(() => assertModelSupportsImages(textModel, []));
  assert.doesNotThrow(() => assertModelSupportsImages(undefined, [VALID_IMAGE]));
});
