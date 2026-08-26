import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, posix, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  contentLabContextBundleSchema,
  contentLabContextSelectionSchema,
  contentLabObservationSchema,
  contentLabRelativePathSchema,
  type ContentLabArtifact,
  type ContentLabContextBundle,
  type ContentLabContextSelection,
  type ContentLabFileRef,
  type ContentLabJob,
  type ContentLabObservation,
} from "@chat/contracts";
import { hashCanonical } from "@chat/domain";
import { ProjectResourceError } from "./errors.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_RELEVANT_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SINGLE_TEXT_BYTES = 512 * 1024;
const MAX_ARTIFACT_HASH_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_HASH_BYTES = 128 * 1024 * 1024;
const MAX_CONTEXT_CHARACTERS = 160_000;
const PRIVATE_FILE = /(^|\/)(\.env($|\.)|.*(?:secret|credential|token|private[-_.]?key).*)/iu;
const MEDIA_EXTENSION =
  /\.(?:mp4|mov|mkv|webm|png|jpe?g|webp|gif|mp3|wav|m4a|aac|srt|ass|vtt|json)$/iu;
const JOB_FILE =
  /^(xiaohongshu|bilibili)\/(?:series\/([^/]+)\/)?jobs\/([^/]+)\/(source\.md|publish\.md|analysis\/(?:qc|[^/]*workflow[^/]*)\.md)$/iu;

interface ReadText {
  readonly ref: ContentLabFileRef;
  readonly content: string;
}

interface ContextCompileInput {
  readonly observationSha256: string;
  readonly observation: ContentLabObservation;
  readonly selection: ContentLabContextSelection;
}

/**
 * Content Lab观察只以Git tracked path发现结构；媒体仅对publish/QC明确推荐的路径做定点stat。
 * 它不会递归遍历21GB工件目录，也不会把媒体内容放进Observation或Prompt。
 */
