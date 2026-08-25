import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { assertManagedSourceIdentity, loadManagedSourcesManifest } from "./managed-sources.mjs";
import { createCiSafeEnvironment } from "./safe-environment.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const POLICY_PATH = resolve(ROOT, "config/supply-chain-policy.json");
const ACTION_SHA = /^[^@\s]+@[0-9a-f]{40}$/u;

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: createCiSafeEnvironment(process.env),
    encoding: "utf8",
    stdio: options.capture === true ? "pipe" : "inherit",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")}失败${options.capture === true ? `：${result.stderr.trim()}` : ""}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function assertRelativeFile(value, label) {
  if (
    typeof value !== "string" ||
    value === "" ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${label}不是安全相对路径`);
  }
  const path = resolve(ROOT, value);
  readFileSync(path);
  return path;
}

export function validateSupplyChainPolicy(policy) {
  if (policy === null || typeof policy !== "object" || policy.schemaVersion !== 1) {
    throw new Error("supply-chain policy必须是schemaVersion=1对象");
  }
  assertRelativeFile(policy.managedSourcesManifest, "managedSourcesManifest");
  assertRelativeFile(policy.chatLockfile, "chatLockfile");
  for (const field of [
    "allowedProductionLicenses",
    "reviewedLicenseExceptions",
    "onlyBuiltDependencies",
  ]) {
    if (!Array.isArray(policy[field])) throw new Error(`supply-chain policy缺少${field}`);
  }
  if (policy.dshWholeForkAuditPolicy !== "report_only_outside_chat_closure") {
    throw new Error("DSH whole-fork audit只能作为Chat真实闭包之外的report-only债务");
  }
  if (new Set(policy.allowedProductionLicenses).size !== policy.allowedProductionLicenses.length) {
    throw new Error("production license allowlist重复");
  }
  for (const exception of policy.reviewedLicenseExceptions) {
    for (const field of ["source", "name", "version", "reportedLicense", "reason"]) {
      if (typeof exception?.[field] !== "string" || exception[field].trim() === "") {
        throw new Error(`license exception缺少${field}`);
      }
    }
    if (!["chat", "pi", "dsh"].includes(exception.source)) {
      throw new Error(`license exception来源无效：${exception.source}`);
    }
    if (exception.name.includes("*") && !/^[^*]+\*$/u.test(exception.name)) {
      throw new Error(`license exception只允许包名前缀尾随*：${exception.name}`);
    }
  }
  for (const entry of policy.onlyBuiltDependencies) {
    if (
      typeof entry?.name !== "string" ||
      typeof entry?.reason !== "string" ||
      entry.reason === ""
    ) {
      throw new Error("onlyBuiltDependencies必须逐项说明理由");
    }
  }
  return policy;
}

function assertManagedManifest(policy) {
  const manifest = loadManagedSourcesManifest(resolve(ROOT, policy.managedSourcesManifest));
  if (
    manifest.sources.length !== 2 ||
    !manifest.sources.some((source) => source.id === "pi") ||
    !manifest.sources.some((source) => source.id === "dsh")
  ) {
    throw new Error("Managed Sources必须精确锁定Pi与DSH两仓");
  }
  for (const source of manifest.sources) {
    if (!/^[0-9a-f]{40}$/u.test(source.commit)) throw new Error(`${source.id}未锁完整commit`);
    if (!source.installCommand.includes("--ignore-scripts")) {
      throw new Error(`${source.id}安装未禁用非受管lifecycle scripts`);
    }
    const checkout = assertManagedSourceIdentity(source, ROOT, { runtime: true });
    readFileSync(resolve(checkout, source.lockfile));
  }
  return manifest;
}

function assertLifecycleAllowlist(policy) {
  const workspace = parseYaml(readFileSync(resolve(ROOT, "pnpm-workspace.yaml"), "utf8"));
  const actual = [...(workspace.onlyBuiltDependencies ?? [])].sort();
  const expected = policy.onlyBuiltDependencies.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`install/build lifecycle allowlist漂移：${actual.join(", ")}`);
  }
}

function assertWorkflowSupplyChain() {
  const workflow = parseYaml(readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"));
  if (workflow.permissions?.contents !== "read") throw new Error("CI permissions不是contents:read");
  if (workflow.concurrency?.["cancel-in-progress"] !== true)
    throw new Error("CI缺少cancel-in-progress");
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.uses !== undefined && !ACTION_SHA.test(step.uses)) {
        throw new Error(`${jobName} Action未固定完整SHA：${String(step.uses)}`);
      }
      if (
        step.uses?.startsWith("actions/checkout@") &&
        step.with?.["persist-credentials"] !== false
      ) {
        throw new Error(`${jobName} checkout未关闭persist-credentials`);
      }
    }
  }
}

function secretPatterns() {
  return [
    ["OpenAI/通用sk", new RegExp(`s${"k"}-[A-Za-z0-9_-]{20,}`, "gu")],
    ["Anthropic", new RegExp(`s${"k"}-ant-[A-Za-z0-9_-]{20,}`, "gu")],
    ["GitHub classic", new RegExp(`g${"h"}[pousr]_[A-Za-z0-9]{20,}`, "gu")],
    ["GitHub fine-grained", new RegExp(`github_${"pat"}_[A-Za-z0-9_]{20,}`, "gu")],
    ["Google", new RegExp(`AI${"za"}[0-9A-Za-z_-]{35}`, "gu")],
    ["AWS access key", new RegExp(`AK${"IA"}[0-9A-Z]{16}`, "gu")],
    ["private key", new RegExp(`BEGIN (?:RSA |EC |OPENSSH )?PRIVATE ${"KEY"}`, "gu")],
  ];
}

export function scanTrackedSecrets() {
  const files = run("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    capture: true,
  })
    .split("\0")
    .filter(Boolean);
  const findings = [];
  for (const file of files) {
    const buffer = readFileSync(resolve(ROOT, file));
    if (buffer.includes(0)) continue;
    const source = buffer.toString("utf8");
    for (const [label, pattern] of secretPatterns()) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) findings.push({ file, label });
    }
  }
  if (findings.length > 0) {
    throw new Error(
      `secret scan命中${findings.length}项：${findings.map((entry) => `${entry.file}(${entry.label})`).join(", ")}`,
    );
  }
  return { fileCount: files.length, findingCount: 0 };
}

function licenseExceptionMatches(exception, source, name, version, license) {
  const nameMatches = exception.name.endsWith("*")
    ? name.startsWith(exception.name.slice(0, -1))
    : name === exception.name;
  return (
    exception.source === source &&
    nameMatches &&
    exception.version === version &&
    exception.reportedLicense === license
  );
}

function validateProductionLicenseReport(policy, source, report) {
  const allowed = new Set(policy.allowedProductionLicenses);
  let packageCount = 0;
  for (const [license, packages] of Object.entries(report)) {
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        packageCount += 1;
        if (
          !allowed.has(license) &&
          !policy.reviewedLicenseExceptions.some((exception) =>
            licenseExceptionMatches(exception, source, pkg.name, version, license),
          )
        ) {
          throw new Error(
            `未审查${source} production license：${pkg.name}@${version} (${license})`,
          );
        }
      }
    }
  }
  return { source, packageCount, licenseKinds: Object.keys(report).length };
}

function collectLinkedRuntimeLicenseReport(source, checkout) {
  const queue = source.linkedPackages.map((linked) =>
    resolve(checkout, linked.sourcePath, "package.json"),
  );
  const seen = new Set();
  const report = {};
  const findDependency = (fromPackageJson, dependency) => {
    let current = dirname(fromPackageJson);
    while (current === checkout || current.startsWith(`${checkout}${sep}`)) {
      const candidate = join(current, "node_modules", ...dependency.split("/"), "package.json");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  };
  while (queue.length > 0) {
    const packageJson = realpathSync(queue.pop());
    if (!packageJson.startsWith(`${checkout}${sep}`)) {
      throw new Error(`${source.id} runtime dependency越出固定checkout：${packageJson}`);
    }
    if (seen.has(packageJson)) continue;
    seen.add(packageJson);
    const manifest = loadJson(packageJson);
    const license = typeof manifest.license === "string" ? manifest.license : "Unknown";
    report[license] ??= [];
    report[license].push({ name: manifest.name, versions: [manifest.version] });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const resolved = findDependency(packageJson, dependency);
      if (resolved === undefined) {
        throw new Error(`${manifest.name}缺少production dependency：${dependency}`);
      }
      queue.push(resolved);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      const resolved = findDependency(packageJson, dependency);
      if (resolved !== undefined) queue.push(resolved);
    }
  }
  return report;
}

function linkedWorkspacePaths(source) {
  return [...new Set(source.linkedPackages.map((linked) => linked.sourcePath))].sort();
}

function auditWorkspaceKey(path) {
  return path.split("/").join("__");
}

function builtArtifactImports(source, checkout) {
  const imports = new Set();
  for (const marker of source.runtimeMarkers) {
    const artifact = resolve(checkout, marker.path);
    const text = readFileSync(artifact, "utf8");
    for (const match of text.matchAll(
      /\brequire\(["']([^"']+)["']\)|\bfrom\s+["']([^"']+)["']/gu,
    )) {
      const specifier = match[1] ?? match[2];
      if (specifier !== undefined && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
        imports.add(specifier);
      }
    }
  }
  return [...imports].sort();
}

function assertBuiltImportsResolveFromChat(source, imports) {
  const lockfile = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  for (const linked of source.linkedPackages) {
    const checkout = assertManagedSourceIdentity(source, ROOT, { runtime: true });
    const manifest = loadJson(resolve(checkout, linked.sourcePath, "package.json"));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const specifier of imports) {
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (declared[packageName] === undefined) {
        throw new Error(`${source.id}构建产物import未由链接源包声明：${specifier}`);
      }
      if (!lockfile.includes(`'${packageName}@`) && !lockfile.includes(`  ${packageName}@`)) {
        throw new Error(`${source.id}构建产物import未进入Chat锁文件闭包：${specifier}`);
      }
    }
  }
}

