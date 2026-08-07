import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve("packages/workflows/.workflow-bundle/runtime-build-evidence.json");
let evidence;
try {
  evidence = JSON.parse(await readFile(path, "utf8"));
} catch {
  throw new Error("真实闭环验收缺少可读取的Runtime构建证据");
}

if (
  evidence?.sourceState !== "clean" ||
  !/^[0-9a-f]{64}$/u.test(evidence.sourceManifestSha256 ?? "") ||
  !/^[0-9a-f]{64}$/u.test(evidence.bundleManifestSha256 ?? "")
) {
  throw new Error("真实闭环验收只接受clean源码与完整源码/bundle清单Hash；请先提交全部变更");
}

console.log("runtime build evidence: clean");