export async function observeContentLabResource(root: string): Promise<ContentLabObservation> {
  const trackedPaths = await listTrackedPaths(root);
  const relevantPaths = trackedPaths
    .filter(isRelevantTextPath)
    .filter((path) => !PRIVATE_FILE.test(path));
  const textTruncated = relevantPaths.length > 1_000;
  const selectedRelevantPaths = relevantPaths.slice(0, 1_000);
  const textCache = new Map<string, ReadText>();
  let textBytes = 0;
  for (const path of selectedRelevantPaths) {
    const read = await readTrackedText(root, path);
    textBytes += read.ref.sizeBytes;
    if (textBytes > MAX_RELEVANT_TEXT_BYTES) {
      throw new ProjectResourceError(
        "content_lab_text_budget_exceeded",
        "Content Lab受管文本超过观察预算，必须先收敛Manifest范围",
      );
    }
    textCache.set(path, read);
  }

  const catalog = {
    governance: refsMatching(textCache, (path) => /(^|\/)AGENTS\.md$/u.test(path)).slice(0, 30),
    workflows: refsMatching(
      textCache,
      (path) => path.startsWith("workflows/") && path.endsWith(".md"),
    ).slice(0, 100),
    templates: refsMatching(textCache, (path) => /(^|\/)templates\/.*\.md$/u.test(path)).slice(
      0,
      100,
    ),
    seriesRegistries: refsMatching(textCache, (path) =>
      /(^|\/)series_registry\.md$/u.test(path),
    ).slice(0, 100),
    cases: refsMatching(
      textCache,
      (path) => path.startsWith("cases/") && path.endsWith(".md"),
    ).slice(0, 500),
  };
  if (!catalog.governance.some((item) => item.relativePath === "AGENTS.md")) {
    throw new ProjectResourceError(
      "content_lab_governance_missing",
      "Content Lab Root缺少tracked AGENTS.md治理入口",
    );
  }

  const jobRoots = new Map<
    string,
    { platform: "xiaohongshu" | "bilibili"; seriesKey?: string; date: string }
  >();
  for (const path of selectedRelevantPaths) {
    const match = JOB_FILE.exec(path);
    if (match === null) continue;
    const jobName = match[3] ?? "";
    const date = jobName.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) continue;
    const jobKey = path.slice(0, path.lastIndexOf("/" + (match[4] ?? "")));
    jobRoots.set(jobKey, {
      platform: match[1] as "xiaohongshu" | "bilibili",
      ...(match[2] === undefined ? {} : { seriesKey: match[2] }),
      date,
    });
  }

  const jobs: ContentLabJob[] = [];
  const artifactHashBudget = { hashedBytes: 0 };
  for (const [jobKey, identity] of [...jobRoots.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 500)) {
    const source = textCache.get(`${jobKey}/source.md`);
    const publish = textCache.get(`${jobKey}/publish.md`);
    const qc = textCache.get(`${jobKey}/analysis/qc.md`);
    const workflowAnalysis = [...textCache.entries()]
      .filter(([path]) => path.startsWith(`${jobKey}/analysis/`) && /workflow.*\.md$/iu.test(path))
      .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
    const searchableText = [
      source?.content,
      publish?.content,
      qc?.content,
      workflowAnalysis?.content,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n");
    const blockerSignals = extractBlockerSignals(searchableText);
    const recommendedArtifacts = await observeRecommendedArtifacts(
      root,
      jobKey,
      [publish, qc],
      artifactHashBudget,
    );
    const workflowRevisionRefs = extractWorkflowRefs(
      searchableText,
      workflowAnalysis?.ref.relativePath,
    );
    const jobWithoutFingerprint = {
      jobKey,
      platform: identity.platform,
      date: identity.date,
      ...(identity.seriesKey === undefined ? {} : { seriesKey: identity.seriesKey }),
      ...(source === undefined ? {} : { source: source.ref }),
      ...(publish === undefined ? {} : { publish: publish.ref }),
      ...(qc === undefined ? {} : { qc: qc.ref }),
      ...(workflowAnalysis === undefined ? {} : { workflowAnalysis: workflowAnalysis.ref }),
      sourceUrls: extractHttpUrls(source?.content ?? ""),
      workflowRevisionRefs,
      readiness: inferReadiness({
        ...(publish === undefined ? {} : { publish }),
        ...(qc === undefined ? {} : { qc }),
        blockerSignals,
      }),
      blockerSignals,
      recommendedArtifacts,
    } as const;
    jobs.push({
      ...jobWithoutFingerprint,
      fingerprintSha256: hashCanonical("content-lab-job.v1", jobWithoutFingerprint) as never,
    });
  }

  const selectedArtifactCount = jobs.reduce(
    (count, job) => count + job.recommendedArtifacts.length,
    0,
  );
  const selectedArtifactPaths = new Set(
    jobs.flatMap((job) => job.recommendedArtifacts.map((artifact) => artifact.relativePath)),
  );
  const ignoredTrackedMediaCount = trackedPaths.filter(
    (path) => MEDIA_EXTENSION.test(path) && !selectedArtifactPaths.has(path),
  ).length;
  return contentLabObservationSchema.parse({
    schemaVersion: "content-lab-observation.v1",
    catalog,
    jobs,
    scanStats: {
      trackedFileCount: trackedPaths.length,
      relevantTextFileCount: textCache.size,
      candidateJobCount: jobRoots.size,
      selectedArtifactCount,
      ignoredTrackedMediaCount,
      hashedArtifactBytes: artifactHashBudget.hashedBytes,
      artifactInspectionPolicy: "recommended_paths_only",
      truncated: textTruncated || jobRoots.size > 500,
    },
  });
}

