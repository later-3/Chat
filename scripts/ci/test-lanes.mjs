import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createCiSafeEnvironment } from "./safe-environment.mjs";

const CHAT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MANIFEST_PATH = join(CHAT_ROOT, "config/test-lanes.json");
const TEST_LANES = Object.freeze([
  "core",
  "contract",
  "integration",
  "compat",
  "beta",
  "browser",
  "paid",
  "external",
]);
const RUNNABLE_LANES = new Set(["core", "contract", "integration", "compat", "beta"]);
const FORMAL_TEST_PATTERN = /(?:\.test\.(?:[cm]?[jt]sx?)|\.spec\.ts|\.real\.ts)$/u;

function walk(root, output = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".data", ".git"].includes(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, output);
    else output.push(path);
  }
  return output;
}

function formalTestFiles(root = CHAT_ROOT) {
  return ["apps", "packages", "scripts"]
    .flatMap((directory) => walk(join(root, directory)))
    .filter((path) => FORMAL_TEST_PATTERN.test(path))
    .map((path) => relative(root, path).split(sep).join("/"))
    .sort();
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`);
  }
}

export function loadTestLaneManifest(path = MANIFEST_PATH) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assertObject(manifest, "test lanes manifest");
  if (manifest.schemaVersion !== 1) throw new Error("test lanes schemaVersion必须为1");
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.rootScripts)) {
    throw new Error("test lanes files/rootScripts必须是数组");
  }
  if (!Array.isArray(manifest.deterministicLanes)) {
    throw new Error("test lanes deterministicLanes必须是数组");
  }
  assertObject(manifest.batch, "test lanes batch");
  assertObject(manifest.laneTasks, "test lanes laneTasks");
  return manifest;
}

export function auditTestLaneManifest(manifest, root = CHAT_ROOT) {
  const laneSet = new Set(TEST_LANES);
  const seenFiles = new Set();
  for (const entry of manifest.files) {
    assertObject(entry, "test lane file");
    if (typeof entry.path !== "string" || !FORMAL_TEST_PATTERN.test(entry.path)) {
      throw new Error(`正式测试路径无效：${String(entry.path)}`);
    }
    if (!laneSet.has(entry.lane))
      throw new Error(`${entry.path}使用未知lane：${String(entry.lane)}`);
    if (!["vitest", "node", "node-tsx", "node-dsh", "covered-by-command"].includes(entry.runner)) {
      throw new Error(`${entry.path}使用未知runner：${String(entry.runner)}`);
    }
    if (seenFiles.has(entry.path)) throw new Error(`正式测试重复分类：${entry.path}`);
    seenFiles.add(entry.path);
    if (!existsSync(join(root, entry.path))) throw new Error(`正式测试不存在：${entry.path}`);
  }

  const actualFiles = formalTestFiles(root);
  const missing = actualFiles.filter((path) => !seenFiles.has(path));
  const stale = [...seenFiles].filter((path) => !actualFiles.includes(path));
  if (missing.length > 0) throw new Error(`正式测试未分类：${missing.join(", ")}`);
  if (stale.length > 0) throw new Error(`lane引用不存在测试：${stale.join(", ")}`);

  const packageManifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const actualScripts = Object.keys(packageManifest.scripts).filter(
    (name) => name === "test" || name.startsWith("test:"),
  );
  const seenScripts = new Set();
  for (const entry of manifest.rootScripts) {
    assertObject(entry, "test lane root script");
    if (seenScripts.has(entry.name)) throw new Error(`根测试脚本重复分类：${entry.name}`);
    seenScripts.add(entry.name);
    if (packageManifest.scripts[entry.name] === undefined) {
      throw new Error(`lane引用不存在根测试脚本：${entry.name}`);
    }
    if (packageManifest.scripts[entry.name] !== entry.command) {
      throw new Error(`lane命令与Manifest漂移：${entry.name}`);
    }
    if (entry.kind === "lane") {
      if (!laneSet.has(entry.lane)) throw new Error(`${entry.name}缺少有效主要lane`);
    } else if (entry.kind === "aggregate") {
      if (!Array.isArray(entry.lanes) || entry.lanes.length === 0) {
        throw new Error(`${entry.name}聚合命令缺少lanes`);
      }
      for (const lane of entry.lanes)
        if (!laneSet.has(lane)) throw new Error(`${entry.name}未知lane`);
    } else {
      throw new Error(`${entry.name}必须是lane或aggregate命令`);
    }
  }
  const unclassifiedScripts = actualScripts.filter((name) => !seenScripts.has(name));
  const staleScripts = [...seenScripts].filter((name) => !actualScripts.includes(name));
  if (unclassifiedScripts.length > 0) {
    throw new Error(`根测试脚本未分类：${unclassifiedScripts.join(", ")}`);
  }
  if (staleScripts.length > 0) throw new Error(`Manifest根脚本不存在：${staleScripts.join(", ")}`);

  for (const [lane, tasks] of Object.entries(manifest.laneTasks)) {
    if (!laneSet.has(lane) || !Array.isArray(tasks)) throw new Error(`laneTasks无效：${lane}`);
    for (const task of tasks) {
      assertObject(task, `${lane} lane task`);
      if (!Array.isArray(task.command) || task.command.length === 0) {
        throw new Error(`${lane} lane task命令为空`);
      }
      if (typeof task.source !== "string" || !existsSync(join(root, task.source))) {
        throw new Error(`${lane} lane task引用不存在：${String(task.source)}`);
      }
    }
  }
  return { fileCount: actualFiles.length, rootScriptCount: actualScripts.length };
}

function workspaceFor(path) {
  const [kind, name] = path.split("/");
  return kind === "apps" || kind === "packages" ? `${kind}/${name}` : ".";
}

function chunk(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size)
    output.push(items.slice(index, index + size));
  return output;
}

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

function processTreeRss(rootPid) {
  let output;
  try {
    output = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
  } catch {
    return 0;
  }
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).map(Number))
    .filter(
      ([pid, parent, rss]) =>
        Number.isInteger(pid) && Number.isInteger(parent) && Number.isFinite(rss),
    );
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of rows) {
      if (descendants.has(parent) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return rows.reduce((sum, [pid, , rss]) => sum + (descendants.has(pid) ? rss * 1024 : 0), 0);
}

async function runMeasured(command, args, options) {
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let peakRssBytes = 0;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunkValue) => (stdout += chunkValue.toString()));
  child.stderr.on("data", (chunkValue) => (stderr += chunkValue.toString()));
  const sample = () => {
    if (child.pid !== undefined) peakRssBytes = Math.max(peakRssBytes, processTreeRss(child.pid));
  };
  sample();
  const sampler = setInterval(sample, 100);
  const result = await new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ error }));
    child.once("close", (status, signal) => resolveResult({ status, signal }));
  });
  clearInterval(sampler);
  sample();
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(stdout);
    process.stderr.write(stderr);
    throw new Error(
      `${options.label}失败：exit=${String(result.status)} signal=${String(result.signal)}`,
    );
  }
  return {
    stdout: stripAnsi(stdout),
    stderr: stripAnsi(stderr),
    wallMs: performance.now() - startedAt,
    peakRssBytes,
  };
}

function parseVitestMetrics(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const tests = [];
  for (const file of report.testResults ?? []) {
    for (const test of file.assertionResults ?? []) {
      tests.push({
        name: test.fullName ?? test.title ?? file.name,
        durationMs: typeof test.duration === "number" ? test.duration : 0,
      });
    }
  }
  return { count: report.numTotalTests ?? tests.length, tests };
}

function parseNodeMetrics(output) {
  const summaries = [...output.matchAll(/^ℹ tests (\d+)$/gmu)];
  const count = summaries.reduce((sum, match) => sum + Number(match[1]), 0);
  const tests = [...output.matchAll(/^[✔✖] (.+) \(([0-9.]+)ms\)$/gmu)].map((match) => ({
    name: match[1],
    durationMs: Number(match[2]),
  }));
  return { count, tests };
}

async function runVitestBatch(workspace, entries, context) {
  const manifest = JSON.parse(readFileSync(join(CHAT_ROOT, workspace, "package.json"), "utf8"));
  const relativeFiles = entries.map((entry) =>
    relative(join(CHAT_ROOT, workspace), join(CHAT_ROOT, entry.path)),
  );
  const reportPath = join(context.metricsRoot, `vitest-${String(context.batchIndex++)}.json`);
  let result;
  try {
    result = await runMeasured(
      "pnpm",
      [
        "--filter",
        manifest.name,
        "exec",
        "vitest",
        "run",
        ...relativeFiles,
        "--pool=forks",
        "--maxWorkers=2",
        "--no-file-parallelism",
        "--reporter=json",
        `--outputFile=${reportPath}`,
      ],
      {
        cwd: CHAT_ROOT,
        environment: context.environment,
        label: `${context.lane}/${workspace}`,
      },
    );
  } catch (error) {
    if (existsSync(reportPath)) {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const failures = (report.testResults ?? [])
        .flatMap((file) =>
          (file.assertionResults ?? [])
            .filter((assertion) => assertion.status === "failed")
            .map((assertion) => ({
              file: file.name,
              test: assertion.fullName ?? assertion.title,
              messages: assertion.failureMessages ?? [],
            })),
        )
        .slice(0, 10);
      console.error(JSON.stringify({ vitestFailures: failures }, null, 2));
    }
    throw error;
  }
  return { ...result, ...parseVitestMetrics(reportPath) };
}

async function runNodeBatch(workspace, runner, entries, context) {
  const cwd = workspace === "." ? CHAT_ROOT : join(CHAT_ROOT, workspace);
  const files = entries.map((entry) => relative(cwd, join(CHAT_ROOT, entry.path)));
  const args = [
    ...(runner === "node-tsx" || runner === "node-dsh" ? ["--import", "tsx"] : []),
    "--test",
    "--test-reporter=spec",
    ...files,
  ];
  const environment = {
    ...context.environment,
    ...(runner === "node-dsh"
      ? { TSX_TSCONFIG_PATH: "../../packages/dsh-lifeos-bridge/tsconfig.json" }
      : {}),
  };
  const result = await runMeasured(process.execPath, args, {
    cwd,
    environment,
    label: `${context.lane}/${workspace}/${runner}`,
  });
  return { ...result, ...parseNodeMetrics(`${result.stdout}\n${result.stderr}`) };
}

async function runTask(task, context) {
  const [command, ...args] = task.command;
  const result = await runMeasured(command, args, {
    cwd: CHAT_ROOT,
    environment: context.environment,
    label: `${context.lane}/${task.name}`,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  const countMatch = /(?:Tests|tests)\s+(\d+)\s+passed/u.exec(output);
  return {
    ...result,
    count: countMatch === null ? 1 : Number(countMatch[1]),
    tests: [{ name: task.name, durationMs: result.wallMs }],
  };
}

export async function runTestLane(lane, manifest = loadTestLaneManifest()) {
  auditTestLaneManifest(manifest);
  if (!RUNNABLE_LANES.has(lane)) {
    throw new Error(`${lane} lane只允许通过其显式手工命令运行`);
  }
  const environment = createCiSafeEnvironment(process.env);
  delete environment.NODE_OPTIONS;
  const metricsRoot = mkdtempSync(join(tmpdir(), `chat-test-${lane}-`));
  const context = { lane, environment, metricsRoot, batchIndex: 1 };
  const entries = manifest.files.filter(
    (entry) => entry.lane === lane && entry.runner !== "covered-by-command",
  );
  const groups = new Map();
  for (const entry of entries) {
    const key = `${workspaceFor(entry.path)}\0${entry.runner}`;
    const values = groups.get(key) ?? [];
    values.push(entry);
    groups.set(key, values);
  }

  const results = [];
  const startedAt = performance.now();
  try {
    for (const [key, files] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
      const [workspace, runner] = key.split("\0");
      const batchSize = runner === "vitest" ? manifest.batch.vitestFiles : manifest.batch.nodeFiles;
      for (const batch of chunk(files, batchSize)) {
        console.log(`[test:${lane}] ${workspace} ${runner} ${batch.length} files`);
        results.push(
          runner === "vitest"
            ? await runVitestBatch(workspace, batch, context)
            : await runNodeBatch(workspace, runner, batch, context),
        );
      }
    }
    for (const task of manifest.laneTasks[lane] ?? []) {
      console.log(`[test:${lane}] task ${task.name}`);
      results.push(await runTask(task, context));
    }
  } finally {
    rmSync(metricsRoot, { recursive: true, force: true });
  }

  const tests = results.flatMap((result) => result.tests);
  const metrics = {
    schemaVersion: 1,
    lane,
    fileCount: manifest.files.filter((entry) => entry.lane === lane).length,
    testCount: results.reduce((sum, result) => sum + result.count, 0),
    wallMs: performance.now() - startedAt,
    peakRssBytes: Math.max(0, ...results.map((result) => result.peakRssBytes)),
    slowest10: tests.sort((left, right) => right.durationMs - left.durationMs).slice(0, 10),
  };
  const outputRoot = join(CHAT_ROOT, "test-results/test-lanes");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(join(outputRoot, `${lane}.json`), `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(JSON.stringify(metrics, null, 2));
  return metrics;
}

export async function runAllDeterministic(manifest = loadTestLaneManifest()) {
  auditTestLaneManifest(manifest);
  const summaries = [];
  for (const lane of manifest.deterministicLanes) summaries.push(await runTestLane(lane, manifest));
  return summaries;
}

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  try {
    const [command = "audit", lane] = process.argv.slice(2);
    const manifest = loadTestLaneManifest();
    if (command === "audit") console.log(auditTestLaneManifest(manifest));
    else if (command === "run" && lane !== undefined) await runTestLane(lane, manifest);
    else if (command === "run-all") await runAllDeterministic(manifest);
    else throw new Error(`未知test lanes命令：${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
