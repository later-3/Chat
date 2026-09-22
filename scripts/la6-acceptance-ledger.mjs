// LA6 D 可重入验收收集器：跨会话保存候选指纹、资源采样与业务发生账本。
// 24h 结论只能来自真实经过的时间；本脚本不加速时钟，也不把短跑拼成 24h。
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LEDGER_SCHEMA_VERSION = 1;
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function ledgerPath(chatHome) {
  return path.join(chatHome, "runtime", "la6-acceptance", "ledger.json");
}

export function readLedger(chatHome) {
  try {
    const value = JSON.parse(fs.readFileSync(ledgerPath(chatHome), "utf8"));
    if (value?.schemaVersion !== LEDGER_SCHEMA_VERSION) throw new Error("LA6 账本 schemaVersion 无效");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function writeLedger(chatHome, ledger) {
  const file = ledgerPath(chatHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch { return "unknown"; }
}

const FINGERPRINT_EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".data", "dist", "build", ".next", "coverage", "tmp", ".cache", ".turbo", "vendor"]);
const FINGERPRINT_EXCLUDED_BASENAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.crt$/i, /\.p8$/i, /^credentials/i, /\.log$/i, /\.sqlite$/i, /\.db$/i];
function fingerprintExcluded(rel) {
  const parts = String(rel).split("/");
  if (parts.some((part) => FINGERPRINT_EXCLUDED_SEGMENTS.has(part))) return true;
  const base = parts[parts.length - 1];
  return FINGERPRINT_EXCLUDED_BASENAMES.some((pattern) => pattern.test(base));
}

/**
 * Fingerprint the exact working tree candidate: HEAD identity is compared separately, so here we cover
 * staged + unstaged tracked changes and untracked source content. Runtime data and credentials are
 * excluded, and an unreadable entry throws instead of producing a fingerprint that could pass.
 */
