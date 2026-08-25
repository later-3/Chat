import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { checkCompatibilityFacts } from "./compatibility-facts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = resolve(ROOT, "config/compatibility-policy.json");
const REQUIRED_RULES = Object.freeze([
  "read_old_write_current",
  "same_schema_literal_immutable",
  "new_write_semantics_require_new_generation",
  "read_only_legacy_cannot_expand_authority",
  "breaking_change_requires_detect_why_fix_verify_rollback",
  "breaking_change_requires_explicit_user_approval",
]);
const REQUIRED_DOMAINS = Object.freeze([
  "network-contracts",
  "product-store",
  "bridge-state",
  "workflow-run-spec",
  "direct-generic-journals",
  "browser-dto-events",
]);
const DOMAIN_OWNER_ROOTS = Object.freeze({
  "network-contracts": ["packages/contracts/src", "config/api-surface.baseline.json"],
  "product-store": ["packages/contracts/src/product-store.ts", "packages/product-store-json/src"],
  "bridge-state": ["packages/dsh-lifeos-bridge/src/state-store.ts"],
  "workflow-run-spec": ["packages/contracts/src", "packages/workflows/src"],
  "direct-generic-journals": ["packages/contracts/src", "packages/pi-runtime/src"],
  "browser-dto-events": ["packages/contracts/src", "packages/dsh-lifeos-bridge/src/client"],
});

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
}

function assertFactSource(path, domain) {
  if (
    typeof path !== "string" ||
    path === "" ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`compat factSource不是安全相对路径：${String(path)}`);
  }
  const target = resolve(ROOT, path);
  if (!isInside(ROOT, target) || !existsSync(target)) {
    throw new Error(`compat factSource不存在或越界：${path}`);
  }
  let current = ROOT;
  for (const segment of path.split("/")) {
    current = resolve(current, segment);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`compat factSource经过symlink：${path}`);
  }
  if (!isInside(realpathSync(ROOT), realpathSync(target))) {
    throw new Error(`compat factSource真实路径越界：${path}`);
  }
  if (/\.md$/u.test(path) || /README/iu.test(path)) {
    throw new Error(`compat factSource必须是可解析源码或机器baseline，不能是README：${path}`);
  }
  const allowed = DOMAIN_OWNER_ROOTS[domain];
  if (!allowed.some((root) => path === root || path.startsWith(`${root}/`))) {
    throw new Error(`${domain} factSource不是该域真实Owner：${path}`);
  }
}

export function validateCompatibilityPolicy(policy, options = {}) {
  if (policy === null || typeof policy !== "object" || policy.schemaVersion !== 2) {
    throw new Error("compatibility policy必须是schemaVersion=2对象");
  }
  if (
    !Array.isArray(policy.rules) ||
    JSON.stringify([...policy.rules].sort()) !== JSON.stringify([...REQUIRED_RULES].sort())
  ) {
    throw new Error("compatibility policy规则集合漂移");
  }
  if (!Array.isArray(policy.domains)) throw new Error("compatibility policy domains缺失");
  const ids = policy.domains.map((domain) => domain?.id);
  if (new Set(ids).size !== ids.length) throw new Error("compatibility policy domain重复");
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...REQUIRED_DOMAINS].sort())) {
    throw new Error("compatibility policy六类兼容域不完整");
  }
  for (const domain of policy.domains) {
    if (
      !Array.isArray(domain.ownerRoots) ||
      JSON.stringify([...domain.ownerRoots].sort()) !==
        JSON.stringify([...DOMAIN_OWNER_ROOTS[domain.id]].sort())
    ) {
      throw new Error(`${domain.id}真实Owner root漂移`);
    }
    if (!Array.isArray(domain.factSources) || domain.factSources.length === 0) {
      throw new Error(`${domain.id}缺少真实factSource`);
    }
    if (options.skipFilesystem !== true) {
      for (const path of domain.factSources) assertFactSource(path, domain.id);
    }
  }
  return policy;
}

export function loadCompatibilityPolicy() {
  return JSON.parse(readFileSync(POLICY_PATH, "utf8"));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const policy = validateCompatibilityPolicy(loadCompatibilityPolicy());
  checkCompatibilityFacts(policy);
  console.log(
    `compatibility policy有效：${String(policy.domains.length)}个域 / ${String(policy.rules.length)}条规则`,
  );
}
