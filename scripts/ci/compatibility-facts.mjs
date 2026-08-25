import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = resolve(ROOT, "config/compatibility-policy.json");
const BASELINE_PATH = resolve(ROOT, "config/compatibility-facts.baseline.json");
const VERSION_PATTERNS = Object.freeze({
  "product-store": /^chat-product-store\.v\d+$/u,
  "bridge-state": /^chat-dsh-lifeos-state\.v\d+$/u,
  "workflow-run-spec": /^workflow-run-spec\.v\d+$/u,
  "direct-generic-journals":
    /^(?:pi-(?:direct-)?executor(?:-operation-store)?|full-operation)\.v\d+$/u,
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

function json(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function walk(path, output = []) {
  if (statSync(path).isFile()) return [path];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) walk(target, output);
    else if (/\.(?:ts|tsx)$/u.test(entry.name) && !/\.(?:test|spec)\./u.test(entry.name)) {
      output.push(target);
    }
  }
  return output;
}

function normalized(node) {
  return ts
    .createPrinter({ removeComments: true })
    .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    .replace(/\s+/gu, " ")
    .trim();
}

function topLevelStatement(node) {
  let current = node;
  while (current.parent !== undefined && !ts.isSourceFile(current.parent)) current = current.parent;
  return current;
}

function sourceGenerations(domain, files) {
  const pattern = VERSION_PATTERNS[domain];
  if (pattern === undefined) return [];
  const evidence = new Map();
  for (const path of files) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const constants = new Map();
    const visit = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        ts.isStringLiteralLike(node.initializer) &&
        pattern.test(node.initializer.text)
      ) {
        constants.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const collect = (node) => {
      let generation;
      if (ts.isStringLiteralLike(node) && pattern.test(node.text)) generation = node.text;
      else if (ts.isIdentifier(node)) generation = constants.get(node.text);
      if (generation !== undefined) {
        const values = evidence.get(generation) ?? new Set();
        values.add(`${relative(ROOT, path)}:${normalized(topLevelStatement(node))}`);
        evidence.set(generation, values);
      }
      ts.forEachChild(node, collect);
    };
    collect(source);
  }
  return [...evidence]
    .map(([identity, values]) => ({
      identity,
      family: identity.replace(/v\d+$/u, ""),
      generation: Number(/v(\d+)$/u.exec(identity)?.[1]),
      canonicalSha256: sha256([...values].sort().join("\n")),
      evidenceCount: values.size,
    }))
    .sort((left, right) =>
      left.identity.localeCompare(right.identity, undefined, { numeric: true }),
    );
}

function apiGenerations() {
  const api = JSON.parse(readFileSync(resolve(ROOT, "config/api-surface.baseline.json"), "utf8"));
  // Browser只消费@chat/contracts/public；以该真实public entry生成的DTO/Event全集为上界，
  // 比手抄“浏览器可能用到的名称”更严格，也不会把内部Runtime合同带入事实集。
  const schemas = api.publicSchemas;
  const evidence = new Map();
  for (const schema of schemas) {
    for (const identity of schema.schemaVersions) {
      if (!/\.v\d+$/u.test(identity)) continue;
      const values = evidence.get(identity) ?? [];
      values.push(`${schema.name}:${schema.signatureSha256}`);
      evidence.set(identity, values);
    }
  }
  return [...evidence]
    .map(([identity, values]) => ({
      identity,
      family: identity.replace(/v\d+$/u, ""),
      generation: Number(/v(\d+)$/u.exec(identity)?.[1]),
      canonicalSha256: sha256(values.sort().join("\n")),
      evidenceCount: values.length,
    }))
    .sort((left, right) =>
      left.identity.localeCompare(right.identity, undefined, { numeric: true }),
    );
}

function compatibilityEntries(domain, files, generations) {
  if (["network-contracts", "browser-dto-events"].includes(domain)) {
    const api = JSON.parse(readFileSync(resolve(ROOT, "config/api-surface.baseline.json"), "utf8"));
    return api.publicSchemas
      .filter((schema) => schema.schemaVersions.length > 1)
      .map((schema) => ({
        entry: `schema:${schema.name}`,
        generations: [...schema.schemaVersions].sort(),
        canonicalSha256: schema.signatureSha256,
      }))
      .sort((left, right) => left.entry.localeCompare(right.entry));
  }
  const entries = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    const mentioned = generations.filter((generation) => text.includes(generation.identity));
    if (
      mentioned.length > 0 &&
      (/(?:legacy|migrat|readOld|read_old)/iu.test(text) || /migrate-v\d+-to-v\d+/u.test(path))
    ) {
      entries.push({
        entry: relative(ROOT, path).split(sep).join("/"),
        generations: mentioned.map((generation) => generation.identity),
        canonicalSha256: sha256(text),
      });
    }
  }
  return entries.sort((left, right) => left.entry.localeCompare(right.entry));
}

function currentAndHistorical(generations) {
  const currentByFamily = new Map();
  for (const generation of generations) {
    const current = currentByFamily.get(generation.family);
    if (current === undefined || generation.generation > current.generation) {
      currentByFamily.set(generation.family, generation);
    }
  }
  const current = [...currentByFamily.values()].map((entry) => entry.identity).sort();
  const currentSet = new Set(current);
  return {
    currentWriteGenerations: current,
    historicalReadableGenerations: generations
      .map((entry) => entry.identity)
      .filter((identity) => !currentSet.has(identity))
      .sort(),
  };
}

