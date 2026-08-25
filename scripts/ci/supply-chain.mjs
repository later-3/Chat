import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

function normalizedPath(path) {
  return path.split(sep).join("/");
}

function dependencyEntries(manifest) {
  return Object.entries({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.devDependencies,
  });
}

/**
 * Manifest只声明期望值；真实闭包必须从Chat consumer、lockfile与已解析symlink反向恢复。
 * 这样新增link却忘记登记时会在漏洞分类前失败，而不是掉进whole-fork report-only。
 */
export function assertActualManagedLinks(manifest, options = {}) {
  const root = options.root ?? ROOT;
  const lockfile = parseYaml(readFileSync(resolve(root, "pnpm-lock.yaml"), "utf8"));
  const workspaces = workspacePackageManifests(root);
  const sourceRoots = new Map(
    manifest.sources.map((source) => [
      source.id,
      realpathSync(assertManagedSourceIdentity(source, root, { runtime: true })),
    ]),
  );
  const actual = new Map(manifest.sources.map((source) => [source.id, []]));

  for (const workspace of workspaces) {
    for (const [dependency, specifier] of dependencyEntries(workspace.manifest)) {
      if (typeof specifier !== "string" || !specifier.startsWith("link:")) continue;
      const declaredTarget = resolve(workspace.root, specifier.slice("link:".length));
      if (!existsSync(declaredTarget)) {
        throw new Error(`${workspace.consumer}:${dependency} link目标不存在`);
      }
      const target = realpathSync(declaredTarget);
      const source = manifest.sources.find((entry) => {
        const sourceRoot = sourceRoots.get(entry.id);
        return target === sourceRoot || target.startsWith(`${sourceRoot}${sep}`);
      });
      if (source === undefined) {
        if (target === realpathSync(root) || target.startsWith(`${realpathSync(root)}${sep}`)) {
          continue;
        }
        throw new Error(`${workspace.consumer}:${dependency}指向未受管外部link：${target}`);
      }
      const sourceRoot = sourceRoots.get(source.id);
      const sourcePath = normalizedPath(relative(sourceRoot, target));
      const importer = lockfile.importers?.[workspace.consumer];
      const locked = {
        ...importer?.dependencies,
        ...importer?.optionalDependencies,
        ...importer?.devDependencies,
      }[dependency];
      const lockedVersion = typeof locked === "string" ? locked : locked?.version;
      const lockedSpecifier = typeof locked === "object" ? locked?.specifier : undefined;
      if (
        typeof lockedVersion !== "string" ||
        !lockedVersion.startsWith("link:") ||
        (lockedSpecifier !== undefined && lockedSpecifier !== specifier)
      ) {
        throw new Error(`${workspace.consumer}:${dependency} package.json与lockfile link漂移`);
      }
      const resolvedDependency = resolve(workspace.root, "node_modules", ...dependency.split("/"));
      if (!existsSync(resolvedDependency) || realpathSync(resolvedDependency) !== target) {
        throw new Error(`${workspace.consumer}:${dependency}实际解析路径未指向固定Fork源码`);
      }
      actual.get(source.id).push({ consumer: workspace.consumer, dependency, sourcePath });
    }
  }

  for (const source of manifest.sources) {
    const expected = stableLinks(source.linkedPackages);
    const observed = stableLinks(actual.get(source.id));
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      throw new Error(
        `${source.id} Manifest linkedPackages与Chat实际Fork link不双向相等：expected=${JSON.stringify(expected)} actual=${JSON.stringify(observed)}`,
      );
    }
  }
  return Object.fromEntries(
    manifest.sources.map((source) => [source.id, stableLinks(actual.get(source.id))]),
  );
}

function stableLinks(links) {
  return [...links].sort((left, right) =>
    `${left.consumer}:${left.dependency}:${left.sourcePath}`.localeCompare(
      `${right.consumer}:${right.dependency}:${right.sourcePath}`,
    ),
  );
}

function workspacePackageManifests(root) {
  const entries = [];
  for (const parent of ["apps", "packages"]) {
    const directory = resolve(root, parent);
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name, "package.json");
      if (!existsSync(path)) continue;
      entries.push({
        consumer: `${parent}/${name}`,
        root: dirname(path),
        manifest: loadJson(path),
      });
    }
  }
  return entries;
}

