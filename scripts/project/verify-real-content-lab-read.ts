import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { computeProjectObservationSha256 } from "../../packages/domain/src/index.ts";
import { createProjectResourceRegistry } from "../../packages/project-runtime/src/index.ts";

const execFileAsync = promisify(execFile);
const root = process.env.CHAT_CONTENT_LAB_REAL_ROOT?.trim();
if (root === undefined || root === "") {
  throw new Error("必须显式设置CHAT_CONTENT_LAB_REAL_ROOT；脚本不会猜测个人绝对路径");
}

async function gitStatus(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", root!, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}

const statusBefore = await gitStatus();
const registry = await createProjectResourceRegistry({
  CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
    {
      rootId: "root_contentlab",
      displayName: "Content Lab",
      canonicalPath: root,
      enabledAdapters: ["local-git-workspace.v1", "content-lab-resource.v1"],
      gitEvidenceEnabled: false,
    },
  ]),
});
const first = await registry.observe("root_contentlab");
const second = await registry.observe("root_contentlab");
const firstHash = computeProjectObservationSha256(first.data);
const secondHash = computeProjectObservationSha256(second.data);
if (firstHash !== secondHash) throw new Error("连续只读观察Hash不稳定");
const contentLab = first.data.contentLab;
if (contentLab === undefined) throw new Error("Content Lab Adapter未返回观察结果");

const latestFor = (platform: "xiaohongshu" | "bilibili") =>
  contentLab.jobs
    .filter((job) => job.platform === platform)
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date) || right.jobKey.localeCompare(left.jobKey),
    )[0];
const contextSummaries = [];
for (const platform of ["xiaohongshu", "bilibili"] as const) {
  const job = latestFor(platform);
  if (job === undefined) continue;
  const context = await registry.compileContentLabContext!({
    rootId: "root_contentlab",
    observationSha256: firstHash,
    observation: contentLab,
    selection: {
      workKind: "content_delivery",
      targetPlatforms: [platform],
      sourceRef: job.jobKey,
      ...(job.seriesKey === undefined ? {} : { seriesKey: job.seriesKey }),
      resourceRefs: [],
    },
  });
  if (context.items.some((item) => /\.(?:mp4|mov|mkv|webm|mp3|wav)$/iu.test(item.relativePath))) {
    throw new Error("Context错误包含媒体内容");
  }
  contextSummaries.push({
    platform,
    selectedJobCount: context.selectedJobKeys.length,
    itemCount: context.items.length,
    historyCount: context.history.length,
    totalCharacters: context.totalCharacters,
    truncated: context.truncated,
  });
}
const statusAfter = await gitStatus();
if (statusAfter !== statusBefore) throw new Error("只读演练修改了Content Lab工作区");

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: contentLab.schemaVersion,
      observationSha256: firstHash,
      stableRepeat: true,
      trackedFileCount: contentLab.scanStats.trackedFileCount,
      relevantTextFileCount: contentLab.scanStats.relevantTextFileCount,
      jobCount: contentLab.jobs.length,
      caseCount: contentLab.catalog.cases.length,
      selectedArtifactCount: contentLab.scanStats.selectedArtifactCount,
      artifactPolicies: [
        ...new Set(
          contentLab.jobs.flatMap((job) => job.recommendedArtifacts.map((item) => item.hashPolicy)),
        ),
      ].sort(),
      readinessCounts: Object.fromEntries(
        ["draft", "needs_review", "review_ready", "blocked"].map((readiness) => [
          readiness,
          contentLab.jobs.filter((job) => job.readiness === readiness).length,
        ]),
      ),
      contextSummaries,
      workspaceUnchanged: true,
      planeWrites: 0,
    },
    null,
    2,
  )}\n`,
);