function auditJson(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: createCiSafeEnvironment(process.env),
    encoding: "utf8",
    stdio: "pipe",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  // npm/pnpm在发现漏洞时返回1；网络、锁文件或命令错误不得伪装成漏洞报告。
  if (![0, 1].includes(result.status ?? -1) || result.stdout.trim() === "") {
    throw new Error(`${command} ${args.join(" ")} audit执行失败：${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${command} audit未返回合法JSON`);
  }
}

function vulnerabilityCounts(report) {
  const counts = report.metadata?.vulnerabilities ?? {};
  return Object.fromEntries(
    ["info", "low", "moderate", "high", "critical"].map((severity) => [
      severity,
      Number(counts[severity] ?? 0),
    ]),
  );
}

export function classifyPnpmWorkspaceAudit(report, workspacePaths) {
  const closureKeys = new Set(workspacePaths.map(auditWorkspaceKey));
  const inClosure = [];
  const outsideClosure = [];
  for (const [advisoryId, advisory] of Object.entries(report.advisories ?? {})) {
    const paths = (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []);
    const entry = {
      advisoryId,
      moduleName: advisory.module_name,
      severity: advisory.severity,
      paths: [...new Set(paths)].sort(),
    };
    const target = paths.some((path) => closureKeys.has(String(path).split(">")[0]))
      ? inClosure
      : outsideClosure;
    target.push(entry);
  }
  return {
    workspacePaths: [...workspacePaths].sort(),
    inClosure: inClosure.sort((left, right) => left.advisoryId.localeCompare(right.advisoryId)),
    outsideClosure: outsideClosure.sort((left, right) =>
      left.advisoryId.localeCompare(right.advisoryId),
    ),
    wholeForkSeverityCounts: vulnerabilityCounts(report),
  };
}