function gitOrThrow(args, cwd, label, input) {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
      ...(input === undefined ? {} : { input }),
    }).trim();
  } catch (error) {
    throw new Error(`无法读取${label}：${cwd}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

function dirtyHash(cwd) {
  const hash = createHash("sha256");
  const status = gitOrThrow(["status", "--porcelain=v1"], cwd, "候选工作区状态");
  hash.update(`status\0${status}\0`);
  const hasHead = git(["rev-parse", "--verify", "HEAD"], cwd) !== "unknown";
  const diff = hasHead
    ? gitOrThrow(["diff", "HEAD", "--binary", "--no-color"], cwd, "候选差异")
    : `${gitOrThrow(["diff", "--cached", "--binary", "--no-color"], cwd, "候选暂存差异")}\n${gitOrThrow(["diff", "--binary", "--no-color"], cwd, "候选工作区差异")}`;
  hash.update(`diff\0${diff}\0`);
  const untracked = gitOrThrow(["ls-files", "--others", "--exclude-standard", "-z"], cwd, "未跟踪候选文件列表");
  const untrackedList = untracked.split("\0").filter(Boolean).filter((rel) => !fingerprintExcluded(rel)).sort();
  if (untrackedList.length > 0) {
    // One batched git call instead of one process per file: fingerprinting stays cheap enough to not
    // starve the other verification suites.
    const output = gitOrThrow(["hash-object", "--stdin-paths"], cwd, "未跟踪候选文件内容", `${untrackedList.join("\n")}\n`);
    const blobs = output === "" ? [] : output.split("\n");
    if (blobs.length !== untrackedList.length) throw new Error(`无法读取未跟踪候选文件内容：${cwd}`);
    for (let index = 0; index < untrackedList.length; index += 1) {
      if (!/^[0-9a-f]{40,64}$/.test(blobs[index])) throw new Error(`无法读取未跟踪候选文件内容：${untrackedList[index]}`);
      hash.update(`file\0${untrackedList[index]}\0${blobs[index]}\0`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export function candidateFingerprint() {
  const submodules = {};
  for (const name of ["frontend", "pi", "nanoclaw"]) {
    const cwd = path.join(projectRoot, name);
    submodules[name] = {
      head: git(["-C", cwd, "rev-parse", "HEAD"]),
      dirty: git(["-C", cwd, "status", "--porcelain"]).split("\n").filter(Boolean).length,
      dirtyHash: dirtyHash(cwd),
    };
  }
  return {
    parentHead: git(["rev-parse", "HEAD"], projectRoot),
    parentDirty: git(["status", "--porcelain"], projectRoot).split("\n").filter(Boolean).length,
    parentDirtyHash: dirtyHash(projectRoot),
    submodules,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Read-only durable fact resolution. The returned `expectedId -> {status, at, source}` map is derived
 * from the actual durable object referenced by `record.durableRef`; a caller-declared status string is
 * never accepted as a verified fact.
 *
 * Supported refs: `delivery` (conversation deliveries), `discussion` (group discussions), `duty`
 * (Friend duties, optionally a specific applied progress entry), `task` (task occurrences) and
 * `artifact` (deliverables). An unknown kind or a missing object resolves to nothing, which fails
 * verification rather than passing silently.
 */
export async function resolveDurableFacts(chatHome, records) {
  const root = path.resolve(chatHome);
  const facts = {};
  for (const record of Array.isArray(records) ? records : []) {
    if (record === null || typeof record !== "object" || record.kind !== "occurrence") continue;
    const fact = await readDurableObject(root, record.durableRef);
    if (fact !== null && typeof record.expectedId === "string") facts[record.expectedId] = fact;
  }
  return facts;
}

async function readDurableObject(root, ref) {
  if (ref === null || typeof ref !== "object" || typeof ref.kind !== "string") return null;
  switch (ref.kind) {
    case "delivery": {
      if (typeof ref.storageProjectId !== "string" || typeof ref.conversationId !== "string" || typeof ref.deliveryId !== "string") return null;
      const state = await readJsonWithin(root, "projects", ref.storageProjectId, "conversations", ref.conversationId, "deliveries.json");
      const delivery = listOf(state, "deliveries").find((item) => item.deliveryId === ref.deliveryId);
      if (delivery === undefined) return null;
      return {
        status: delivery.status === "delivered" ? "success" : delivery.status === "failed" ? "failed" : "pending",
        at: text(delivery.updatedAt), source: `delivery:${ref.conversationId}:${ref.deliveryId}`,
      };
    }
    case "discussion": {
      if (typeof ref.storageProjectId !== "string" || typeof ref.conversationId !== "string" || typeof ref.discussionId !== "string") return null;
      const state = await readJsonWithin(root, "projects", ref.storageProjectId, "conversations", ref.conversationId, "discussions.json");
      const discussion = listOf(state, "discussions").find((item) => item.discussionId === ref.discussionId);
      if (discussion === undefined) return null;
      const status = discussion.status === "completed" ? "success"
        : ["failed", "interrupted", "stopped"].includes(discussion.status) ? "failed" : "pending";
      return { status, at: text(discussion.updatedAt), source: `discussion:${ref.conversationId}:${ref.discussionId}` };
    }
    case "duty": {
      if (typeof ref.longAgentId !== "string" || typeof ref.dutyId !== "string") return null;
      const state = await readJsonWithin(root, "long-agents", ref.longAgentId, "duties.json");
      const duty = listOf(state, "duties").find((item) => item.id === ref.dutyId);
      if (duty === undefined) return null;
      const applied = listOf(duty, "progress").filter((entry) => entry.applied === true && text(entry.at) !== null);
      const progress = typeof ref.progressEntryId === "string"
        ? applied.find((entry) => entry.id === ref.progressEntryId)
        : applied[applied.length - 1];
      if (typeof ref.progressEntryId === "string" && progress === undefined) return null;
      if (progress !== undefined) {
        return { status: "success", at: text(progress.at), source: `duty:${ref.dutyId}:progress:${String(progress.id)}` };
      }
      const failures = listOf(duty, "advancements").filter((entry) => entry.status === "failed");
      const lastFailure = failures[failures.length - 1];
      if (lastFailure !== undefined) {
        return { status: "failed", at: text(lastFailure.at), source: `duty:${ref.dutyId}:advancement:${String(lastFailure.advancementKey)}` };
      }
      return { status: "pending", at: text(duty.updatedAt), source: `duty:${ref.dutyId}` };
    }
    case "task": {
      if (typeof ref.longAgentId !== "string") return null;
      const state = await readJsonWithin(root, "long-agents", ref.longAgentId, "tasks.json");
      const candidates = listOf(state, "occurrences").filter((item) => typeof ref.taskId !== "string" || item.taskId === ref.taskId);
      const occurrence = typeof ref.occurrenceId === "string"
        ? candidates.find((item) => item.id === ref.occurrenceId)
        : candidates[candidates.length - 1];
      if (occurrence === undefined) return null;
      return resolveTaskOccurrenceFact(root, occurrence);
    }
    case "artifact": {
      if (typeof ref.longAgentId !== "string" || typeof ref.artifactId !== "string") return null;
      const state = await readJsonWithin(root, "long-agents", ref.longAgentId, "artifacts.json");
      const artifact = listOf(state, "artifacts").find((item) => item.id === ref.artifactId);
      if (artifact === undefined) return null;
      return {
        status: artifact.state === "committed" ? "success" : artifact.state === "failed" ? "failed" : "pending",
        at: text(artifact.updatedAt), source: `artifact:${ref.artifactId}`,
      };
    }
    default:
      // Unknown kinds stay unresolved so they fail verification instead of passing silently.
      return null;
  }
}

/**
 * Read-only export of durable business occurrences inside `[from, to]` (ISO, inclusive). It derives the
 * expected occurrence list from the real duty/task/artifact/discussion/delivery objects so the
 * acceptance operator links `expectedId` to a durable `durableRef` instead of hand-writing statuses.
 */
export async function collectDurableOccurrences(chatHome, options = {}) {
  const root = path.resolve(chatHome);
  const from = options.from;
  const to = options.to;
  const within = (at) => typeof at === "string" && (from === undefined || at >= from) && (to === undefined || at <= to);
  const occurrences = [];
  const push = (entry) => { if (within(entry.at)) occurrences.push(entry); };

  for (const agent of await safeDirectories(path.join(root, "long-agents"))) {
    const dutyState = await readJsonWithin(root, "long-agents", agent, "duties.json");
    for (const duty of listOf(dutyState, "duties")) {
      for (const entry of listOf(duty, "progress").filter((candidate) => candidate.applied === true && text(candidate.at) !== null)) {
        push({ kind: "duty", expectedId: `duty:${String(duty.id)}:${String(entry.id)}`, at: entry.at, status: "success", source: `duty:${String(duty.id)}:progress:${String(entry.id)}`, durableRef: { kind: "duty", longAgentId: agent, dutyId: duty.id, progressEntryId: entry.id } });
      }
      for (const failure of listOf(duty, "advancements").filter((candidate) => candidate.status === "failed" && text(candidate.at) !== null)) {
        push({ kind: "duty", expectedId: `duty:${String(duty.id)}:${String(failure.advancementKey)}`, at: failure.at, status: "failed", source: `duty:${String(duty.id)}:advancement:${String(failure.advancementKey)}`, durableRef: { kind: "duty", longAgentId: agent, dutyId: duty.id } });
      }
    }
    const taskState = await readJsonWithin(root, "long-agents", agent, "tasks.json");
    for (const occurrence of listOf(taskState, "occurrences")) {
      const fact = await resolveTaskOccurrenceFact(root, occurrence);
      if (fact.at === null) continue;
      push({ kind: "task", expectedId: `task:${String(occurrence.taskId)}:${String(occurrence.id)}`, at: fact.at, status: fact.status, source: fact.source, durableRef: { kind: "task", longAgentId: agent, taskId: occurrence.taskId, occurrenceId: occurrence.id } });
    }
    const artifactState = await readJsonWithin(root, "long-agents", agent, "artifacts.json");
    for (const artifact of listOf(artifactState, "artifacts")) {
      const at = text(artifact.updatedAt);
      if (at === null) continue;
      const status = artifact.state === "committed" ? "success" : artifact.state === "failed" ? "failed" : "pending";
      push({ kind: "artifact", expectedId: `artifact:${String(artifact.id)}`, at, status, source: `artifact:${String(artifact.id)}`, durableRef: { kind: "artifact", longAgentId: agent, artifactId: artifact.id } });
    }
  }
  for (const project of await safeDirectories(path.join(root, "projects"))) {
    for (const conversation of await safeDirectories(path.join(root, "projects", project, "conversations"))) {
      const discussionState = await readJsonWithin(root, "projects", project, "conversations", conversation, "discussions.json");
      for (const discussion of listOf(discussionState, "discussions")) {
        const at = text(discussion.updatedAt);
        if (at === null) continue;
        const status = discussion.status === "completed" ? "success" : ["failed", "interrupted", "stopped"].includes(discussion.status) ? "failed" : "pending";
        push({ kind: "discussion", expectedId: `discussion:${conversation}:${String(discussion.discussionId)}`, at, status, source: `discussion:${conversation}:${String(discussion.discussionId)}`, durableRef: { kind: "discussion", storageProjectId: project, conversationId: conversation, discussionId: discussion.discussionId } });
      }
      const deliveryState = await readJsonWithin(root, "projects", project, "conversations", conversation, "deliveries.json");
      for (const delivery of listOf(deliveryState, "deliveries")) {
        const at = text(delivery.updatedAt);
        if (at === null) continue;
        const status = delivery.status === "delivered" ? "success" : delivery.status === "failed" ? "failed" : "pending";
        push({ kind: "delivery", expectedId: `delivery:${conversation}:${String(delivery.deliveryId)}`, at, status, source: `delivery:${conversation}:${String(delivery.deliveryId)}`, durableRef: { kind: "delivery", storageProjectId: project, conversationId: conversation, deliveryId: delivery.deliveryId } });
      }
    }
  }
  return occurrences.sort((left, right) => (left.at < right.at ? -1 : left.at > right.at ? 1 : 0));
}

async function safeDirectories(dir) {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/**
 * A task occurrence's `state` only records dispatch (`accepted`/`started`/`skipped`/`blocked`); `started`
 * means the work was handed off, NOT that it succeeded. The durable execution truth is the accepted turn
 * for the occurrence's `workId` in `runtime/long-agent-state.json`. Both `resolveDurableFacts` and
 * `collectDurableOccurrences` call this so they can never disagree.
 */
async function resolveTaskOccurrenceFact(root, occurrence) {
  const taskKey = `task:${String(occurrence.taskId)}:${String(occurrence.id)}`;
  const workId = text(occurrence.workId);
  if (workId !== null && /^work-[a-f0-9]{32}$/.test(workId)) {
    const state = await readJsonWithin(root, "runtime", "long-agent-state.json");
    const turns = listOf(state, "turns").filter((turn) => turn.workId === workId);
    const source = `${taskKey}:work:${workId}`;
    // Bind the ORIGINAL execution turn (earliest accepted), never the latest: a later chat turn in the
    // same work must not replace the dispatched task's result. `sequence` is the durable accept order;
    // `acceptedAt` is the fallback for records written before it.
    const original = [...turns].sort((left, right) => {
      const leftSequence = Number(left.sequence);
      const rightSequence = Number(right.sequence);
      if (Number.isFinite(leftSequence) && Number.isFinite(rightSequence) && leftSequence !== rightSequence) return leftSequence - rightSequence;
      return (text(left.acceptedAt) ?? "") < (text(right.acceptedAt) ?? "") ? -1 : (text(left.acceptedAt) ?? "") > (text(right.acceptedAt) ?? "") ? 1 : 0;
    })[0];
    if (original === undefined) return { status: "pending", at: null, source };
    if (original.status === "completed") {
      // Success requires the real completion time; a legacy turn without `settledAt` cannot be verified.
      return { status: "success", at: text(original.settledAt), source };
    }
    if (["failed", "interrupted", "cancelled"].includes(original.status)) {
      return { status: "failed", at: text(original.settledAt) ?? text(original.acceptedAt), source };
    }
    return { status: "pending", at: text(original.acceptedAt), source };
  }
  // No dispatched work: only definitive dispatch outcomes are facts; `started` is not success.
  const status = occurrence.state === "skipped" ? "skipped" : occurrence.state === "blocked" ? "failed" : "pending";
  return { status, at: text(occurrence.receivedAt) ?? text(occurrence.scheduledAt), source: taskKey };
}

function listOf(value, key) {
  const items = value !== null && typeof value === "object" ? value[key] : undefined;
  return Array.isArray(items) ? items.filter((item) => item !== null && typeof item === "object") : [];
}

function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

async function readJsonWithin(root, ...segments) {
  const file = path.resolve(root, ...segments);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Probe the real services; the collector's own process is not evidence the stack ran. */
export async function probeServices(input = {}) {
  const timeoutMs = input.timeoutMs ?? 3_000;
  const probe = async (url, path) => {
    if (typeof url !== "string" || url.trim() === "") return { up: false, info: null };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(new URL(path, url), { signal: controller.signal, redirect: "error" });
      const body = await response.json().catch(() => null);
      return { up: response.ok, info: body === null ? null : { status: response.status } };
    } catch {
      return { up: false, info: null };
    } finally {
      clearTimeout(timer);
    }
  };
  const backend = await probe(input.backendUrl, "/api/health");
  const nano = await probe(input.nanoUrl, "/v1/health");
  return { backend: backend.up, nano: nano.up, backendInfo: backend.info, nanoInfo: nano.info };
}

export function localDate(iso, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

export function localHour(iso, timeZone) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false }).format(new Date(iso)));
}

/** The four natural windows the 24h run must cover once. */
export function windowsFor(date) {
  return [
    { id: `${date}#morning`, fromHour: 5, toHour: 11 },
    { id: `${date}#noon`, fromHour: 11, toHour: 15 },
    { id: `${date}#evening`, fromHour: 17, toHour: 22 },
    { id: `${date}#night`, fromHour: 22, toHour: 24 },
  ];
}

