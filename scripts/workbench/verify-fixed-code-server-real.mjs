import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { describeProcess, findListenerPid, parentPid } from "../debug/lib.mjs";
import { resolveSharedFixedCacheRoot } from "../dev/app-runtime.mjs";
import { startWebGateway } from "../dsh/web-gateway.mjs";
import {
  chatRepoRoot,
  DISABLED_EXTENSIONS_GALLERY,
  probeCodeServerSocketReady,
  readCodeServerProcessEvidence,
  resolveCodeServerTemporaryParent,
  validateCodeServerSocketEvidence,
  validateFixedCodeServerCache,
} from "./fixed-code-server.mjs";

const repoRoot = chatRepoRoot();
const requireFromDshApp = createRequire(resolve(repoRoot, "apps/dsh-web/package.json"));
const { chromium } = requireFromDshApp("@playwright/test");
const sharedCacheRoot = resolveSharedFixedCacheRoot(repoRoot);
process.env.CHAT_FIXED_SOURCE_CACHE_ROOT = sharedCacheRoot;
if (!validateFixedCodeServerCache(repoRoot)) {
  throw new Error(
    "固定 code-server 尚未准备或证据损坏；真实门不会隐式下载，请先运行 pnpm workbench:prepare:code-server",
  );
}
if (findListenerPid(43_113) !== null) throw new Error("43113必须无监听；真实门拒绝复用或终止");

const testsRoot = resolve(repoRoot, ".data/tests");
mkdirSync(testsRoot, { recursive: true });
const testRoot = mkdtempSync(join(testsRoot, "fixed-code-server-real-"));
const workspaceRoot = resolve(testRoot, "workspace");
const runRoot = resolve(workspaceRoot, ".data/runtime");
mkdirSync(workspaceRoot);

function run(command, args, cwd = workspaceRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

run("git", ["init", "--quiet"]);
run("git", ["config", "user.name", "Chat Workbench Test"]);
run("git", ["config", "user.email", "workbench-test@invalid.local"]);
writeFileSync(resolve(workspaceRoot, "fixture.txt"), "baseline\n", "utf8");
run("git", ["add", "fixture.txt"]);
run("git", ["commit", "--quiet", "-m", "baseline"]);
appendFileSync(resolve(workspaceRoot, "fixture.txt"), "changed-before-ui\n", "utf8");

const canaryName = "CHAT_TEST_CANARY_SECRET";
const canaryValue = `must-not-reach-code-server-${String(process.pid)}`;
const spawnedServices = [];
const trackedChildren = new Map();
let terminalProcess;
let gateway;
let parentFixture;
const workbenchTemporaryParent = resolveCodeServerTemporaryParent(process.env);

function wrapperEnvironment() {
  const environment = {
    CHAT_REPO_ROOT: workspaceRoot,
    CHAT_FIXED_SOURCE_CACHE_ROOT: sharedCacheRoot,
    CHAT_CODE_WORKBENCH_ROOT: workspaceRoot,
    CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot,
    CHAT_CODE_WORKBENCH_TEMP_PARENT: workbenchTemporaryParent,
    EXTENSIONS_GALLERY: JSON.stringify({ serviceUrl: "https://parent-pollution.invalid" }),
    [canaryName]: canaryValue,
  };
  for (const name of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SHELL",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
  ]) {
    const value = process.env[name];
    if (typeof value === "string" && value !== "") environment[name] = value;
  }
  return environment;
}

function processEvidenceEnvironment() {
  return {
    CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot,
    CHAT_CODE_WORKBENCH_TEMP_PARENT: workbenchTemporaryParent,
    CHAT_FIXED_SOURCE_CACHE_ROOT: sharedCacheRoot,
  };
}

function externalNetworkUrls(urls, protocols) {
  return urls.filter((rawUrl) => {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      return true;
    }
    if (!protocols.includes(url.protocol)) return false;
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  });
}

