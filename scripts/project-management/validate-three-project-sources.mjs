#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error(
        "用法: validate-three-project-sources.mjs --mini-claw <path> --content-lab <path> --pipecat <path>",
      );
    }
    values.set(key.slice(2), value);
  }
  for (const required of ["mini-claw", "content-lab", "pipecat"]) {
    if (!values.has(required)) throw new Error(`缺少参数 --${required}`);
  }
  return values;
}

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function trackedFiles(root) {
  const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean);
}

function read(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function exists(root, relativePath) {
  try {
    accessSync(join(root, relativePath), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function repositoryFacts(root) {
  const files = trackedFiles(root);
  return {
    directoryName: basename(root),
    branch: git(root, "branch", "--show-current"),
    headSha: git(root, "rev-parse", "HEAD"),
    dirtyEntryCount: git(root, "status", "--porcelain=v1").split("\n").filter(Boolean).length,
    trackedFileCount: files.length,
    testFileCount: files.filter(
      (file) =>
        /(^|\/)(test|tests|__tests__)(\/|$)/u.test(file) || /\.(test|spec)\.[^.]+$/u.test(file),
    ).length,
  };
}

function check(value, evidence) {
  return { passed: Boolean(value), evidence };
}

const args = parseArgs(process.argv.slice(2));
const miniClawRoot = args.get("mini-claw");
const contentLabRoot = args.get("content-lab");
const pipecatRoot = args.get("pipecat");
const miniReadme = read(miniClawRoot, "README.md");
const miniContext = read(miniClawRoot, "PROJECT_CONTEXT.md");
const miniState = read(miniClawRoot, "PROJECT_STATE.md");
const contentReadme = read(contentLabRoot, "README.md");
const contentAgents = read(contentLabRoot, "AGENTS.md");
const pipecatAgents = read(pipecatRoot, "AGENTS.md");
const pipecatContributing = read(pipecatRoot, "CONTRIBUTING.md");
const pipecatPyproject = read(pipecatRoot, "pyproject.toml");

const projects = {
  miniClaw: {
    ...repositoryFacts(miniClawRoot),
    checks: {
      productIdentity: check(
        miniReadme.includes("# Mini-Claw") && miniReadme.includes("9—12 岁儿童"),
        "README.md声明Mini-Claw及9—12岁儿童产品对象",
      ),
      governanceMap: check(
        (exists(miniClawRoot, "AGENTS.md") || exists(dirname(miniClawRoot), "AGENTS.md")) &&
          exists(miniClawRoot, "PROJECT_CONTEXT.md") &&
          exists(miniClawRoot, "PROJECT_STATE.md"),
        "仓库或父Workspace的AGENTS.md可读，项目内PROJECT_CONTEXT.md与PROJECT_STATE.md可读",
      ),
      explicitPause: check(
        miniState.includes("暂停D10") && miniState.includes("D10和G-P0审核包"),
        "PROJECT_STATE.md明确暂停D10和G-P0审核包",
      ),
      evidenceLevels: check(
        miniState.includes("E1") && miniState.includes("没有E2老师、E3儿童或E4效果"),
        "PROJECT_STATE.md区分E1代理证据与缺失的E2/E3/E4真实证据",
      ),
      researchInventory: check(
        miniState.includes("共37个") &&
          miniState.includes("共36仓库") &&
          miniState.includes("共86条对象记录"),
        "PROJECT_STATE.md记录37个商业产品、36个开源仓库与86条对象台账",
      ),
      productVsTechnicalEvidence: check(
        miniContext.includes("只证明技术可行性") && miniContext.includes("继续阻塞"),
        "PROJECT_CONTEXT.md明确技术验证不等于产品接入或真实设备证据",
      ),
    },
  },
  contentLab: {
    ...repositoryFacts(contentLabRoot),
    checks: {
      productIdentity: check(
        contentReadme.includes("小红书和 B 站内容起号与生产子项目"),
        "README.md声明内容生产而非软件交付项目",
      ),
      managedArtifactDirectories: check(
        ["briefs", "drafts", "cases", "workflows", "archive", "xiaohongshu", "bilibili"].every(
          (directory) => exists(contentLabRoot, directory),
        ),
        "briefs/drafts/cases/workflows/archive/xiaohongshu/bilibili均存在",
      ),
      publicationOutcome: check(
        contentAgents.includes("每次任务都以可发布内容为目标") &&
          contentReadme.includes("发布资料"),
        "AGENTS.md与README.md把可发布内容和发布包定义为结果",
      ),
      reviewGate: check(
        contentAgents.includes("分步审核是质量门") && contentAgents.includes("关键节点停下"),
        "AGENTS.md定义审核节点和质量门",
      ),
      caseToPractice: check(
        contentAgents.includes("复盘案例") &&
          contentAgents.includes("同步更新") &&
          contentAgents.includes("workflows/"),
        "AGENTS.md要求案例沉淀并反哺工作流、模板或规则",
      ),
      agentRecovery: check(
        contentReadme.includes("新 agent 必须先读") &&
          contentReadme.includes("video_translation_workflow.md"),
        "README.md提供新Agent固定必读路标",
      ),
    },
  },
  pipecat: {
    ...repositoryFacts(pipecatRoot),
    origin: git(pipecatRoot, "remote", "get-url", "origin"),
    checks: {
      officialOrigin: check(
        git(pipecatRoot, "remote", "get-url", "origin") ===
          "https://github.com/pipecat-ai/pipecat.git",
        "origin精确指向pipecat-ai/pipecat官方仓库",
      ),
      contributionContract: check(
        pipecatContributing.includes("Add a changelog entry") &&
          pipecatContributing.includes("Every pull request"),
        "CONTRIBUTING.md定义PR与changelog fragment要求",
      ),
      deterministicQualityGates: check(
        pipecatPyproject.includes("pytest") &&
          pipecatPyproject.includes("pyright") &&
          pipecatPyproject.includes("ruff"),
        "pyproject.toml固定pytest、Pyright与Ruff质量工具",
      ),
      behavioralEvaluation: check(
        pipecatAgents.includes("Behavioral evals") && pipecatAgents.includes("pipecat eval suite"),
        "AGENTS.md定义真实Bot行为评测与发布前suite",
      ),
      governanceMap: check(
        exists(pipecatRoot, "AGENTS.md") &&
          exists(pipecatRoot, "CONTRIBUTING.md") &&
          exists(pipecatRoot, "pyproject.toml"),
        "AGENTS.md、CONTRIBUTING.md、pyproject.toml可读",
      ),
    },
  },
};

const failures = Object.entries(projects).flatMap(([projectKey, project]) =>
  Object.entries(project.checks)
    .filter(([, result]) => !result.passed)
    .map(([checkKey, result]) => ({ projectKey, checkKey, evidence: result.evidence })),
);

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: "chat-project-source-validation.v1",
      passed: failures.length === 0,
      failures,
      projects,
    },
    null,
    2,
  )}\n`,
);
process.exitCode = failures.length === 0 ? 0 : 1;
