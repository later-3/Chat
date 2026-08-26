import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createProjectResourceRegistry } from "./registry.js";

const exec = promisify(execFile);

async function write(root: string, path: string, content: string): Promise<void> {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, content);
}

async function contentLabRepository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "chat-content-lab-"));
  await write(root, ".gitignore", "**/export/*.mp4\n");
  await write(root, "AGENTS.md", "# Content Lab治理\n发布必须经过用户审核。\n");
  await write(root, "workflows/video_translation_workflow.md", "# 翻译工作流 v3\n");
  await write(root, "workflows/video_translation_end_to_end.md", "# 端到端工作流\n");
  await write(
    root,
    "templates/xiaohongshu_youtube_shorts_translation_dub_template.md",
    "# 小红书模板\n",
  );
  await write(root, "templates/bilibili_original_translation_dub_template.md", "# B站模板\n");
  await write(
    root,
    "cases/2026-07-20_xhs_video_environment_preflight_failure_case.md",
    "# 环境阻塞案例\n",
  );
  await write(
    root,
    "cases/2026-08-02_xhs_normal_workflow_retrospective_case.md",
    "# 工作流复盘\n经验：先QC。\n",
  );
  await write(root, "cases/token-secret.md", "SHOULD_NOT_BE_READ\n");

  const normal = "xiaohongshu/jobs/2026-08-02_normal_publish";
  await write(root, `${normal}/source.md`, "# 来源\nhttps://youtube.com/watch?v=normal\n");
  await write(root, `${normal}/publish.md`, "# 发布包\n推荐上传 `export/final_upload_xhs.mp4`\n");
  await write(
    root,
    `${normal}/analysis/qc.md`,
    "# QC\nPASS\n1080x1920，30fps，时长 12.5 秒，H.264\n",
  );
  await write(
    root,
    `${normal}/analysis/workflow.md`,
    "采用 `workflows/video_translation_workflow.md`\n",
  );
  await write(root, `${normal}/export/final_upload_xhs.mp4`, "small-video-fixture");

  const draft = "xiaohongshu/jobs/2026-08-03_publish_draft";
  await write(root, `${draft}/source.md`, "# 来源\nhttps://youtube.com/watch?v=draft\n");
  await write(root, `${draft}/publish.md`, "# 草稿\n推荐上传 `export/not-rendered.mp4`\n");

  const seriesRoot = "xiaohongshu/series/monstrofarm";
  await write(root, `${seriesRoot}/AGENTS.md`, "# Monstrofarm系列规则\n");
  await write(root, `${seriesRoot}/series_registry.md`, "# 系列登记\n");
  const seriesJob = `${seriesRoot}/jobs/2026-08-04_series_publish`;
  await write(root, `${seriesJob}/source.md`, "# 来源\nhttps://youtube.com/watch?v=series\n");
  await write(root, `${seriesJob}/publish.md`, "# 发布包\n等待用户审核。\n");

  const long = "bilibili/series/crash_course_botany/jobs/2026-08-05_long_video";
  await write(root, "bilibili/series/crash_course_botany/AGENTS.md", "# B站系列规则\n");
  await write(root, "bilibili/series/crash_course_botany/series_registry.md", "# B站系列登记\n");
  await write(root, `${long}/source.md`, "# 来源\nhttps://youtube.com/watch?v=long\n");
  await write(
    root,
    `${long}/publish.md`,
    "# 发布包\n推荐上传 `export/final_bilibili.mp4`，等待 Later 审核。\n",
  );
  await write(
    root,
    `${long}/analysis/qc.md`,
    "# QC\n技术完成，1920x1080，60fps，时长 901 秒，HEVC\n",
  );
  await mkdir(join(root, long, "export"), { recursive: true });
  await writeFile(join(root, long, "export/final_bilibili.mp4"), "");
  await truncate(join(root, long, "export/final_bilibili.mp4"), 33 * 1024 * 1024);

  const blocked = "xiaohongshu/jobs/2026-08-06_environment_blocked";
  await write(root, `${blocked}/source.md`, "# 来源\nhttps://youtube.com/watch?v=blocked\n");
  await write(
    root,
    `${blocked}/publish.md`,
    "# 发布草稿\n环境阻塞：codesign blocker，待环境恢复后继续。\n",
  );

  await exec("git", ["init", root]);
  await exec("git", ["-C", root, "config", "user.email", "content-lab@example.test"]);
  await exec("git", ["-C", root, "config", "user.name", "Content Lab Test"]);
  await exec("git", ["-C", root, "add", "."]);
  await exec("git", ["-C", root, "commit", "-m", "content lab fixtures"]);
  await exec("git", ["-C", root, "branch", "-M", "main"]);
  return root;
}