export function assertNoManagedClosureVulnerabilities(classification, sourceId) {
  if (classification.inClosure.length > 0) {
    throw new Error(
      `${sourceId} Chat真实闭包命中${String(classification.inClosure.length)}个漏洞：${classification.inClosure
        .map((entry) => `${entry.advisoryId}:${entry.moduleName}`)
        .join(", ")}`,
    );
  }
}

function assertProductionLicenses(policy, manifest) {
  const pi = manifest.sources.find((source) => source.id === "pi");
  const dsh = manifest.sources.find((source) => source.id === "dsh");
  if (pi === undefined || dsh === undefined) throw new Error("Manifest缺少Pi或DSH");
  const piCheckout = assertManagedSourceIdentity(pi, ROOT, { runtime: true });
  const dshCheckout = assertManagedSourceIdentity(dsh, ROOT, { runtime: true });
  const chatReport = JSON.parse(
    run("pnpm", ["licenses", "list", "--prod", "--json"], { capture: true }),
  );
  const dshLinkedReport = collectLinkedRuntimeLicenseReport(dsh, dshCheckout);
  return {
    chat: validateProductionLicenseReport(policy, "chat", chatReport),
    pi: validateProductionLicenseReport(
      policy,
      "pi",
      collectLinkedRuntimeLicenseReport(pi, piCheckout),
    ),
    dsh: validateProductionLicenseReport(policy, "dsh", dshLinkedReport),
  };
}