/** 从已提交Observation挑选最小文本；读取前重新核对size/hash，目录漂移时失败关闭。 */
export async function compileContentLabResourceContext(
  root: string,
  rawInput: ContextCompileInput,
): Promise<ContentLabContextBundle> {
  const selection = contentLabContextSelectionSchema.parse(rawInput.selection);
  const observation = contentLabObservationSchema.parse(rawInput.observation);
  const requestedRefs = [
    ...selection.resourceRefs,
    ...(selection.sourceRef === undefined ? [] : [selection.sourceRef]),
  ];
  const selectedJobs = selectJobs(observation.jobs, selection, requestedRefs);
  const selectedPaths: Array<{
    role: "governance" | "workflow" | "template" | "series_rule" | "current_job" | "case";
    ref: ContentLabFileRef;
    reason: string;
  }> = [];
  const add = (
    role: (typeof selectedPaths)[number]["role"],
    refs: readonly ContentLabFileRef[],
    reason: string,
    limit: number,
  ) => {
    for (const ref of refs.slice(0, limit)) selectedPaths.push({ role, ref, reason });
  };

  add(
    "governance",
    observation.catalog.governance.filter((ref) => ref.relativePath === "AGENTS.md"),
    "Content Lab根治理规则",
    1,
  );
  add(
    "workflow",
    observation.catalog.workflows.filter((ref) => !ref.relativePath.endsWith("/README.md")),
    "内容生产固定工作流",
    2,
  );
  const platformTokens = new Set(selection.targetPlatforms);
  add(
    "template",
    observation.catalog.templates.filter((ref) =>
      [...platformTokens].some((platform) => ref.relativePath.toLowerCase().includes(platform)),
    ),
    "当前目标平台模板",
    1,
  );

  const seriesKeys = new Set(
    [selection.seriesKey, ...selectedJobs.map((job) => job.seriesKey)].filter(
      (value): value is string => value !== undefined,
    ),
  );
  add(
    "series_rule",
    observation.catalog.governance.filter(
      (ref) =>
        ref.relativePath !== "AGENTS.md" &&
        [...seriesKeys].some((key) => ref.relativePath.includes(`/series/${key}/`)),
    ),
    "当前系列治理规则",
    2,
  );
  add(
    "series_rule",
    observation.catalog.seriesRegistries.filter((ref) =>
      [...seriesKeys].some((key) => ref.relativePath.includes(`/series/${key}/`)),
    ),
    "当前系列登记",
    1,
  );

  for (const job of selectedJobs) {
    add(
      "current_job",
      [job.source, job.publish, job.qc, job.workflowAnalysis].filter(
        (value): value is ContentLabFileRef => value !== undefined,
      ),
      `当前工作:${job.jobKey}`,
      4,
    );
  }
  const relatedCases = scoreRelatedCases(observation.catalog.cases, selection, selectedJobs);
  add("case", relatedCases, "同平台、同系列或同类阻塞案例", 3);

  const unique = new Map<string, (typeof selectedPaths)[number]>();
  for (const item of selectedPaths) unique.set(item.ref.relativePath, item);
  const items: ContentLabContextBundle["items"] = [];
  let totalCharacters = 0;
  let excludedItemCount = 0;
  let truncated = false;
  for (const item of unique.values()) {
    const content = await readVerifiedContextText(root, item.ref);
    const bounded = content.slice(0, 40_000);
    if (totalCharacters + bounded.length > MAX_CONTEXT_CHARACTERS) {
      excludedItemCount += 1;
      truncated = true;
      continue;
    }
    if (bounded.length !== content.length) truncated = true;
    totalCharacters += bounded.length;
    items.push({ ...item.ref, role: item.role, reason: item.reason, content: bounded });
  }
  const history = observation.jobs
    .filter(
      (job) =>
        (selection.targetPlatforms.length === 0 ||
          selection.targetPlatforms.includes(job.platform)) &&
        (selection.seriesKey === undefined || job.seriesKey === selection.seriesKey),
    )
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || right.jobKey.localeCompare(left.jobKey),
    )
    .slice(0, 20)
    .map((job) => ({
      jobKey: job.jobKey,
      platform: job.platform,
      date: job.date,
      ...(job.seriesKey === undefined ? {} : { seriesKey: job.seriesKey }),
      readiness: job.readiness,
      sourceUrls: job.sourceUrls,
      workflowRevisionRefs: job.workflowRevisionRefs,
    }));
  return contentLabContextBundleSchema.parse({
    schemaVersion: "content-lab-context-bundle.v1",
    observationSha256: rawInput.observationSha256,
    selectedJobKeys: selectedJobs.map((job) => job.jobKey),
    items,
    history,
    totalCharacters,
    excludedItemCount,
    truncated,
  });
}

async function listTrackedPaths(root: string): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["-C", root, "ls-files", "-z", "--", "."], {
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
    }));
  } catch {
    throw new ProjectResourceError("content_lab_git_index_failed", "无法读取Content Lab Git索引");
  }
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((path) => parseRelativePath(path))
    .sort();
}

function isRelevantTextPath(path: string): boolean {
  return (
    /(^|\/)AGENTS\.md$/u.test(path) ||
    path.startsWith("workflows/") ||
    /(^|\/)templates\/.*\.md$/u.test(path) ||
    /(^|\/)series_registry\.md$/u.test(path) ||
    path.startsWith("cases/") ||
    JOB_FILE.test(path)
  );
}

async function readTrackedText(root: string, path: string): Promise<ReadText> {
  const absolute = await resolveSafeRegularFile(root, path);
  const metadata = await lstat(absolute);
  if (metadata.size > MAX_SINGLE_TEXT_BYTES) {
    throw new ProjectResourceError("content_lab_text_too_large", `${path}超过单文件观察预算`);
  }
  const bytes = await readFile(absolute);
  return {
    ref: {
      relativePath: path,
      sha256: createHash("sha256").update(bytes).digest("hex") as never,
      sizeBytes: metadata.size,
    },
    content: bytes.toString("utf8"),
  };
}