/** `services` must be supplied by the caller's real liveness probe (Backend/Nano), not assumed here. */
export function sampleResource(now = new Date(), services = {}) {
  const usage = process.memoryUsage();
  let diskFreeMb = null;
  try {
    const stat = fs.statfsSync(os.homedir());
    diskFreeMb = Math.round((stat.bavail * stat.bsize) / (1024 * 1024));
  } catch { /* statfs is optional */ }
  return {
    at: now.toISOString(), pid: process.pid,
    rssMb: Math.round(usage.rss / (1024 * 1024)),
    uptimeSec: Math.round(process.uptime()),
    loadAvg: os.loadavg().map((value) => Math.round(value * 100) / 100),
    diskFreeMb,
    services: { backend: services.backend === true, nano: services.nano === true },
  };
}

export const DEFAULT_MAX_SAMPLE_GAP_MS = 15 * 60 * 1000;

export function initLedger(chatHome, options = {}) {
  const startedAt = options.startedAt ?? new Date().toISOString();
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const startDate = localDate(startedAt, timeZone);
  const ledger = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    chatHome,
    startedAt,
    timeZone,
    candidate: candidateFingerprint(),
    expected: options.expected ?? windowsFor(startDate).map((window) => window.id),
    scenario: options.scenario ?? null,
    requiredMs: 24 * 60 * 60 * 1000,
    maxSampleGapMs: options.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS,
    samples: [],
    records: [],
  };
  writeLedger(chatHome, ledger);
  return ledger;
}

