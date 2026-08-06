#!/usr/bin/env node
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = path.join(root, "dist", "client");
const builtEntry = path.join(clientRoot, "vite-entry.html");

const source = await readFile(builtEntry, "utf8");
const scriptMatch = source.match(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/i);
const styleMatch = source.match(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/i);

if (!scriptMatch || !styleMatch) {
  throw new Error("Unable to locate the Vite JavaScript and CSS assets for standalone output");
}

function localAssetPath(reference) {
  const pathname = new URL(reference, "https://standalone.invalid/").pathname;
  return path.join(clientRoot, pathname.replace(/^\/+/, ""));
}

const [javascript, stylesheet] = await Promise.all([
  readFile(localAssetPath(scriptMatch[1]), "utf8"),
  readFile(localAssetPath(styleMatch[1]), "utf8"),
]);

const standalone = source
  .replace(styleMatch[0], () => `<style>${stylesheet.replace(/<\/style/gi, "<\\/style")}</style>`)
  .replace(
    scriptMatch[0],
    () => `<script type="module">${javascript.replace(/<\/script/gi, "<\\/script")}</script>`,
  );

await Promise.all([
  writeFile(path.join(root, "index.html"), standalone, "utf8"),
  writeFile(path.join(clientRoot, "index.html"), standalone, "utf8"),
]);
await unlink(builtEntry);

console.log("Built standalone file:// entry: index.html");