function refsMatching(
  cache: ReadonlyMap<string, ReadText>,
  predicate: (path: string) => boolean,
): ContentLabFileRef[] {
  return [...cache.entries()]
    .filter(([path]) => predicate(path))
    .map(([, value]) => value.ref)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function extractHttpUrls(content: string): string[] {
  const urls = new Set<string>();
  for (const match of content.matchAll(/https?:\/\/[^\s<>()\]`"']+/giu)) {
    const candidate = (match[0] ?? "").replace(/[.,;:!?，。；：！？]+$/u, "");
    try {
      const url = new URL(candidate);
      const hasSensitiveIdentity = url.username !== "" || url.password !== "";
      const hasSensitiveParameter = [...url.searchParams.keys()].some((key) =>
        /(?:token|secret|password|signature|credential|api[-_]?key|authorization)/iu.test(key),
      );
      if (
        !hasSensitiveIdentity &&
        !hasSensitiveParameter &&
        (url.protocol === "http:" || url.protocol === "https:")
      ) {
        urls.add(url.toString());
      }
    } catch {
      // 源文档中的残缺URL不是可信索引，不进入Observation。
    }
  }
  return [...urls].sort().slice(0, 10);
}

function extractWorkflowRefs(content: string, analysisPath?: string): string[] {
  const refs = new Set<string>();
  if (analysisPath !== undefined) refs.add(analysisPath);
  for (const match of content.matchAll(/`([^`]*(?:workflow|工作流)[^`]*\.md)`/giu)) {
    const candidate = match[1]?.trim();
    if (candidate === undefined) continue;
    const parsed = safeRelativePath(candidate);
    if (parsed !== undefined) refs.add(parsed);
  }
  return [...refs].sort().slice(0, 20);
}

function extractBlockerSignals(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line.length <= 240 &&
        /(?:环境阻塞|待环境恢复|无法继续|阻塞状态|BLOCKED|codesign blocker)/iu.test(line),
    )
    .slice(0, 12);
}

function inferReadiness(input: {
  readonly publish?: ReadText;
  readonly qc?: ReadText;
  readonly blockerSignals: readonly string[];
}): ContentLabJob["readiness"] {
  if (input.blockerSignals.length > 0) return "blocked";
  if (input.publish === undefined) return "draft";
  const combined = `${input.publish.content}\n${input.qc?.content ?? ""}`;
  if (input.qc !== undefined && /(?:\bPASS\b|质检通过|技术完成|全部通过)/iu.test(combined)) {
    return "review_ready";
  }
  if (/(?:待审核|等待.*审核|需要.*审核|needs review|waiting.*review)/iu.test(combined)) {
    return "needs_review";
  }
  return "draft";
}

async function observeRecommendedArtifacts(
  root: string,
  jobKey: string,
  texts: readonly (ReadText | undefined)[],
  hashBudget: { hashedBytes: number },
): Promise<ContentLabArtifact[]> {
  const candidates = new Map<string, Set<string>>();
  for (const text of texts) {
    if (text === undefined) continue;
    for (const line of text.content.split(/\r?\n/u)) {
      if (!/(?:推荐|上传|成片|封面|交付|视频|字幕|音频|文件)/u.test(line)) continue;
      for (const match of line.matchAll(/`([^`]+)`|\[[^\]]*\]\(([^)]+)\)/gu)) {
        const raw = (match[1] ?? match[2] ?? "").trim();
        if (!MEDIA_EXTENSION.test(raw)) continue;
        const path = resolveArtifactPath(jobKey, raw);
        if (PRIVATE_FILE.test(path)) continue;
        const recommendedBy = candidates.get(path) ?? new Set<string>();
        recommendedBy.add(text.ref.relativePath);
        candidates.set(path, recommendedBy);
      }
    }
  }
  const metadata = extractMediaMetadata(texts.map((item) => item?.content ?? "").join("\n"));
  const artifacts: ContentLabArtifact[] = [];
  for (const [path, recommendedBy] of [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 12)) {
    const artifact = await inspectArtifact(
      root,
      path,
      [...recommendedBy].sort(),
      metadata,
      hashBudget,
    );
    artifacts.push(artifact);
  }
  return artifacts;
}