export function appendSample(chatHome, now = new Date(), services = {}) {
  // Callers must pass real probes (see probeServices); an empty object is recorded as "not observed".
  const ledger = readLedger(chatHome);
  if (ledger === null) throw new Error("账本尚未初始化");
  ledger.samples.push(sampleResource(now, services));
  writeLedger(chatHome, ledger);
  return ledger;
}

export function appendRecord(chatHome, record, now = new Date()) {
  const ledger = readLedger(chatHome);
  if (ledger === null) throw new Error("账本尚未初始化");
  if (typeof record?.kind !== "string" || record.kind.trim() === "") throw new Error("记录需要 kind");
  ledger.records.push({ at: now.toISOString(), ...record });
  writeLedger(chatHome, ledger);
  return ledger;
}

/**
 * Evaluate a ledger at `now`. A run counts as a 24h pass only when real elapsed time >= 24h, the
 * window covers a local date boundary, and every expected occurrence has an explained terminal state.
 */
export function evaluateLedger(ledger, now = new Date(), options = {}) {
  const nowIso = now.toISOString();
  const nowMs = Date.parse(nowIso);
  const startMs = Date.parse(ledger.startedAt);
  const elapsedMs = nowMs - startMs;
  const elapsedHours = Math.round((elapsedMs / 3_600_000) * 100) / 100;
  const inRun = (iso) => { const at = Date.parse(iso); return at >= startMs && at <= nowMs; };
  // Only samples inside the actual run interval count; a sample before the run start cannot prove anything.
  const runSamples = ledger.samples.filter((sample) => inRun(sample.at)).sort((left, right) => left.at.localeCompare(right.at));

  // The windows the run actually spans: one natural window set per local date the run touches, and a
  // window is required only if the run interval covers any part of it.
  const dates = [...new Set([ledger.startedAt, ...runSamples.map((sample) => sample.at), nowIso].map((iso) => localDate(iso, ledger.timeZone)))];
  const requiredWindows = [];
  for (const date of dates) {
    for (const window of windowsFor(date)) {
      const fromMs = Date.parse(`${date}T${String(window.fromHour).padStart(2, "0")}:00:00Z`) - (Date.parse(ledger.startedAt) - startMs > 0 ? 0 : 0);
      void fromMs;
      const windowStart = zonedHourUtc(date, window.fromHour, ledger.timeZone);
      const windowEnd = zonedHourUtc(date, window.toHour === 24 ? 23 : window.toHour, ledger.timeZone);
      const coversStart = Math.max(startMs, windowStart);
      const coversEnd = Math.min(nowMs, windowEnd);
      if (coversEnd > coversStart) requiredWindows.push({ id: window.id, date, fromHour: window.fromHour, toHour: window.toHour, windowStart, windowEnd });
    }
  }
  const startDate = localDate(ledger.startedAt, ledger.timeZone);
  const endDate = localDate(nowIso, ledger.timeZone);
  const crossedDateBoundary = startDate !== endDate;

  const coveredWindows = [];
  const missingWindows = [];
  for (const window of requiredWindows) {
    const covered = runSamples.some((sample) => {
      const at = Date.parse(sample.at);
      if (at < window.windowStart || at > window.windowEnd) return false;
      const hour = localHour(sample.at, ledger.timeZone);
      return hour >= window.fromHour && hour < window.toHour;
    });
    if (covered) coveredWindows.push(window.id); else missingWindows.push(window.id);
  }

  // Sampling continuity: gaps inside the run and the tail gap to `now` both mean the run was not observed.
  const gaps = [];
  for (let index = 1; index < runSamples.length; index += 1) {
    const gapMs = Date.parse(runSamples[index].at) - Date.parse(runSamples[index - 1].at);
    if (gapMs > ledger.maxSampleGapMs) gaps.push({ from: runSamples[index - 1].at, to: runSamples[index].at, gapMinutes: Math.round(gapMs / 60_000) });
  }
  const headGapMs = runSamples.length === 0 ? elapsedMs : Date.parse(runSamples[0].at) - startMs;
  if (headGapMs > ledger.maxSampleGapMs) gaps.unshift({ from: ledger.startedAt, to: runSamples[0]?.at ?? nowIso, gapMinutes: Math.round(headGapMs / 60_000) });
  const tailGapMs = runSamples.length === 0 ? elapsedMs : nowMs - Date.parse(runSamples[runSamples.length - 1].at);
  if (tailGapMs > ledger.maxSampleGapMs) gaps.push({ from: runSamples[runSamples.length - 1]?.at ?? ledger.startedAt, to: nowIso, gapMinutes: Math.round(tailGapMs / 60_000) });

  // Service liveness: every in-run sample must have seen both services up, and the latest sample too.
  const backendSamples = runSamples.filter((sample) => sample.services?.backend === true).length;
  const nanoSamples = runSamples.filter((sample) => sample.services?.nano === true).length;
  const servicesMissing = runSamples.length === 0 || backendSamples !== runSamples.length || nanoSamples !== runSamples.length;

  const expected = Array.isArray(ledger.expected) ? ledger.expected : [];
  const explained = new Map();
  const unknownExpectedIds = [];
  const outOfRunRecords = [];
  for (const record of ledger.records) {
    const at = Date.parse(record.at);
    if (!Number.isFinite(at) || at < startMs || at > nowMs) { outOfRunRecords.push(record.at ?? null); continue; }
    if (typeof record.expectedId !== "string") continue;
    if (!expected.includes(record.expectedId)) { unknownExpectedIds.push(record.expectedId); continue; }
    // A later record for the same occurrence is the current terminal state.
    explained.set(record.expectedId, record.outcome ?? "unknown");
  }
  const unexplained = expected
    .filter((id) => !["success", "approved-skip"].includes(explained.get(id)))
    .map((id) => ({ id, outcome: explained.get(id) ?? "未发生" }));

  const reasons = [];
  const verified = options.verifiedFacts ?? null;
  const unverified = [];
  if (options.requireVerified === true) {
    if (verified === null) {
      reasons.push("缺少耐久业务事实核验（不能用人工声明的记录作为真实验收）");
    } else {
      const nowIso = new Date(nowMs).toISOString();
      for (const id of expected) {
        const fact = verified[id];
        const recorded = explained.get(id);
        const expectedDurable = recorded === "approved-skip" ? "skipped" : recorded;
        const usable = fact !== null && typeof fact === "object"
          && (expectedDurable === "success" || expectedDurable === "skipped")
          && fact.status === expectedDurable
          && typeof fact.at === "string" && fact.at >= ledger.startedAt && fact.at <= nowIso
          && typeof fact.source === "string" && fact.source.length > 0;
        if (!usable) unverified.push({ id, recorded: recorded ?? null, durable: typeof fact?.status === "string" ? fact.status : null, source: typeof fact?.source === "string" ? fact.source : null });
      }
      if (unverified.length > 0) reasons.push("存在无耐久对象来源或与记录不一致的发生");
    }
  }
  if (expected.length === 0) reasons.push("预期发生清单为空，不能作为 24h 验收");
  if (ledger.records.length === 0) reasons.push("业务发生账本为空，不能作为 24h 验收");
  if (elapsedMs < ledger.requiredMs) reasons.push("真实经过时间不足 24h");
  if (!crossedDateBoundary) reasons.push("未跨当地日期边界");
  if (missingWindows.length > 0) reasons.push(`缺少自然窗口采样：${missingWindows.join(", ")}`);
  if (gaps.length > 0) reasons.push(`采样存在空洞：${String(gaps.length)} 处`);
  if (servicesMissing) reasons.push("并非每个采样都观测到 Backend 与 Nano 存活");
  if (unexplained.length > 0) reasons.push("存在未解释的业务发生");
  if (unknownExpectedIds.length > 0) reasons.push("账本记录了不在预期清单中的发生");
  if (outOfRunRecords.length > 0) reasons.push("存在运行区间外（含未来）的业务记录");
  if (options.currentCandidate !== undefined && !sameCandidate(options.currentCandidate, ledger.candidate)) reasons.push("运行候选版本已变化");
  return {
    candidate: ledger.candidate,
    startedAt: ledger.startedAt,
    evaluatedAt: nowIso,
    elapsedHours,
    requiredHours: 24,
    elapsedReal24h: elapsedMs >= ledger.requiredMs,
    crossedDateBoundary,
    requiredWindows: requiredWindows.map((window) => window.id),
    coveredWindows,
    missingWindows,
    gaps,
    servicesMissing,
    serviceSamples: { backend: backendSamples, nano: nanoSamples },
    outOfRunRecords,
    unexplained,
    unknownExpectedIds,
    unverified,
    sampleCount: ledger.samples.length,
    runSampleCount: runSamples.length,
    recordCount: ledger.records.length,
    reasons,
    passed: reasons.length === 0,
  };
}