function startWrapper() {
  const child = spawn(
    process.execPath,
    [resolve(repoRoot, "scripts/workbench/start-fixed-code-server.mjs")],
    { cwd: repoRoot, env: wrapperEnvironment(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  const service = { child, output: () => ({ stdout, stderr }) };
  spawnedServices.push(service);
  return service;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function isDescendantOf(pid, ancestorPid) {
  let current = pid;
  for (let depth = 0; depth < 12; depth += 1) {
    if (current === ancestorPid) return true;
    const next = parentPid(current);
    if (next === null || next <= 1 || next === current) return false;
    current = next;
  }
  return false;
}

function trackProcess(pid, label) {
  const description = describeProcess(pid);
  if (description === null || !description.command.includes("code-server")) {
    throw new Error(`${label}缺少本轮code-server进程身份`);
  }
  trackedChildren.set(pid, description);
}

async function waitForExit(child, timeoutMs) {
  if (exited(child)) return;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(
      () => reject(new Error("code-server wrapper 未在期限内退出")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function waitForReady(service) {
  const deadline = Date.now() + 45_000;
  let lastError;
  while (Date.now() < deadline) {
    if (exited(service.child)) {
      throw new Error(
        `code-server在就绪前退出：${service.output().stderr.split(/\r?\n/u).slice(-3).join(" ")}`,
      );
    }
    try {
      const evidence = await probeCodeServerSocketReady(workspaceRoot, {
        environment: processEvidenceEnvironment(),
        timeoutMs: 1_000,
      });
      trackProcess(evidence.childPid, "code-server child");
      return evidence;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
  }
  const output = service.output();
  throw new Error(
    `固定code-server 45秒内未通过Unix socket就绪门：${lastError instanceof Error ? lastError.message : String(lastError)}；${`${output.stdout}\n${output.stderr}`.split(/\r?\n/u).filter(Boolean).slice(-8).join(" ")}`,
  );
}

function assertReadableStoppedEvidence(runningEvidence) {
  const stopped = readCodeServerProcessEvidence(workspaceRoot, processEvidenceEnvironment());
  if (
    stopped?.status !== "stopped" ||
    stopped.instanceId !== runningEvidence.instanceId ||
    stopped.wrapperPid !== undefined ||
    stopped.childPid !== undefined ||
    stopped.privateRoot !== undefined ||
    stopped.socketPath !== undefined ||
    stopped.cacheRoot !== undefined
  ) {
    throw new Error(`停止后未发布同instance最小tombstone：${JSON.stringify(stopped)}`);
  }
  const statusOutput = execFileSync(
    process.execPath,
    [resolve(repoRoot, "scripts/dev/status.mjs")],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...wrapperEnvironment(),
        CHAT_DEBUG_DIR: resolve(runRoot, "debug"),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (
    !statusOutput.includes(
      `[chat] 已停止 workbench transport=unix-socket instanceId=${runningEvidence.instanceId}`,
    )
  ) {
    throw new Error(`停止后status未读取Unix socket tombstone：${statusOutput.trim()}`);
  }
  return stopped;
}

function trackedChildIsAlive(pid) {
  const expected = trackedChildren.get(pid);
  const current = describeProcess(pid);
  return (
    expected !== undefined &&
    current !== null &&
    current.command === expected.command &&
    Math.abs(current.startedAtMs - expected.startedAtMs) <= 2_000
  );
}

function findProcessByCanary(canary) {
  const output = execFileSync("ps", ["ax", "-o", "pid=,command="], { encoding: "utf8" });
  const matches = output
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(.+)$/u.exec(line))
    .filter((match) => match?.[2]?.includes(canary));
  if (matches.length !== 1)
    throw new Error(`Terminal canary数量必须为1，实际${String(matches.length)}`);
  const pid = Number.parseInt(matches[0][1], 10);
  const description = describeProcess(pid);
  if (description === null) throw new Error("Terminal canary缺少进程身份");
  return { pid, ...description, canary };
}

function terminalProcessIsAlive(identity) {
  if (identity === undefined) return false;
  const current = describeProcess(identity.pid);
  return (
    current !== null &&
    current.command === identity.command &&
    current.command.includes(identity.canary)
  );
}

async function assertTcpRefused(port) {
  await new Promise((resolveRefused, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`${String(port)}意外接受TCP连接`));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolveRefused();
      else reject(error);
    });
  });
}

async function startGateway(socketPath) {
  parentFixture = createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(
      `<!doctype html><button id="toggle">toggle</button><iframe id="workbench" src="http://localhost:43110/workbench/code/"></iframe><script>document.querySelector('#toggle').onclick=()=>{const f=document.querySelector('#workbench');f.style.display=f.style.display==='none'?'block':'none'}</script>`,
    );
  });
  const parentPort = await new Promise((resolveListen, rejectListen) => {
    parentFixture.once("error", rejectListen);
    parentFixture.listen(0, "127.0.0.1", () => resolveListen(parentFixture.address().port));
  });
  gateway = await startWebGateway({
    targets: {
      dsh: { host: "127.0.0.1", port: parentPort },
      workbench: { socketPath },
    },
  });
}

async function runWorkbenchCommand(frame, command) {
  await frame.locator("body").press("F1");
  const commandInput = frame.locator(".quick-input-widget input:visible").last();
  await commandInput.waitFor({ state: "visible" });
  await commandInput.fill(`>${command}`);
  await commandInput.press("Enter");
}

async function ensureWorkspaceTrusted(frame) {
  const startupTrust = frame.getByRole("button", {
    name: "Trust Folder & Continue",
    exact: true,
  });
  let trustedFromStartup = false;
  try {
    await startupTrust.waitFor({ state: "visible", timeout: 5_000 });
    await startupTrust.click();
    trustedFromStartup = true;
  } catch {
    // 启动提示可能已被用户状态关闭；继续通过正式Workspace Trust命令确定性确认。
  }
  if (!trustedFromStartup) {
    await runWorkbenchCommand(frame, "Workspaces: Manage Workspace Trust");
    const trustAction = frame.getByRole("button", { name: "Trust", exact: true });
    try {
      await trustAction.waitFor({ state: "visible", timeout: 10_000 });
      await trustAction.click();
      await frame
        .locator(".workspace-trust-header.workspace-trust-trusted")
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const diagnostic = await frame.locator("body").evaluate((element) => ({
        text: element.innerText,
        buttons: Array.from(element.querySelectorAll("button"))
          .map((button) => button.innerText || button.getAttribute("aria-label"))
          .filter(Boolean),
      }));
      throw new Error(
        `Workspace Trust管理页缺少精确Trust按钮：${error instanceof Error ? error.message : String(error)}；${JSON.stringify(diagnostic)}`,
      );
    }
    const trustEditor = frame.locator(".monaco-modal-editor-block:visible");
    for (let attempt = 0; attempt < 2 && (await trustEditor.count()) > 0; attempt += 1) {
      await runWorkbenchCommand(frame, "View: Close Editor");
      await trustEditor
        .first()
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => undefined);
    }
    if ((await trustEditor.count()) > 0) {
      throw new Error("Workspace Trust管理编辑器未关闭，拒绝绕过遮挡操作Explorer");
    }
  }
  const restricted = frame
    .getByText(/None of the registered source control providers work in Restricted Mode/u)
    .filter({ visible: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && (await restricted.count()) > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  if ((await restricted.count()) > 0) throw new Error("Workspace仍处于Restricted Mode");
}

async function exerciseWorkbenchUi(evidence) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const websocketUrls = [];
  const requestUrls = [];
  context.on("request", (request) => requestUrls.push(request.url()));
  context.on("page", (page) => page.on("websocket", (socket) => websocketUrls.push(socket.url())));
  const page = await context.newPage();
  page.on("websocket", (socket) => websocketUrls.push(socket.url()));
  try {
    await page.goto("http://127.0.0.1:43110/", { waitUntil: "domcontentloaded" });
    const iframe = page.locator("#workbench");
    await iframe.waitFor({ state: "visible" });
    const frame = page.frames().find((candidate) => candidate.url().includes("/workbench/code/"));
    if (frame === undefined) throw new Error("父页面未挂载localhost隔离Workbench iframe");
    await frame.locator(".monaco-workbench").waitFor({ state: "visible", timeout: 30_000 });

    await ensureWorkspaceTrusted(frame);

    await runWorkbenchCommand(frame, "View: Show Explorer");
    const explorerSidebar = frame.locator(".part.sidebar:visible");
    const explorerFile = explorerSidebar
      .getByText("fixture.txt", { exact: true })
      .filter({ visible: true });
    await explorerFile.first().waitFor({ state: "visible", timeout: 20_000 });
    if ((await explorerFile.count()) !== 1) {
      throw new Error("Explorer visible sidebar中的fixture资源必须唯一");
    }
    let explorerRow = explorerFile
      .locator("xpath=ancestor::*[@role='treeitem'][1]")
      .filter({ visible: true });
    if ((await explorerRow.count()) === 0) {
      explorerRow = explorerFile
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' monaco-list-row ')][1]",
        )
        .filter({ visible: true });
    }
    if ((await explorerRow.count()) !== 1) {
      throw new Error("Explorer fixture必须解析到唯一visible tree row");
    }
    await explorerRow.dblclick();
    if ((await explorerRow.getAttribute("aria-selected")) !== "true") {
      throw new Error("Explorer fixture row打开后未保持selected");
    }
    const editorSurface = frame.locator('.monaco-editor[data-uri$="/fixture.txt"]:visible');
    await editorSurface.waitFor({ state: "visible", timeout: 10_000 });
    const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${primaryModifier}+End`);
    await page.keyboard.type("saved-through-monaco");
    try {
      await editorSurface
        .locator(".view-line")
        .filter({ hasText: "saved-through-monaco" })
        .waitFor({ state: "visible", timeout: 5_000 });
    } catch {
      const active = await frame.evaluate(() => ({
        tag: document.activeElement?.tagName,
        className: document.activeElement?.className,
      }));
      throw new Error(`键盘输入未进入fixture Monaco；active=${JSON.stringify(active)}`);
    }
    await page.keyboard.press(`${primaryModifier}+S`);
    const saveDeadline = Date.now() + 10_000;
    while (
      Date.now() < saveDeadline &&
      !readFileSync(resolve(workspaceRoot, "fixture.txt"), "utf8").includes("saved-through-monaco")
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (
      !readFileSync(resolve(workspaceRoot, "fixture.txt"), "utf8").includes("saved-through-monaco")
    ) {
      throw new Error("Monaco保存未写入隔离fixture workspace");
    }

    await runWorkbenchCommand(frame, "View: Show Source Control");
    const scmSidebar = frame.locator(".part.sidebar:visible");
    const scmFile = scmSidebar.getByText("fixture.txt", { exact: true }).filter({ visible: true });
    try {
      await scmFile.first().waitFor({ state: "visible", timeout: 15_000 });
      if ((await scmFile.count()) !== 1) throw new Error("visible fixture row不唯一");
    } catch (error) {
      const diagnostic = await scmSidebar.evaluate((element) => ({
        text: element.innerText,
        ariaLabels: Array.from(element.querySelectorAll("[aria-label]"))
          .map((node) => node.getAttribute("aria-label"))
          .filter((value) => value !== null),
      }));
      throw new Error(
        `SCM visible sidebar缺少唯一fixture资源：${error instanceof Error ? error.message : String(error)}；${JSON.stringify(diagnostic)}`,
      );
    }
    let scmRow = scmFile
      .locator("xpath=ancestor::*[@role='treeitem'][1]")
      .filter({ visible: true });
    if ((await scmRow.count()) === 0) {
      scmRow = scmFile
        .locator(
          "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' monaco-list-row ')][1]",
        )
        .filter({ visible: true });
    }
    if ((await scmRow.count()) !== 1) {
      throw new Error("SCM fixture必须解析到唯一visible resource row");
    }
    const scmRowAriaLabel = await scmRow.getAttribute("aria-label");
    if (
      !/fixture\.txt/iu.test(scmRowAriaLabel ?? "") ||
      !/Modified/iu.test(scmRowAriaLabel ?? "")
    ) {
      throw new Error(`SCM resource row缺少fixture/Modified语义：${String(scmRowAriaLabel)}`);
    }
    await scmFile.click();
    const selectedDeadline = Date.now() + 5_000;
    while (
      Date.now() < selectedDeadline &&
      (await scmRow.getAttribute("aria-selected")) !== "true"
    ) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if ((await scmRow.getAttribute("aria-selected")) !== "true") {
      throw new Error(
        `SCM resource row单击后未selected：${await scmRow.evaluate((element) => element.outerHTML)}`,
      );
    }
    const scmTree = scmRow.locator("xpath=ancestor::*[@role='tree'][1]");
    if ((await scmTree.count()) !== 1) throw new Error("SCM resource row缺少唯一role=tree祖先");
    const scmRowId = await scmRow.getAttribute("id");
    if (scmRowId === null || (await scmTree.getAttribute("aria-activedescendant")) !== scmRowId) {
      throw new Error(
        `SCM tree active descendant未指向selected row：row=${String(scmRowId)} active=${String(await scmTree.getAttribute("aria-activedescendant"))}`,
      );
    }
    await scmTree.focus();
    if (!(await scmTree.evaluate((element) => document.activeElement === element))) {
      throw new Error("SCM tree focus后不是document.activeElement");
    }
    await page.keyboard.press("Enter");
    let diffEvidence;
    const diffDeadline = Date.now() + 20_000;
    while (Date.now() < diffDeadline) {
      diffEvidence = await frame.evaluate(() => {
        const diffEditors = Array.from(document.querySelectorAll(".monaco-diff-editor"));
        const diffEditor = diffEditors[0];
        const editorInstance = diffEditor?.closest(".editor-instance");
        const editorUris = Array.from(
          editorInstance?.querySelectorAll(".monaco-editor[data-uri]") ?? [],
        )
          .filter((element) => element.checkVisibility())
          .map((element) => element.getAttribute("data-uri"))
          .filter((value) => value !== null);
        return {
          diffCount: diffEditors.length,
          diffVisible: diffEditor?.checkVisibility() === true,
          editorInstanceVisible: editorInstance?.checkVisibility() === true,
          editorInstanceAriaLabel: editorInstance?.getAttribute("aria-label") ?? null,
          originalUris: editorUris.filter(
            (uri) => uri.startsWith("git:") && /\/fixture\.txt(?:\?|$)/u.test(uri),
          ),
          workingUris: editorUris.filter(
            (uri) =>
              uri.startsWith("vscode-remote://localhost:43110/") &&
              /\/fixture\.txt(?:\?|$)/u.test(uri),
          ),
        };
      });
      if (
        diffEvidence.diffCount === 1 &&
        diffEvidence.diffVisible &&
        diffEvidence.editorInstanceVisible &&
        diffEvidence.editorInstanceAriaLabel ===
          "fixture.txt (Working Tree) (fixture.txt), preview" &&
        diffEvidence.originalUris.length === 1 &&
        diffEvidence.workingUris.length === 1
      ) {
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (
      diffEvidence?.diffCount !== 1 ||
      !diffEvidence.diffVisible ||
      !diffEvidence.editorInstanceVisible ||
      diffEvidence.editorInstanceAriaLabel !==
        "fixture.txt (Working Tree) (fixture.txt), preview" ||
      diffEvidence.originalUris.length !== 1 ||
      diffEvidence.workingUris.length !== 1
    ) {
      throw new Error(`SCM Diff三证据未同时成立：${JSON.stringify(diffEvidence)}`);
    }

    await page.keyboard.press("Control+Backquote");
    const terminalInput = frame.locator(".xterm-helper-textarea:visible").last();
    await terminalInput.waitFor({ state: "visible", timeout: 20_000 });
    const canary = `chat-workbench-terminal-${String(process.pid)}-${String(Date.now())}`;
    await terminalInput.focus();
    await page.keyboard.type(`"${process.execPath}" -e 'setInterval(() => {}, 1000)' ${canary}`);
    await page.keyboard.press("Enter");
    const terminalDeadline = Date.now() + 10_000;
    while (Date.now() < terminalDeadline) {
      try {
        terminalProcess = findProcessByCanary(canary);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
      }
    }
    if (terminalProcess === undefined || !isDescendantOf(terminalProcess.pid, evidence.childPid)) {
      throw new Error("Terminal canary不是本轮code-server child后代");
    }

    let registrations = [];
    const registrationDeadline = Date.now() + 10_000;
    while (Date.now() < registrationDeadline && registrations.length === 0) {
      registrations = await frame.evaluate(async () =>
        (await navigator.serviceWorker.getRegistrations()).map(
          (registration) => registration.scope,
        ),
      );
      if (registrations.length === 0)
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    if (registrations.length === 0) throw new Error("真实code-server未注册Service Worker");
    if (registrations.some((scope) => scope !== "http://localhost:43110/workbench/code/")) {
      throw new Error(`Service Worker scope越界：${registrations.join(",")}`);
    }
    if (
      !websocketUrls.some((rawUrl) => {
        const url = new URL(rawUrl);
        return (
          ["localhost", "127.0.0.1"].includes(url.hostname) &&
          url.port === "43110" &&
          url.pathname.startsWith("/workbench/code/")
        );
      })
    ) {
      throw new Error(`未观察到经Gateway前缀代理的动态WebSocket：${websocketUrls.join(",")}`);
    }

    const iframeMarker = `same-frame-${String(Date.now())}`;
    await iframe.evaluate((element, marker) => {
      element.dataset.workbenchIdentity = marker;
    }, iframeMarker);
    await page.locator("#toggle").click();
    await iframe.waitFor({ state: "hidden" });
    if (!terminalProcessIsAlive(terminalProcess))
      throw new Error("隐藏Workbench后Terminal提前退出");
    await page.locator("#toggle").click();
    await iframe.waitFor({ state: "visible" });
    if ((await iframe.getAttribute("data-workbench-identity")) !== iframeMarker) {
      throw new Error("返回Workbench时iframe节点被重新创建");
    }
    await page.waitForTimeout(1_500);
    const externalRequests = externalNetworkUrls(requestUrls, ["http:", "https:"]);
    const externalWebSockets = externalNetworkUrls(websocketUrls, ["ws:", "wss:"]);
    if (externalRequests.length > 0 || externalWebSockets.length > 0) {
      throw new Error(
        `真实Workbench禁止Open VSX、Copilot、telemetry及任意外部网络：HTTP=${JSON.stringify(externalRequests)} WS=${JSON.stringify(externalWebSockets)}`,
      );
    }
  } finally {
    await browser.close();
  }
  if (!terminalProcessIsAlive(terminalProcess))
    throw new Error("关闭浏览器后Terminal canary提前退出");
}

async function stopAndAssert(service, evidence, signal) {
  service.child.kill(signal);
  await waitForExit(service.child, 8_000);
  const deadline = Date.now() + 3_000;
  while (
    Date.now() < deadline &&
    (trackedChildIsAlive(evidence.childPid) ||
      terminalProcessIsAlive(terminalProcess) ||
      existsSync(evidence.socketPath))
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (
    trackedChildIsAlive(evidence.childPid) ||
    terminalProcessIsAlive(terminalProcess) ||
    existsSync(evidence.socketPath)
  ) {
    throw new Error(`${signal}后child、Terminal或Unix socket未完全回收`);
  }
  if (findListenerPid(43_113) !== null) throw new Error(`${signal}后43113出现监听者`);
  terminalProcess = undefined;
}

async function assertUnexpectedChildExitCleansDescendants(service, evidence) {
  process.kill(evidence.childPid, "SIGKILL");
  await waitForExit(service.child, 8_000);
  const deadline = Date.now() + 3_000;
  while (
    Date.now() < deadline &&
    (terminalProcessIsAlive(terminalProcess) || existsSync(evidence.socketPath))
  ) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  if (terminalProcessIsAlive(terminalProcess) || existsSync(evidence.socketPath)) {
    throw new Error("code-server主child异常退出后Terminal后代或Unix socket未回收");
  }
  terminalProcess = undefined;
}

async function assertConcurrentWrapperFails(firstService, firstEvidence) {
  const before = readFileSync(resolve(runRoot, "service-process.json"));
  const second = startWrapper();
  await waitForExit(second.child, 10_000);
  if (second.child.exitCode === 0) throw new Error("第二个wrapper未被43119租约拒绝");
  const after = readFileSync(resolve(runRoot, "service-process.json"));
  if (!before.equals(after)) throw new Error("被拒绝的第二wrapper覆盖了第一套process evidence");
  if (exited(firstService.child) || !trackedChildIsAlive(firstEvidence.childPid)) {
    throw new Error("第二wrapper失败时破坏了第一套运行实例");
  }
  await probeCodeServerSocketReady(workspaceRoot, {
    environment: {
      CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot,
      CHAT_CODE_WORKBENCH_TEMP_PARENT: workbenchTemporaryParent,
      CHAT_FIXED_SOURCE_CACHE_ROOT: sharedCacheRoot,
    },
    timeoutMs: 1_000,
  });
}

try {
  const first = startWrapper();
  const evidence = await waitForReady(first);
  await assertConcurrentWrapperFails(first, evidence);
  const validated = validateCodeServerSocketEvidence(workspaceRoot, {
    CHAT_CODE_WORKBENCH_RUN_ROOT: runRoot,
    CHAT_CODE_WORKBENCH_TEMP_PARENT: workbenchTemporaryParent,
    CHAT_FIXED_SOURCE_CACHE_ROOT: sharedCacheRoot,
  });
  if ((statSync(validated.privateRoot).mode & 0o777) !== 0o700)
    throw new Error("socket目录不是0700");
  if ((statSync(validated.socketPath).mode & 0o777) !== 0o600) throw new Error("socket不是0600");
  if (findListenerPid(43_113) !== null) throw new Error("code-server启动后43113不应有监听");
  await assertTcpRefused(43_113);
  const launcherCommand = describeProcess(evidence.childPid)?.command ?? "";
  if (!launcherCommand.includes("--socket") || launcherCommand.includes("--bind-addr")) {
    throw new Error("真实code-server未使用纯Unix socket启动合同");
  }
  const processEnvironment = run(
    "ps",
    ["eww", "-p", String(evidence.childPid), "-o", "command="],
    repoRoot,
  );
  if (processEnvironment.includes(canaryName) || processEnvironment.includes(canaryValue)) {
    throw new Error("code-server child继承了测试秘密变量");
  }
  if (
    !processEnvironment.includes(`EXTENSIONS_GALLERY=${DISABLED_EXTENSIONS_GALLERY}`) ||
    processEnvironment.includes("parent-pollution.invalid")
  ) {
    throw new Error("code-server child未把EXTENSIONS_GALLERY精确固定为空对象");
  }
  await startGateway(evidence.socketPath);
  const gatewayPage = await fetch("http://localhost:43110/workbench/code/", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!gatewayPage.ok || !(await gatewayPage.text()).toLowerCase().includes("code-server")) {
    throw new Error("43110 Gateway未返回真实code-server HTML");
  }
  await exerciseWorkbenchUi(evidence);
  await gateway.close();
  gateway = undefined;
  await new Promise((resolveClose) => parentFixture.close(resolveClose));
  parentFixture = undefined;
  await assertUnexpectedChildExitCleansDescendants(first, evidence);
  assertReadableStoppedEvidence(evidence);

  const second = startWrapper();
  const secondEvidence = await waitForReady(second);
  if (secondEvidence.instanceId === evidence.instanceId) {
    throw new Error("restart未生成新的code-server instanceId");
  }
  await stopAndAssert(second, secondEvidence, "SIGTERM");
  assertReadableStoppedEvidence(secondEvidence);
  const third = startWrapper();
  const thirdEvidence = await waitForReady(third);
  if ([evidence.instanceId, secondEvidence.instanceId].includes(thirdEvidence.instanceId)) {
    throw new Error("第二次restart复用了历史code-server instanceId");
  }
  await stopAndAssert(third, thirdEvidence, "SIGINT");
  assertReadableStoppedEvidence(thirdEvidence);
  console.log(
    "[code-server-real] Unix socket 0600、43113拒绝、Gateway HTTP/WS、Monaco Files/Save、SCM Diff、SW scope、Surface保活、Terminal及TERM/INT回收门通过",
  );
} finally {
  if (gateway !== undefined) await gateway.close().catch(() => undefined);
  if (parentFixture !== undefined)
    await new Promise((resolveClose) => parentFixture.close(resolveClose));
  for (const service of spawnedServices) if (!exited(service.child)) service.child.kill("SIGTERM");
  await Promise.all(
    spawnedServices.map((service) =>
      waitForExit(service.child, 7_000).catch(() => service.child.kill("SIGKILL")),
    ),
  );
  for (const pid of trackedChildren.keys())
    if (trackedChildIsAlive(pid)) process.kill(-pid, "SIGKILL");
  if (terminalProcessIsAlive(terminalProcess)) process.kill(terminalProcess.pid, "SIGKILL");
  if (findListenerPid(43_113) === null && existsSync(testRoot))
    rmSync(testRoot, { recursive: true, force: true });
}