export function runSupplyChainCheck() {
  const policy = validateSupplyChainPolicy(loadJson(POLICY_PATH));
  // Manifest本身是三仓唯一版本事实；这里验证其结构、完整SHA、锁文件和禁用安装脚本，
  // 不在第二个policy文件重复commit。
  const manifest = assertManagedManifest(policy);
  assertLifecycleAllowlist(policy);
  assertWorkflowSupplyChain();
  const secrets = scanTrackedSecrets();
  const licenses = assertProductionLicenses(policy, manifest);
  return {
    managedSources: manifest.sources.map((source) => ({ id: source.id, commit: source.commit })),
    secrets,
    licenses,
    onlyBuiltDependencies: policy.onlyBuiltDependencies.map((entry) => entry.name),
  };
}

export function runSupplyChainAudit() {
  const report = runSupplyChainCheck();
  const manifest = loadManagedSourcesManifest();
  const chatAudit = auditJson("pnpm", ["audit", "--prod", "--json"], ROOT);
  if (Object.values(vulnerabilityCounts(chatAudit)).some((count) => count > 0)) {
    throw new Error("Chat production闭包存在audit漏洞");
  }
  const pi = manifest.sources.find((source) => source.id === "pi");
  const dsh = manifest.sources.find((source) => source.id === "dsh");
  if (pi === undefined || dsh === undefined) throw new Error("Manifest缺少Pi或DSH");
  const piCheckout = assertManagedSourceIdentity(pi, ROOT, { runtime: true });
  const dshCheckout = assertManagedSourceIdentity(dsh, ROOT, { runtime: true });
  const piAudit = auditJson("npm", ["audit", "--omit=dev", "--json"], piCheckout);
  if (Object.values(vulnerabilityCounts(piAudit)).some((count) => count > 0)) {
    throw new Error("Pi受管执行闭包存在audit漏洞");
  }

  const dshImports = builtArtifactImports(dsh, dshCheckout);
  assertBuiltImportsResolveFromChat(dsh, dshImports);
  const dshWholeAudit = auditJson(
    "corepack",
    ["pnpm@11.7.0", "audit", "--prod", "--json"],
    dshCheckout,
  );
  const dshClassification = classifyPnpmWorkspaceAudit(dshWholeAudit, linkedWorkspacePaths(dsh));
  assertNoManagedClosureVulnerabilities(dshClassification, "DSH");
  return {
    ...report,
    auditClosures: {
      chatProduction: { severityCounts: vulnerabilityCounts(chatAudit) },
      piLinkedExecution: {
        linkedWorkspacePaths: linkedWorkspacePaths(pi),
        severityCounts: vulnerabilityCounts(piAudit),
      },
      dshLinkedBuiltBundledRuntime: {
        linkedWorkspacePaths: dshClassification.workspacePaths,
        builtArtifactImports: dshImports,
        advisoryCount: dshClassification.inClosure.length,
      },
      dshWholeForkDebt: {
        policy: "report_only_outside_chat_closure",
        advisoryCount: dshClassification.outsideClosure.length,
        severityCounts: dshClassification.wholeForkSeverityCounts,
        advisories: dshClassification.outsideClosure,
      },
    },
  };
}

async function main() {
  const command = process.argv[2] ?? "check";
  const report =
    command === "audit"
      ? runSupplyChainAudit()
      : command === "check"
        ? runSupplyChainCheck()
        : undefined;
  if (report === undefined) throw new Error(`未知supply-chain命令：${command}`);
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
