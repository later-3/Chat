#!/usr/bin/env node
/**
 * Cuts a Chat release: version, release page, entry-document pointers, verification
 * record, tags and the install-URL probe — the whole checklist that used to be done
 * by hand (docs/operations/README.md §发布).
 *
 *   pnpm release:cut -- 0.5.4 0.12.1          commit, tag and push both repositories
 *   pnpm release:cut -- 0.5.4 --dry-run       print the plan, touch nothing
 *
 * The frontend version is optional: without it the script derives the next one from
 * the commits since the frontend's latest tag (features -> minor, otherwise patch).
 * Every step prints what it does and aborts on the first failure; nothing is forced.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const ENTRY_DOCUMENTS = [
  "README.md",
  "docs/README.md",
  "docs/operations/README.md",
  "docs/operations/installation.md",
  "docs/development/debugging/first-install.md",
];

const args = process.argv.slice(2);
const flags = new Set(args.filter((argument) => argument.startsWith("--")));
const positional = args.filter((argument) => !argument.startsWith("--"));
const dryRun = flags.has("--dry-run");
const pushEnabled = !dryRun && !flags.has("--no-push");
const runTests = !flags.has("--skip-tests");
const runGates = !flags.has("--skip-gates") && !dryRun;

/** Runs a command. `mutating` commands are skipped (and printed) in a dry run. */
function run(command, commandArgs, options = {}) {
  const { cwd = repositoryRoot, mutating = false } = options;
  if (mutating && dryRun) {
    console.log(`  [dry-run] ${command} ${commandArgs.join(" ")}`);
    return "";
  }
  if (mutating) console.log(`  $ ${command} ${commandArgs.join(" ")}`);
  return execFileSync(command, commandArgs, { cwd, encoding: "utf8", stdio: mutating ? "inherit" : "pipe" }).trim();
}
function read(path) { return readFileSync(resolve(repositoryRoot, path), "utf8"); }
function write(path, contents) {
  console.log(`  write ${path}`);
  if (!dryRun) writeFileSync(resolve(repositoryRoot, path), contents);
}
function replaceAll(path, pairs) {
  let body = read(path);
  for (const [from, to] of pairs) {
    if (!body.includes(from)) throw new Error(`${path}: expected text not found: ${from.slice(0, 80)}`);
    body = body.split(from).join(to);
  }
  write(path, body);
}
function compareVersions(left, right) {
  const a = left.split(".").map(Number); const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}