function resolveArtifactPath(jobKey: string, raw: string): string {
  const normalizedRaw = raw.replace(/^\.\//u, "");
  if (normalizedRaw.startsWith("/") || normalizedRaw.includes("\\")) {
    throw new ProjectResourceError("project_path_escape", "推荐工件路径越过Content Lab Root");
  }
  const candidate = /^(?:xiaohongshu|bilibili)\//u.test(normalizedRaw)
    ? posix.normalize(normalizedRaw)
    : posix.normalize(posix.join(jobKey, normalizedRaw));
  if (candidate === ".." || candidate.startsWith("../") || candidate.split("/").includes("..")) {
    throw new ProjectResourceError("project_path_escape", "推荐工件路径越过Content Lab Root");
  }
  return parseRelativePath(candidate);
}

async function inspectArtifact(
  root: string,
  path: string,
  recommendedBy: string[],
  metadata: NonNullable<ContentLabArtifact["metadata"]>,
  hashBudget: { hashedBytes: number },
): Promise<ContentLabArtifact> {
  const mediaKind = mediaKindFor(path);
  let absolute: string;
  try {
    absolute = await resolveSafeRegularFile(root, path);
  } catch (error) {
    if (isMissing(error))
      return { relativePath: path, mediaKind, hashPolicy: "missing", recommendedBy };
    throw error;
  }
  const file = await lstat(absolute);
  if (file.size > MAX_ARTIFACT_HASH_BYTES) {
    return {
      relativePath: path,
      mediaKind,
      hashPolicy: "deferred_large",
      sizeBytes: file.size,
      ...(mediaKind === "video" && Object.keys(metadata).length > 0 ? { metadata } : {}),
      recommendedBy,
    };
  }
  if (hashBudget.hashedBytes + file.size > MAX_TOTAL_ARTIFACT_HASH_BYTES) {
    return {
      relativePath: path,
      mediaKind,
      hashPolicy: "deferred_policy",
      sizeBytes: file.size,
      ...(mediaKind === "video" && Object.keys(metadata).length > 0 ? { metadata } : {}),
      recommendedBy,
    };
  }
  const bytes = await readFile(absolute);
  hashBudget.hashedBytes += file.size;
  return {
    relativePath: path,
    mediaKind,
    hashPolicy: "computed",
    sizeBytes: file.size,
    sha256: createHash("sha256").update(bytes).digest("hex") as never,
    ...(mediaKind === "video" && Object.keys(metadata).length > 0 ? { metadata } : {}),
    recommendedBy,
  };
}

function mediaKindFor(path: string): ContentLabArtifact["mediaKind"] {
  const extension = extname(path).toLowerCase();
  if ([".mp4", ".mov", ".mkv", ".webm"].includes(extension)) return "video";
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) return "image";
  if ([".mp3", ".wav", ".m4a", ".aac"].includes(extension)) return "audio";
  if ([".srt", ".ass", ".vtt"].includes(extension)) return "caption";
  if (extension === ".json") return "metadata";
  return "other";
}

function extractMediaMetadata(content: string): NonNullable<ContentLabArtifact["metadata"]> {
  const dimensions = /(\d{3,5})\s*[x×]\s*(\d{3,5})/iu.exec(content);
  const duration = /(?:时长|duration)[^\d]{0,30}(\d+(?:\.\d+)?)\s*(?:s|秒)/iu.exec(content);
  const frameRate = /(\d+(?:\.\d+)?)\s*(?:fps|帧\/秒)/iu.exec(content);
  const codec = /\b(h\.?264|h\.?265|hevc|av1|vp9)\b/iu.exec(content);
  return {
    ...(dimensions?.[1] === undefined ? {} : { width: Number(dimensions[1]) }),
    ...(dimensions?.[2] === undefined ? {} : { height: Number(dimensions[2]) }),
    ...(duration?.[1] === undefined ? {} : { durationSeconds: Number(duration[1]) }),
    ...(frameRate?.[1] === undefined ? {} : { frameRate: Number(frameRate[1]) }),
    ...(codec?.[1] === undefined ? {} : { codec: codec[1].toLowerCase().replace(".", "") }),
  };
}

