import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeBoundedToolResultImage,
  MAX_TOOL_RESULT_IMAGE_BYTES,
  readBase64ToolResultImage,
} from "./session-tool-result-images.ts";

test("reads flat and source-wrapped base64 image blocks", () => {
  assert.deepEqual(
    readBase64ToolResultImage({ type: "image", data: "QUJDRA==", mimeType: "image/png" }),
    { data: "QUJDRA==", mime: "image/png", bytes: 4 },
  );
  assert.deepEqual(
    readBase64ToolResultImage({
      type: "image",
      source: { type: "base64", data: "QUJDRA==", media_type: "image/webp" },
    }),
    { data: "QUJDRA==", mime: "image/webp", bytes: 4 },
  );
});

test("bounded decoding rejects malformed and oversized base64 before serving it", () => {
  assert.deepEqual([...decodeBoundedToolResultImage("QUJDRA==")], [65, 66, 67, 68]);
  assert.equal(decodeBoundedToolResultImage("not-base64"), null);
  assert.equal(decodeBoundedToolResultImage("A".repeat(Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 8)), null);
});