function requireClean(path, label) {
  const dirty = run("git", ["-C", path, "status", "--porcelain"]);
  if (dirty !== "") throw new Error(`${label} has uncommitted changes; commit or stash them first:\n${dirty}`);
}
function lastTag(path) {
  const tags = run("git", ["-C", path, "tag", "--list", "v[0-9]*", "--sort=-creatordate"]).split("\n").filter(Boolean);
  return tags[0] ?? "";
}
function subjectsSince(path, since) {
  const range = since === "" ? "HEAD" : `${since}..HEAD`;
  return run("git", ["-C", path, "log", "--no-merges", "--format=%s", range]).split("\n").filter(Boolean);
}
function deriveFrontendVersion(packageVersion, subjects) {
  const [major, minor, patch] = packageVersion.split(".").map(Number);
  return subjects.some((subject) => /^feat(\(|:)/.test(subject)) ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
function bodyOf(subjects) {
  return subjects.length === 0 ? "- 无用户可见改动的提交记录" : subjects.map((subject) => `- ${subject}`).join("\n");
}

// ------------------------------------------------------------------ plan -----
if (positional.length === 0 || flags.has("--help")) {
  console.log("usage: pnpm release:cut -- <chat-version> [frontend-version] [--dry-run] [--no-push] [--skip-tests] [--skip-gates]");
  process.exit(positional.length === 0 ? 1 : 0);
}

const chatVersion = positional[0];
if (!/^\d+\.\d+\.\d+$/.test(chatVersion)) throw new Error(`chat version must look like 0.5.4, got ${chatVersion}`);
requireClean(".", "the Chat repository");
requireClean("frontend", "the frontend submodule");

const chatPackage = JSON.parse(read("package.json"));
const frontendPackage = JSON.parse(read("frontend/package.json"));
if (compareVersions(chatVersion, chatPackage.version) <= 0) {
  throw new Error(`chat version ${chatVersion} must be greater than the current ${chatPackage.version}`);
}
const previousChatVersion = chatPackage.version;
const previousRelease = `release-${previousChatVersion}.md`;
const nextRelease = `release-${chatVersion}.md`;
const frontendTag = lastTag("frontend");
const frontendSubjects = subjectsSince("frontend", frontendTag);
const frontendVersion = positional[1] ?? deriveFrontendVersion(frontendPackage.version, frontendSubjects);
if (!/^\d+\.\d+\.\d+$/.test(frontendVersion)) throw new Error(`frontend version must look like 0.12.1, got ${frontendVersion}`);
if (compareVersions(frontendVersion, frontendPackage.version) <= 0 && positional[1] !== undefined) {
  throw new Error(`frontend version ${frontendVersion} must be greater than the current ${frontendPackage.version}`);
}
for (const [label, path, tag] of [["parent", ".", `v${chatVersion}`], ["frontend", "frontend", `v${frontendVersion}`]]) {
  if (run("git", ["-C", path, "tag", "--list", tag]) !== "") throw new Error(`${label} tag ${tag} already exists; pick another version`);
}

const reviewFile = `release-${chatVersion}.md`;
const chatSubjects = subjectsSince(".", lastTag(".")).filter((subject) => !/^chore\(release\)|^chore: frontend submodule/.test(subject));
const pins = run("git", ["ls-tree", "HEAD", "frontend", "pi", "nanoclaw"]).split("\n")
  .map((line) => line.split(/\s+/)).map(([, , sha, name]) => [name, sha.slice(0, 9)]);
const pinOf = (name) => pins.find(([pinName]) => pinName === name)?.[1] ?? "unknown";

console.log(`\nCutting Chat ${chatVersion} with Frontend ${frontendVersion}`);
console.log(`  current: chat ${previousChatVersion}, frontend ${frontendPackage.version}`);
console.log(`  frontend commits since ${frontendTag || "(no tag)"}: ${frontendSubjects.length}`);
console.log(`  chat commits since ${lastTag(".") || "(no tag)"}: ${chatSubjects.length}`);
console.log(`  pinned: ${pins.map(([name, sha]) => `${name} ${sha}`).join(", ")} (frontend moves to the release commit)`);
console.log(`  files: frontend/package.json, package.json, docs/operations/${nextRelease}, docs/history/reviews/${reviewFile}, ${ENTRY_DOCUMENTS.length} entry documents\n`);

// -------------------------------------------------------------- frontend -----
console.log("frontend");
replaceAll("frontend/package.json", [[`"version": "${frontendPackage.version}"`, `"version": "${frontendVersion}"`]]);
if (runTests) {
  run("pnpm", ["--dir", "frontend", "test"], { mutating: true });
  run("pnpm", ["--dir", "frontend", "typecheck"], { mutating: true });
}
run("pnpm", ["--dir", "frontend", "build"], { mutating: true });
if (!dryRun) {
  const hit = execFileSync("grep", ["-rl", frontendVersion, "frontend/dist/assets"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  if (hit === "") throw new Error(`the built bundle does not carry ${frontendVersion}`);
  console.log(`  bundle carries ${frontendVersion}`);
}
run("git", ["-C", "frontend", "add", "package.json"], { mutating: true });
run("git", ["-C", "frontend", "commit", "-m", `chore(release): frontend ${frontendVersion}`, "-m", bodyOf(frontendSubjects)], { mutating: true });

// ------------------------------------------------------------- chat files ----
console.log("chat");
write(`docs/operations/${nextRelease}`, renderReleasePage());
write(`docs/history/reviews/${reviewFile}`, renderReview());
replaceAll("package.json", [[`"version": "${previousChatVersion}"`, `"version": "${chatVersion}"`]]);
for (const path of ENTRY_DOCUMENTS) {
  replaceAll(path, [[previousRelease, nextRelease], [`v${previousChatVersion}`, `v${chatVersion}`], [previousChatVersion, chatVersion]]);
}
const previousBody = read(`docs/operations/${previousRelease}`);
if (!previousBody.includes("历史版本页")) {
  const [firstLine, ...rest] = previousBody.split("\n");
  write(`docs/operations/${previousRelease}`, [firstLine, "", `> 历史版本页：当前版本见[${chatVersion} 交付步骤](./${nextRelease})。`, ...rest].join("\n"));
}
replaceAll("docs/history/README.md", [[
  "| 主题 | 记录 |\n|---|---|",
  `| 主题 | 记录 |\n|---|---|\n| ${chatVersion} 版本与交付核对 | [${today() === "" ? "2026-09-29" : today()}](./reviews/${reviewFile}) |`,
]]);

function today() {
  return new Date().toISOString().slice(0, 10);
}
function renderReleasePage() {
  return `# Chat ${chatVersion}：Linux release 与 VS Code 调试交付

本版为 Chat \`${chatVersion}\`、Frontend \`${frontendVersion}\`。从父仓库标签 \`v${chatVersion}\` 递归取得三个固定子模块；Pi 使用受管 Fork 的精确提交 \`${pinOf("pi")}\`，基础包版本仍为 \`0.85.1\`，没有发布新的 Pi npm 包。NanoClaw 保持 \`v2.5.0\` 的固定提交 \`${pinOf("nanoclaw")}\`。不要用子模块远端最新分支代替 gitlink。

## 本版变化

${bodyOf(chatSubjects)}

升级已有数据前停止服务并备份，按 [Friend 迁移合同](./friend-migration.md)处理版本化索引和迁移标记。新机器空安装不需要搬迁旧电脑数据。

## 1. 安装 release

适用 Ubuntu/Debian Linux、x86_64/aarch64，PID 1 必须为 systemd。其他支持范围及 WSL2 前提见[安装指南](./installation.md)。以下安装命令不启动服务、不启用开机自启。

\`\`\`bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location https://raw.githubusercontent.com/later-3/Chat/v${chatVersion}/deploy/chatctl -o /tmp/chatctl-${chatVersion}
sudo bash /tmp/chatctl-${chatVersion} install --ref v${chatVersion} --with-nanoclaw
\`\`\`

脚本安装固定 Node/pnpm、拉取子模块、恢复 Pi 固定模型快照、验证并构建 Backend/Web，另准备 Nano Host。只用普通 Workflow 可以去掉 \`--with-nanoclaw\`；使用 Friend、助手记忆或群聊时保留它。

## 2. 拉起、检查与关闭 release

\`\`\`bash
sudo /opt/chat/deploy/chatctl start
sudo /opt/chat/deploy/chatctl status
# 使用结束或更新之前：
sudo /opt/chat/deploy/chatctl stop
# 下次拉起，无需重新安装：
sudo /opt/chat/deploy/chatctl start
\`\`\`

页面在 \`http://127.0.0.1:43110\`。远程机器先做[SSH 转发](./network.md)，不要为调试直接开放服务端口。Web 没有产品登录密码；在设置中单独配置模型与 Provider 认证。首次完成模型配置后执行 \`sudo /opt/chat/deploy/chatctl doctor\`。没有凭据时可以打开设置，不代表 Agent 已可调用真实模型。

开机自启用 \`chatctl enable\`，取消用 \`chatctl disable\`；两者不立即启动/停止。日志用 \`sudo journalctl -u chat -u nanoclaw-chat -n 100 --no-pager\`。停止顺序为 Nano → Backend，保留数据；在途任务可能中断，目前没有跨服务排空保证。

## 3. 准备独立 VS Code 源码

以日常开发用户在自己的目录准备第二份 checkout，不在 \`/opt/chat\` 中编辑或运行调试。Node ≥22.19.0 与 Corepack 由开发用户环境提供；release 的私有工具链不会自动加入开发用户 PATH。完整依赖准备见[新源码环境](../development/debugging/first-install.md)。

\`\`\`bash
mkdir -p ~/Code
git clone --branch v${chatVersion} --recurse-submodules https://github.com/later-3/Chat.git ~/Code/Chat
cd ~/Code/Chat
git switch -c codex/linux-development
corepack enable
corepack prepare pnpm@10.13.1 --activate
pnpm pi:prepare
pnpm install --frozen-lockfile
pnpm debug:prepare
pnpm debug:prepare:nanoclaw
code .
\`\`\`

本机 Linux 桌面安装 VS Code 和 Chrome 后，在“运行和调试”选择 \`Debug Chat + NanoClaw\`，按 **F5**。它启动 Backend、Web、假模型与隔离 Nano；使用 TUI 时选择 \`Debug Chat Web + TUI + NanoClaw\`。只调普通 Workflow 使用 \`Debug Chat\`。命令面板快捷键在 Linux/Windows 为 **Ctrl+Shift+P**，macOS 为 **Command+Shift+P**。逐模块调试与断点见[环境说明](../development/debugging/environment.md)。

无桌面的远程 Linux：通过 VS Code Remote SSH 打开开发 checkout，转发 \`35145\` 和 \`45112\`；终端运行 \`pnpm debug:start -- --nanoclaw\` 后，在本地浏览器访问转发的 \`35145\`。需要后端断点时先 \`pnpm debug:stop\`，用 F5 分别启动 \`Run Local Model\`、\`Debug Backend\`、\`Run NanoClaw\`，在终端运行 \`pnpm debug:frontend\`。不要把桌面 F5 的自动浏览器行为视作 Remote SSH 已验收。

## 4. 检查与关闭调试

\`\`\`bash
pnpm debug:smoke -- --long-agent
pnpm debug:stop
pnpm debug:stop -- --check
\`\`\`

\`Debug Chat…\` 快捷组合的停止按钮会停止整组；\`Run Chat (full environment)\` / \`Debug Backend (full environment)\` 只停止选中的模块，全部关闭仍用 \`pnpm debug:stop\`。关闭浏览器不会关闭服务。

| 项目 | release | VS Code / debug |
|---|---|---|
| 源码 | \`/opt/chat\`，由 chatctl 管理 | \`~/Code/Chat\`，开发用户管理 |
| Backend / Web | \`43110\`，同一个构建服务 | Backend \`45112\`，Vite \`35145\` |
| Nano / 假模型 | Nano \`3000\`；真实模型需配置 | Nano \`45300\`；本地假模型 \`45401\` |
| Chat 数据 | \`/home/chat/.chat\` | 开发 checkout 的 \`.data/debug/chat-home\` |
| Nano 数据 | \`/opt/chat/nanoclaw\` 下私有目录 | \`.data/debug/nanoclaw\` 下私有目录 |
| 启停 | \`sudo /opt/chat/deploy/chatctl start/stop\` | F5 或 \`pnpm debug:start\`；\`pnpm debug:stop\` |

## 5. 验收边界

本地验证记录见[发布核对](../history/reviews/${reviewFile})。安装脚本会在目标平台执行 \`pnpm verify\`；无 Chrome 的纯服务器会明确跳过浏览器场景，不能把这种结果当作浏览器验收。安装 Chrome/Chromium 后由普通用户在开发 checkout 运行 \`pnpm verify\` 可补齐；自定义路径使用 \`CHROME_BIN=/absolute/path/to/chrome pnpm verify\`。生产服务本身不依赖浏览器。

新 Linux 上仍需记录：OS/架构、\`git -C /opt/chat rev-parse HEAD\`、\`git -C /opt/chat submodule status\`、release 与 debug 各两次启停、停止 debug 后 release 仍可访问，以及 Session/Memory 保留。真实 Provider 调用、真实渠道收发、Linux systemd 和 VS Code GUI 断点分别验收；本机假模型和服务适配器通过不能替代这些结果。
`;
}
function renderReview() {
  return `# ${chatVersion} 发布核对

## 范围

本轮只做版本与交付记录；不更新本机正式服务、不迁移正式数据，也不在空白 Linux 主机执行 systemd 安装。本记录由 \`pnpm release:cut\` 生成，发布内容与判断需要人工复核。

Chat \`${chatVersion}\`、Frontend \`${frontendVersion}\`；Pi \`${pinOf("pi")}\`、NanoClaw \`${pinOf("nanoclaw")}\` 沿用固定提交。父仓库 \`v${chatVersion}\` 记录全部 gitlink。

## 本版变化

${bodyOf(chatSubjects)}

Frontend（\`${frontendVersion}\`）：

${bodyOf(frontendSubjects)}

## 验证记录

- 发布门禁：\`node scripts/check-architecture.mjs\` 与 \`node --test scripts/deployment-config.test.mjs\`（版本、交付页、安装标签、验证记录与入口文档一致性）。
- \`pnpm test:dev\` 浏览器场景需要 Chrome；未运行必须在人工复核时写明。
- 新 Linux 真机安装、systemd 启停与 VS Code GUI 断点仍未验收。

## 未验收边界

Linux systemd 空机安装、两套环境同时运行、GUI 断点、真实 Provider 调用与真实渠道收发均未在本机验收。
`;
}

// ------------------------------------------------------------------ gates ----
if (runGates) {
  console.log("gates");
  run("node", ["scripts/check-architecture.mjs"], { mutating: true });
  run("node", ["--test", "scripts/deployment-config.test.mjs"], { mutating: true });
}

// ---------------------------------------------------------- commit + push ----
if (dryRun) {
  console.log("\ndry run: nothing was written, committed, tagged or pushed\n");
  process.exit(0);
}
run("git", ["add", "package.json", "docs", "frontend"], { mutating: true });
run("git", ["commit", "-m", `chore(release): ${chatVersion}`, "-m", bodyOf(chatSubjects)], { mutating: true });
if (pushEnabled) {
  run("git", ["-C", "frontend", "push", "origin", "main"], { mutating: true });
  run("git", ["-C", "frontend", "tag", "-a", `v${frontendVersion}`, "-m", `Frontend ${frontendVersion}`], { mutating: true });
  run("git", ["-C", "frontend", "push", "origin", `v${frontendVersion}`], { mutating: true });
  run("git", ["push", "origin", "main"], { mutating: true });
  run("git", ["tag", "-a", `v${chatVersion}`, "-m", `Chat ${chatVersion} (Frontend ${frontendVersion})`], { mutating: true });
  run("git", ["push", "origin", `v${chatVersion}`], { mutating: true });
}
console.log(`\nrelease ${chatVersion} prepared. Verify the raw install URL for v${chatVersion} and fill in the verification record's judgement.\n`);