function selectJobs(
  jobs: readonly ContentLabJob[],
  selection: ContentLabContextSelection,
  requestedRefs: readonly string[],
): ContentLabJob[] {
  const normalizedRefs = requestedRefs
    .map(normalizeResourceRef)
    .filter((value): value is string => value !== undefined);
  const jobRefs = normalizedRefs.filter(
    (ref) => !["cases", "workflows", "templates", "AGENTS.md"].includes(ref),
  );
  const exact = jobs.filter((job) =>
    jobRefs.some(
      (ref) =>
        ref === job.jobKey || ref.startsWith(`${job.jobKey}/`) || job.sourceUrls.includes(ref),
    ),
  );
  if (jobRefs.length > 0) return exact.sort(newestJobFirst).slice(0, 5);
  return jobs
    .filter(
      (job) =>
        (selection.targetPlatforms.length === 0 ||
          selection.targetPlatforms.includes(job.platform)) &&
        (selection.seriesKey === undefined || job.seriesKey === selection.seriesKey),
    )
    .sort(newestJobFirst)
    .slice(0, selection.workKind === "content_delivery" ? 1 : 3);
}

function normalizeResourceRef(value: string): string | undefined {
  const raw = value.startsWith("content-lab:") ? value.slice("content-lab:".length) : value;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      return new URL(raw).toString();
    } catch {
      return undefined;
    }
  }
  return safeRelativePath(raw);
}

function scoreRelatedCases(
  cases: readonly ContentLabFileRef[],
  selection: ContentLabContextSelection,
  jobs: readonly ContentLabJob[],
): ContentLabFileRef[] {
  const seriesKeys = new Set(
    [selection.seriesKey, ...jobs.map((job) => job.seriesKey)].filter(Boolean),
  );
  const blocked = jobs.some((job) => job.readiness === "blocked");
  const useGeneralRecentCases =
    selection.targetPlatforms.length === 0 && selection.seriesKey === undefined;
  return [...cases]
    .map((ref) => {
      const path = ref.relativePath.toLowerCase();
      let score = 0;
      if (useGeneralRecentCases) score += 1;
      if (selection.targetPlatforms.includes("xiaohongshu") && path.includes("_xhs_")) score += 3;
      if (selection.targetPlatforms.includes("bilibili") && path.includes("_bilibili_")) score += 3;
      if ([...seriesKeys].some((key) => typeof key === "string" && path.includes(key))) score += 5;
      if (blocked && /(?:blocker|environment|codesign|_env_)/u.test(path)) score += 8;
      return { ref, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.ref.relativePath.localeCompare(left.ref.relativePath),
    )
    .slice(0, 3)
    .map((item) => item.ref);
}

async function readVerifiedContextText(root: string, ref: ContentLabFileRef): Promise<string> {
  const absolute = await resolveSafeRegularFile(root, ref.relativePath);
  const metadata = await lstat(absolute);
  if (metadata.size !== ref.sizeBytes || metadata.size > MAX_SINGLE_TEXT_BYTES) {
    throw new ProjectResourceError(
      "content_lab_observation_drift",
      `${ref.relativePath}已偏离绑定Observation`,
    );
  }
  const bytes = await readFile(absolute);
  if (createHash("sha256").update(bytes).digest("hex") !== ref.sha256) {
    throw new ProjectResourceError(
      "content_lab_observation_drift",
      `${ref.relativePath}已偏离绑定Observation`,
    );
  }
  const content = bytes.toString("utf8");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(content) ||
    /(?:api[-_]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"']{8,}/iu.test(content)
  ) {
    throw new ProjectResourceError(
      "content_lab_sensitive_content",
      `${ref.relativePath}疑似包含凭据，禁止进入Agent上下文`,
    );
  }
  return content;
}

async function resolveSafeRegularFile(root: string, path: string): Promise<string> {
  const parsed = parseRelativePath(path);
  const absolute = resolve(root, parsed);
  assertInsideRoot(root, absolute);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ProjectResourceError("project_path_escape", "Content Lab资源不是Root内普通文件");
  }
  const canonical = await realpath(absolute);
  assertInsideRoot(root, canonical);
  return canonical;
}

function parseRelativePath(path: string): string {
  const parsed = contentLabRelativePathSchema.safeParse(path);
  if (!parsed.success) {
    throw new ProjectResourceError("project_path_escape", "Content Lab路径越过允许Root");
  }
  return parsed.data;
}

function safeRelativePath(path: string): string | undefined {
  const parsed = contentLabRelativePathSchema.safeParse(path);
  return parsed.success ? parsed.data : undefined;
}

function assertInsideRoot(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new ProjectResourceError("project_path_escape", "Content Lab路径越过允许Root");
  }
}

function newestJobFirst(left: ContentLabJob, right: ContentLabJob): number {
  return right.date.localeCompare(left.date) || right.jobKey.localeCompare(left.jobKey);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
