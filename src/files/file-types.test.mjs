import assert from "node:assert/strict";
import test from "node:test";
import {
  documentPreviewKind,
  getAudioMime,
  getDocumentMime,
  getFileExt,
  getImageMime,
} from "./file-types.ts";

test("image, audio, and document types are case-insensitive", () => {
  assert.equal(getImageMime("/tmp/screenshot.PNG"), "image/png");
  assert.equal(getAudioMime("C:\\Users\\me\\voice.OPUS"), "audio/ogg");
  assert.equal(getDocumentMime("/tmp/report.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(documentPreviewKind("/tmp/report.PDF"), "pdf");
  assert.equal(documentPreviewKind("/tmp/report.txt"), null);
});

test("extensions are extracted from POSIX and Windows paths", () => {
  assert.equal(getFileExt("/tmp/archive.tar.gz"), "gz");
  assert.equal(getFileExt("C:\\Users\\me\\photo.AVIF"), "avif");
});