function auditWorkspaceKey(path) {
  return path.split("/").join("__");
}

function exportedTargets(value, output = new Set()) {
  if (typeof value === "string") output.add(value);
  else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) exportedTargets(nested, output);
  }
  return output;
}

function builtArtifactImports(source, checkout, actualLinks) {
  const results = [];
  for (const linked of actualLinks) {
    const packageRoot = resolve(checkout, linked.sourcePath);
    const manifest = loadJson(resolve(packageRoot, "package.json"));
    const entrypoints = new Set([
      ...[...exportedTargets(manifest.exports)].filter((entry) => !entry.includes("*")),
      ...[manifest.main, manifest.module, manifest.browser].filter(
        (entry) => typeof entry === "string",
      ),
      ...Object.values(manifest.bin ?? {}).filter((entry) => typeof entry === "string"),
    ]);
    if (entrypoints.size === 0) {
      throw new Error(`${linked.dependency}没有可审计的exports/build入口`);
    }
    const queue = [...entrypoints].map((entry) => resolve(packageRoot, entry));
    const seen = new Set();
    const imports = new Set();
    while (queue.length > 0) {
      const artifact = queue.pop();
      if (!existsSync(artifact) || !statSync(artifact).isFile()) {
        throw new Error(
          `${linked.dependency}导出构建产物不存在：${normalizedPath(relative(checkout, artifact))}`,
        );
      }
      const real = realpathSync(artifact);
      if (!real.startsWith(`${realpathSync(packageRoot)}${sep}`) || seen.has(real)) continue;
      seen.add(real);
      if (!/\.(?:[cm]?js|jsx|ts|tsx)$/u.test(real)) continue;
      const text = readFileSync(real, "utf8");
      for (const match of text.matchAll(
        /\brequire\(["']([^"']+)["']\)|\bfrom\s+["']([^"']+)["']|\bimport\(["']([^"']+)["']\)/gu,
      )) {
        const specifier = match[1] ?? match[2] ?? match[3];
        if (specifier === undefined || specifier.startsWith("node:")) continue;
        if (!specifier.startsWith(".")) {
          imports.add(specifier);
          continue;
        }
        const base = resolve(dirname(real), specifier);
        const candidate = [
          base,
          `${base}.js`,
          `${base}.mjs`,
          `${base}.cjs`,
          resolve(base, "index.js"),
        ].find((path) => existsSync(path) && statSync(path).isFile());
        if (candidate !== undefined) queue.push(candidate);
      }
    }
    results.push({
      ...linked,
      entrypoints: [...entrypoints].sort(),
      externalImports: [...imports].sort(),
    });
  }
  return results;
}