async function registryFor(root: string) {
  return createProjectResourceRegistry({
    CHAT_PROJECT_ROOTS_JSON: JSON.stringify([
      {
        rootId: "root_contentlab",
        displayName: "Content Lab",
        canonicalPath: root,
        enabledAdapters: ["local-git-workspace.v1", "content-lab-resource.v1"],
      },
    ]),
  });
}

describe("Content Lab Resource Adapter", () => {
  it("六类只读Fixture形成稳定Observation，媒体只按推荐路径定点检查", async () => {
    const root = await contentLabRepository();
    const registry = await registryFor(root);
    const statusBefore = (await exec("git", ["-C", root, "status", "--porcelain=v1", "-uall"]))
      .stdout;
    const first = await registry.observe("root_contentlab");
    const second = await registry.observe("root_contentlab");
    const statusAfter = (await exec("git", ["-C", root, "status", "--porcelain=v1", "-uall"]))
      .stdout;

    expect(second.data.contentLab).toEqual(first.data.contentLab);
    expect(statusAfter).toBe(statusBefore);
    const contentLab = first.data.contentLab!;
    expect(contentLab.scanStats.candidateJobCount).toBe(5);
    expect(contentLab.scanStats.artifactInspectionPolicy).toBe("recommended_paths_only");
    expect(contentLab.catalog.cases.map((item) => item.relativePath)).not.toContain(
      "cases/token-secret.md",
    );

    const normal = contentLab.jobs.find((job) => job.jobKey.endsWith("normal_publish"))!;
    expect(normal.readiness).toBe("review_ready");
    expect(normal.recommendedArtifacts[0]).toMatchObject({
      hashPolicy: "computed",
      mediaKind: "video",
      metadata: { width: 1080, height: 1920, frameRate: 30, durationSeconds: 12.5, codec: "h264" },
    });
    expect(normal.sourceUrls).toEqual(["https://youtube.com/watch?v=normal"]);
    expect(normal.workflowRevisionRefs).toContain("workflows/video_translation_workflow.md");

    const draft = contentLab.jobs.find((job) => job.jobKey.endsWith("publish_draft"))!;
    expect(draft.readiness).toBe("draft");
    expect(draft.recommendedArtifacts[0]?.hashPolicy).toBe("missing");

    const series = contentLab.jobs.find((job) => job.jobKey.endsWith("series_publish"))!;
    expect(series).toMatchObject({ seriesKey: "monstrofarm", readiness: "needs_review" });

    const long = contentLab.jobs.find((job) => job.jobKey.endsWith("long_video"))!;
    expect(long).toMatchObject({ platform: "bilibili", seriesKey: "crash_course_botany" });
    expect(long.recommendedArtifacts[0]).toMatchObject({
      hashPolicy: "deferred_large",
      sizeBytes: 33 * 1024 * 1024,
      metadata: { width: 1920, height: 1080, frameRate: 60, durationSeconds: 901, codec: "hevc" },
    });

    const blocked = contentLab.jobs.find((job) => job.jobKey.endsWith("environment_blocked"))!;
    expect(blocked.readiness).toBe("blocked");
    expect(blocked.blockerSignals.length).toBeGreaterThanOrEqual(1);
    expect(contentLab.catalog.cases.map((item) => item.relativePath)).toContain(
      "cases/2026-08-02_xhs_normal_workflow_retrospective_case.md",
    );
  }, 20_000);

  it("按当前Work编译最小上下文，不注入媒体或全部历史案例", async () => {
    const root = await contentLabRepository();
    const registry = await registryFor(root);
    const observed = await registry.observe("root_contentlab");
    const context = await registry.compileContentLabContext!({
      rootId: "root_contentlab",
      observationSha256: "a".repeat(64),
      observation: observed.data.contentLab!,
      selection: {
        workKind: "content_delivery",
        targetPlatforms: ["xiaohongshu"],
        sourceRef: "https://youtube.com/watch?v=series",
        seriesKey: "monstrofarm",
        resourceRefs: [],
      },
    });

    expect(context.selectedJobKeys).toEqual([
      "xiaohongshu/series/monstrofarm/jobs/2026-08-04_series_publish",
    ]);
    expect(context.items.map((item) => item.relativePath)).toEqual(
      expect.arrayContaining([
        "AGENTS.md",
        "xiaohongshu/series/monstrofarm/AGENTS.md",
        "xiaohongshu/series/monstrofarm/series_registry.md",
        "xiaohongshu/series/monstrofarm/jobs/2026-08-04_series_publish/source.md",
      ]),
    );
    expect(context.items.filter((item) => item.role === "case").length).toBeLessThanOrEqual(3);
    expect(context.items.every((item) => !/\.(?:mp4|mov|mkv)$/iu.test(item.relativePath))).toBe(
      true,
    );
    expect(context.history.every((item) => item.seriesKey === "monstrofarm")).toBe(true);

    const workflowContext = await registry.compileContentLabContext!({
      rootId: "root_contentlab",
      observationSha256: "d".repeat(64),
      observation: observed.data.contentLab!,
      selection: {
        workKind: "workflow_improvement",
        targetPlatforms: [],
        resourceRefs: ["content-lab:workflows"],
      },
    });
    expect(workflowContext.selectedJobKeys).toHaveLength(3);
    expect(workflowContext.items.filter((item) => item.role === "case")).toHaveLength(2);

    const unknownSourceContext = await registry.compileContentLabContext!({
      rootId: "root_contentlab",
      observationSha256: "e".repeat(64),
      observation: observed.data.contentLab!,
      selection: {
        workKind: "content_delivery",
        targetPlatforms: ["xiaohongshu"],
        sourceRef: "https://youtube.com/watch?v=not-yet-observed",
        resourceRefs: [],
      },
    });
    expect(unknownSourceContext.selectedJobKeys).toEqual([]);
    expect(unknownSourceContext.items.some((item) => item.role === "current_job")).toBe(false);
  }, 20_000);

  it("Observation后的受管文件漂移会阻止编译旧上下文", async () => {
    const root = await contentLabRepository();
    const registry = await registryFor(root);
    const observed = await registry.observe("root_contentlab");
    await write(root, "AGENTS.md", "# 已漂移\n");
    await expect(
      registry.compileContentLabContext!({
        rootId: "root_contentlab",
        observationSha256: "b".repeat(64),
        observation: observed.data.contentLab!,
        selection: {
          workKind: "workflow_improvement",
          targetPlatforms: ["xiaohongshu"],
          resourceRefs: ["content-lab:cases"],
        },
      }),
    ).rejects.toMatchObject({ code: "content_lab_observation_drift" });
  }, 20_000);

  it("推荐工件路径越过Root时失败关闭", async () => {
    const root = await contentLabRepository();
    await write(
      root,
      "xiaohongshu/jobs/2026-08-07_escape/publish.md",
      "# 发布包\n推荐上传 `../../../../outside.mp4`\n",
    );
    await write(root, "xiaohongshu/jobs/2026-08-07_escape/source.md", "# 来源\n");
    await exec("git", ["-C", root, "add", "xiaohongshu/jobs/2026-08-07_escape"]);
    await exec("git", ["-C", root, "commit", "-m", "escape fixture"]);
    await expect((await registryFor(root)).observe("root_contentlab")).rejects.toMatchObject({
      code: "project_path_escape",
    });
  }, 20_000);

  it("推荐工件符号链接不能借用Root外文件", async () => {
    const root = await contentLabRepository();
    const outside = await mkdtemp(join(tmpdir(), "content-lab-outside-"));
    await writeFile(join(outside, "secret.mp4"), "outside");
    const job = "xiaohongshu/jobs/2026-08-08_symlink";
    await write(root, `${job}/source.md`, "# 来源\n");
    await write(root, `${job}/publish.md`, "# 发布包\n推荐上传 `export/final.mp4`\n");
    await mkdir(join(root, job, "export"), { recursive: true });
    await symlink(join(outside, "secret.mp4"), join(root, job, "export/final.mp4"));
    await exec("git", ["-C", root, "add", `${job}/source.md`, `${job}/publish.md`]);
    await exec("git", ["-C", root, "commit", "-m", "symlink fixture"]);
    await expect((await registryFor(root)).observe("root_contentlab")).rejects.toMatchObject({
      code: "project_path_escape",
    });
  }, 20_000);

  it("受管文本疑似包含凭据时禁止进入Agent上下文", async () => {
    const root = await contentLabRepository();
    await write(root, "AGENTS.md", "# 治理\napi_key=1234567890-secret\n");
    await exec("git", ["-C", root, "add", "AGENTS.md"]);
    await exec("git", ["-C", root, "commit", "-m", "sensitive fixture"]);
    const registry = await registryFor(root);
    const observed = await registry.observe("root_contentlab");
    await expect(
      registry.compileContentLabContext!({
        rootId: "root_contentlab",
        observationSha256: "c".repeat(64),
        observation: observed.data.contentLab!,
        selection: {
          workKind: "workflow_improvement",
          targetPlatforms: ["xiaohongshu"],
          resourceRefs: ["content-lab:workflows"],
        },
      }),
    ).rejects.toMatchObject({ code: "content_lab_sensitive_content" });
  }, 20_000);
});