export function generateCompatibilityFacts(policy) {
  const domains = policy.domains.map((domain) => {
    const files = domain.factSources.flatMap((path) => walk(resolve(ROOT, path))).sort();
    const generations = ["network-contracts", "browser-dto-events"].includes(domain.id)
      ? apiGenerations()
      : sourceGenerations(domain.id, files);
    if (generations.length === 0) throw new Error(`${domain.id}未从真实Owner源码生成任何代际事实`);
    const split = currentAndHistorical(generations);
    return {
      id: domain.id,
      sourceFiles: files.map((path) => relative(ROOT, path).split(sep).join("/")),
      generations,
      ...split,
      compatibilityEntries: compatibilityEntries(domain.id, files, generations),
      legacyAuthority: "read_only",
      writeAuthority: "current_only",
      authorityBoundarySha256: sha256(
        json({ id: domain.id, owners: domain.ownerRoots, sources: domain.factSources }),
      ),
    };
  });
  return stable({ schemaVersion: "chat-compatibility-facts.v1", domains });
}

export function assertCompatibilityFactsCompatible(baseline, current) {
  const currentDomains = new Map(current.domains.map((domain) => [domain.id, domain]));
  for (const previous of baseline.domains) {
    const next = currentDomains.get(previous.id);
    if (next === undefined) throw new Error(`兼容事实域被删除：${previous.id}`);
    if (next.legacyAuthority !== "read_only" || next.writeAuthority !== "current_only") {
      throw new Error(`${previous.id}历史代际获得写权限或当前写Owner漂移`);
    }
    if (next.authorityBoundarySha256 !== previous.authorityBoundarySha256) {
      throw new Error(`${previous.id}事实Owner边界漂移`);
    }
    const generations = new Map(next.generations.map((entry) => [entry.identity, entry]));
    for (const generation of previous.generations) {
      const candidate = generations.get(generation.identity);
      if (candidate === undefined)
        throw new Error(`${previous.id}删除历史代际：${generation.identity}`);
      if (candidate.canonicalSha256 !== generation.canonicalSha256) {
        throw new Error(`${previous.id}同一schema literal原地语义漂移：${generation.identity}`);
      }
    }
    for (const currentIdentity of previous.currentWriteGenerations) {
      if (!next.currentWriteGenerations.includes(currentIdentity)) {
        const prior = previous.generations.find((entry) => entry.identity === currentIdentity);
        const replacement = next.generations.find(
          (entry) => entry.family === prior?.family && entry.generation > (prior?.generation ?? 0),
        );
        if (replacement === undefined) throw new Error(`${previous.id}写语义变化但未升代际`);
        if (
          !next.compatibilityEntries.some(
            (entry) =>
              entry.generations.includes(currentIdentity) &&
              entry.generations.includes(replacement.identity),
          )
        ) {
          throw new Error(`${previous.id}新代际缺少read-old/migration兼容入口`);
        }
      }
    }
  }
  return current;
}

export function assertCompatibilityFactsBaselineChain(baseBaseline, checkedInBaseline, current) {
  if (json(checkedInBaseline) !== json(current)) {
    throw new Error("compatibility facts生成结果与checked-in baseline漂移");
  }
  if (baseBaseline !== undefined) assertCompatibilityFactsCompatible(baseBaseline, current);
  return current;
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: "pipe" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    if (allowFailure) return undefined;
    throw new Error(`git ${args.join(" ")}失败：${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function resolveCompatibilityBaseSha() {
  const explicit = process.env.CHAT_COMPATIBILITY_BASE_SHA?.trim();
  if (explicit !== undefined && explicit !== "") {
    if (!/^[0-9a-f]{40}$/u.test(explicit)) {
      throw new Error("CHAT_COMPATIBILITY_BASE_SHA必须是完整40位commit");
    }
    if (/^0{40}$/u.test(explicit)) return undefined;
    return explicit;
  }
  for (const ref of ["main", "origin/main"]) {
    const candidate = git(["merge-base", "HEAD", ref], { allowFailure: true });
    if (candidate !== undefined && /^[0-9a-f]{40}$/u.test(candidate)) {
      const head = git(["rev-parse", "HEAD"]);
      if (candidate !== head) return candidate;
    }
  }
  return undefined;
}

function loadCompatibilityBase() {
  const sha = resolveCompatibilityBaseSha();
  if (sha === undefined) return { sha: undefined, baseline: undefined };
  git(["cat-file", "-e", `${sha}^{commit}`]);
  const source = git(["show", `${sha}:config/compatibility-facts.baseline.json`], {
    allowFailure: true,
  });
  return { sha, baseline: source === undefined ? undefined : JSON.parse(source) };
}

export function checkCompatibilityFacts(policy, options = {}) {
  const current = generateCompatibilityFacts(policy);
  if (!existsSync(BASELINE_PATH)) throw new Error("缺少checked-in compatibility facts baseline");
  const checkedInBaseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const compatibilityBase = loadCompatibilityBase();
  assertCompatibilityFactsBaselineChain(compatibilityBase.baseline, checkedInBaseline, current);
  if (options.quiet !== true) {
    console.log(`compatibility facts有效：${String(current.domains.length)}个真实Owner域`);
    if (compatibilityBase.sha !== undefined) {
      console.log(`compatibility facts base：${compatibilityBase.sha}`);
    }
  }
  return current;
}

export function updateCompatibilityFactsBaseline(policy) {
  writeFileSync(BASELINE_PATH, json(generateCompatibilityFacts(policy)), "utf8");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8"));
  const command = process.argv[2] ?? "generate";
  if (command === "generate") process.stdout.write(json(generateCompatibilityFacts(policy)));
  else if (command === "update-baseline") {
    updateCompatibilityFactsBaseline(policy);
    console.log("compatibility facts baseline已更新");
  } else if (command === "check") checkCompatibilityFacts(policy);
  else throw new Error(`未知compatibility facts命令：${command}`);
}
