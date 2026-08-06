import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root index is a self-contained file URL deliverable", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /<style>/);
  assert.match(html, /<script type="module">/);
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc=/i);
  assert.doesNotMatch(html, /<link\b[^>]*\brel="stylesheet"/i);
  assert.doesNotMatch(html, /(?:src|href)="\/assets\//i);
});