function assertBuiltImportsResolveFromChat(source, artifacts) {
  const lockfile = readFileSync(resolve(ROOT, "pnpm-lock.yaml"), "utf8");
  for (const linked of artifacts) {
    const checkout = assertManagedSourceIdentity(source, ROOT, { runtime: true });
    const manifest = loadJson(resolve(checkout, linked.sourcePath, "package.json"));
    const declared = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    };
    for (const specifier of linked.externalImports) {
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

export function validateAuditJsonResult({ command, status, stdout, stderr = "" }) {
  if (![0, 1].includes(status) || typeof stdout !== "string" || stdout.trim() === "") {
    throw new Error(`${command} audit执行失败：${stderr.trim()}`);
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    throw new Error(`${command} audit未返回合法JSON`);
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error(`${command} audit返回的不是对象`);
  }
  if (report.error !== undefined) {
    throw new Error(`${command} audit返回错误对象`);
  }
  const counts = vulnerabilityCounts(report, { strict: true });
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const pnpmShape = report.advisories !== undefined;
  const npmShape = report.auditReportVersion !== undefined || report.vulnerabilities !== undefined;
  if (pnpmShape === npmShape) throw new Error(`${command} audit Schema无法识别或相互矛盾`);
  if (pnpmShape) {
    if (
      report.advisories === null ||
      typeof report.advisories !== "object" ||
      Array.isArray(report.advisories)
    ) {
      throw new Error(`${command} pnpm audit缺少advisories对象`);
    }
    for (const [id, advisory] of Object.entries(report.advisories)) {
      if (
        advisory?.id === undefined ||
        typeof advisory.module_name !== "string" ||
        !["info", "low", "moderate", "high", "critical"].includes(advisory.severity) ||
        typeof advisory.vulnerable_versions !== "string" ||
        typeof advisory.patched_versions !== "string" ||
        !Array.isArray(advisory.findings) ||
        advisory.findings.length === 0 ||
        advisory.findings.some(
          (finding) => typeof finding?.version !== "string" || !Array.isArray(finding.paths),
        )
      ) {
        throw new Error(`${command} pnpm advisory ${id}缺少版本、严重度或finding事实`);
      }
    }
    if (Object.keys(report.advisories).length !== total) {
      throw new Error(`${command} pnpm advisory数量与metadata漏洞总数矛盾`);
    }
  } else {
    if (report.auditReportVersion !== 2) throw new Error(`${command} npm auditReportVersion非法`);
    if (
      report.vulnerabilities === null ||
      typeof report.vulnerabilities !== "object" ||
      Array.isArray(report.vulnerabilities)
    ) {
      throw new Error(`${command} npm audit缺少vulnerabilities对象`);
    }
    const metadataTotal = report.metadata.vulnerabilities.total;
    if (!Number.isInteger(metadataTotal) || metadataTotal !== total) {
      throw new Error(`${command} npm metadata.vulnerabilities.total矛盾`);
    }
    for (const [name, vulnerability] of Object.entries(report.vulnerabilities)) {
      if (
        vulnerability?.name !== name ||
        !["info", "low", "moderate", "high", "critical"].includes(vulnerability.severity) ||
        !Array.isArray(vulnerability.via) ||
        !Array.isArray(vulnerability.effects) ||
        typeof vulnerability.range !== "string" ||
        !Array.isArray(vulnerability.nodes)
      ) {
        throw new Error(`${command} npm vulnerability ${name}缺少版本范围或依赖事实`);
      }
    }
  }
  if ((status === 0 && total !== 0) || (status === 1 && total === 0)) {
    throw new Error(`${command} audit退出状态与漏洞总数矛盾`);
  }
  return report;
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
  // npm/pnpm只有“0且零漏洞”或“1且存在合法漏洞事实”两种可接受结果。
  return validateAuditJsonResult({
    command: `${command} ${args.join(" ")}`,
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function vulnerabilityCounts(report, options = {}) {
  const counts = report.metadata?.vulnerabilities;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    throw new Error("audit缺少metadata.vulnerabilities");
  }
  const severities = ["info", "low", "moderate", "high", "critical"];
  if (
    options.strict === true &&
    severities.some((severity) => !Number.isInteger(counts[severity]) || counts[severity] < 0)
  ) {
    throw new Error("audit metadata.vulnerabilities缺少合法严重度计数");
  }
  return Object.fromEntries(severities.map((severity) => [severity, Number(counts[severity])]));
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
  const actualManagedLinks = assertActualManagedLinks(manifest);
  assertLifecycleAllowlist(policy);
  assertWorkflowSupplyChain();
  const secrets = scanTrackedSecrets();
  const licenses = assertProductionLicenses(policy, manifest);
  return {
    managedSources: manifest.sources.map((source) => ({ id: source.id, commit: source.commit })),
    secrets,
    licenses,
    actualManagedLinks,
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

  const dshLinks = report.actualManagedLinks.dsh;
  const dshImports = builtArtifactImports(dsh, dshCheckout, dshLinks);
  assertBuiltImportsResolveFromChat(dsh, dshImports);
  const dshWholeAudit = auditJson(
    "corepack",
    ["pnpm@11.7.0", "audit", "--prod", "--json"],
    dshCheckout,
  );
  const dshClassification = classifyPnpmWorkspaceAudit(
    dshWholeAudit,
    dshLinks.map((linked) => linked.sourcePath),
  );
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