/** A fingerprint is only usable when every required field is present; a legacy ledger is rejected. */
export function candidateComplete(fingerprint) {
  if (typeof fingerprint?.parentHead !== "string" || fingerprint.parentHead === "unknown") return false;
  if (typeof fingerprint?.parentDirtyHash !== "string" || !fingerprint.parentDirtyHash.startsWith("sha256:")) return false;
  for (const name of ["frontend", "pi", "nanoclaw"]) {
    const sub = fingerprint?.submodules?.[name];
    if (typeof sub?.head !== "string" || sub.head === "unknown") return false;
    if (typeof sub?.dirty !== "number") return false;
    if (typeof sub?.dirtyHash !== "string" || !sub.dirtyHash.startsWith("sha256:")) return false;
  }
  return true;
}

/** Two candidate fingerprints match only when the parent, every Submodule identity and content match. */
function sameCandidate(current, recorded) {
  if (!candidateComplete(current) || !candidateComplete(recorded)) return false;
  if (current.parentHead !== recorded.parentHead) return false;
  if (current.parentDirtyHash !== recorded.parentDirtyHash) return false;
  for (const name of ["frontend", "pi", "nanoclaw"]) {
    const left = current.submodules[name];
    const right = recorded.submodules[name];
    if (left.head !== right.head) return false;
    if (left.dirty !== right.dirty) return false;
    if (left.dirtyHash !== right.dirtyHash) return false;
  }
  return true;
}

/** Convert a local wall-clock hour on a date in a time zone to the matching UTC instant. */
function zonedHourUtc(date, hour, timeZone) {
  if (hour >= 24) return Date.parse(`${date}T23:59:59.999Z`);
  // Pick an instant whose local hour matches by scanning around the UTC guess (DST-safe enough for windows).
  let guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00.000Z`);
  for (let offset = -14; offset <= 14; offset += 1) {
    const candidate = guess + offset * 3_600_000;
    if (localDate(new Date(candidate).toISOString(), timeZone) === date && localHour(new Date(candidate).toISOString(), timeZone) === hour) {
      return candidate;
    }
  }
  return guess;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    values[key] = next === undefined || next.startsWith("--") ? true : next;
    if (values[key] !== true) index += 1;
  }
  return values;
}

async function main(argv) {
  const [command] = argv;
  const args = parseArgs(argv.slice(1));
  const chatHome = path.resolve(String(args.home ?? process.env.CHAT_HOME ?? path.join(os.homedir(), ".chat")));
  if (command === "init") {
    const expected = typeof args.expected === "string" ? JSON.parse(fs.readFileSync(args.expected, "utf8")) : undefined;
    console.log(JSON.stringify(initLedger(chatHome, { ...(typeof args.start === "string" ? { startedAt: args.start } : {}), ...(expected === undefined ? {} : { expected }) }), null, 2));
    return;
  }
  if (command === "occurrences") {
    const list = await collectDurableOccurrences(chatHome, {
      ...(typeof args.from === "string" ? { from: args.from } : {}),
      ...(typeof args.to === "string" ? { to: args.to } : {}),
    });
    console.log(JSON.stringify({ schemaVersion: 1, occurrences: list }, null, 2));
    return;
  }
  if (command === "sample") {
    const services = typeof args.services === "string"
      ? JSON.parse(args.services)
      : await probeServices({
          backendUrl: typeof args["backend-url"] === "string" ? args["backend-url"] : (process.env.CHAT_PUBLIC_URL ?? process.env.CHAT_BACKEND_URL ?? null),
          nanoUrl: typeof args["nano-url"] === "string" ? args["nano-url"] : (process.env.CHAT_NANOCLAW_URL ?? null),
        });
    appendSample(chatHome, new Date(), services);
    console.log(JSON.stringify(evaluateLedger(readLedger(chatHome)), null, 2));
    return;
  }
  if (command === "record") {
    if (typeof args.json !== "string") throw new Error("record 需要 --json");
    appendRecord(chatHome, JSON.parse(args.json));
    console.log(JSON.stringify(evaluateLedger(readLedger(chatHome)), null, 2));
    return;
  }
  if (command === "status") {
    const ledger = readLedger(chatHome);
    if (ledger === null) throw new Error("账本尚未初始化");
    // The real acceptance entry always uses the real clock; a caller-supplied time would fake elapsed time.
    // `--facts` may supply durable references (expectedId -> {kind,id}); it can never supply a status.
    const refs = typeof args.facts === "string" ? JSON.parse(fs.readFileSync(args.facts, "utf8")) : {};
    const records = ledger.records.map((record) => (
      record !== null && typeof record === "object" && record.durableRef === undefined && refs[record.expectedId] !== undefined
        ? { ...record, durableRef: refs[record.expectedId] }
        : record
    ));
    const verifiedFacts = await resolveDurableFacts(chatHome, records);
    console.log(JSON.stringify(evaluateLedger(ledger, new Date(), {
      currentCandidate: candidateFingerprint(), requireVerified: true, verifiedFacts,
    }), null, 2));
    return;
  }
  throw new Error("用法：init | sample | record --json | status");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
