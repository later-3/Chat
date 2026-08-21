import { expect, type Frame, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DSH_REAL_E2E_PORTS,
  resolveDshRealWorkbenchFixtureRoot,
} from "../../../scripts/e2e/dsh-real-environment.mjs";
import {
  assertDshRealTerminalCanaryAlive,
  type DshRealTerminalCanaryEvidence,
  waitForAndRecordDshRealTerminalCanary,
} from "../../../scripts/e2e/dsh-real-terminal-canary.mjs";

export const WORKBENCH_ORIGIN = `http://localhost:${String(DSH_REAL_E2E_PORTS.web)}`;
const DSH_ORIGIN = `http://127.0.0.1:${String(DSH_REAL_E2E_PORTS.web)}`;
const DSH_WS_ORIGIN = `ws://127.0.0.1:${String(DSH_REAL_E2E_PORTS.web)}`;
const WORKBENCH_WS_ORIGIN = `ws://localhost:${String(DSH_REAL_E2E_PORTS.web)}`;
const WORKBENCH_REMOTE_PREFIX = `vscode-remote://localhost:${String(DSH_REAL_E2E_PORTS.web)}/`;
const WORKBENCH_EDIT_MARKER = "modified through DSH Workbench E2E";
const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export interface WorkbenchTraffic {
  readonly browserRequests: string[];
  readonly webSockets: string[];
}

export function observeWorkbenchTraffic(page: Page): WorkbenchTraffic {
  const browserRequests: string[] = [];
  const webSockets: string[] = [];
  page.on("request", (request) => browserRequests.push(request.url()));
  // 先无条件记录再在完成门做唯一白名单；监听阶段过滤会把越界DSH/扩展WS藏掉。
  page.on("websocket", (socket) => webSockets.push(socket.url()));
  return { browserRequests, webSockets };
}

function isWorkbenchFrame(frame: Frame): boolean {
  try {
    const url = new URL(frame.url());
    return (
      url.origin === WORKBENCH_ORIGIN &&
      (url.pathname === "/workbench/code" || url.pathname.startsWith("/workbench/code/"))
    );
  } catch {
    return false;
  }
}

/**
 * iframe元素先进入DOM、跨origin导航随后才提交。同步读取page.frames()会偶发只看到
 * about:blank；这里先安装framenavigated监听，再二次检查现有Frame，关闭两者之间的竞态。
 */
export async function waitForWorkbenchFrame(page: Page, timeoutMs = 60_000): Promise<Frame> {
  const existing = page.frames().find(isWorkbenchFrame);
  if (existing !== undefined) return existing;

  return await new Promise<Frame>((resolveFrame, rejectFrame) => {
    let settled = false;
    const finish = (frame: Frame) => {
      if (settled || !isWorkbenchFrame(frame)) return;
      settled = true;
      clearTimeout(timer);
      page.off("framenavigated", finish);
      page.off("close", onClose);
      resolveFrame(frame);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("framenavigated", finish);
      rejectFrame(new Error("等待Workbench iframe导航时DSH页面提前关闭"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      page.off("framenavigated", finish);
      page.off("close", onClose);
      rejectFrame(
        new Error(
          `Workbench隔离iframe未在时限内导航：${page
            .frames()
            .map((frame) => frame.url())
            .join(", ")}`,
        ),
      );
    }, timeoutMs);

    page.on("framenavigated", finish);
    page.on("close", onClose);
    for (const frame of page.frames()) finish(frame);
  });
}

export async function openDshEmptyHero(page: Page): Promise<void> {
  await page.goto("/");
  const internalTestingContinue = page.getByRole("button", { name: "Continue", exact: true });
  if (
    await internalTestingContinue
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await internalTestingContinue.click();
  }

  // Workbench是全局Workspace能力。保持rc.6刚启动的blank Hero，不创建私有Session、
  // 不写localStorage，也不发送消息；全局Sidebar root slot必须在此状态直接可达。
  const composer = page.locator("textarea:visible").last();
  await expect(composer).toBeVisible();
  if (!(await composer.isEnabled())) {
    await page.getByRole("button", { name: /选择工作区|Choose workspace/u }).click();
    await page.getByRole("menuitem", { name: "Chat", exact: true }).click();
  }
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue("");
  const send = page.getByRole("button", { name: /发送消息|Send message/u });
  await expect(send).toBeVisible();
  await expect(send).toBeDisabled();
  await expect(page.getByTestId("lifeos-open-workbench")).toBeVisible();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function runWorkbenchCommand(frame: Frame, command: string): Promise<void> {
  await frame.locator("body").press("F1");
  const commandInput = frame.locator(".quick-input-widget input:visible").last();
  await expect(commandInput).toBeVisible();
  await commandInput.fill(`>${command}`);
  await commandInput.press("Enter");
}

async function trustWorkbenchWorkspace(frame: Frame): Promise<void> {
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
    // 启动提示可能已被隔离Profile状态关闭；走正式管理页确定性确认。
  }
  if (!trustedFromStartup) {
    await runWorkbenchCommand(frame, "Workspaces: Manage Workspace Trust");
    const trust = frame.getByRole("button", { name: "Trust", exact: true });
    try {
      await trust.waitFor({ state: "visible", timeout: 10_000 });
      await trust.click();
      await frame
        .locator(".workspace-trust-header.workspace-trust-trusted")
        .waitFor({ state: "visible", timeout: 10_000 });
    } catch (error) {
      const diagnostic = await frame.locator("body").evaluate((element) => ({
        text: (element as HTMLElement).innerText,
        buttons: [...element.querySelectorAll("button")]
          .map((button) => (button as HTMLElement).innerText || button.getAttribute("aria-label"))
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
  await expect(restricted).toHaveCount(0, { timeout: 10_000 });
}

export async function exerciseDshWorkbench(
  page: Page,
  traffic: WorkbenchTraffic,
): Promise<DshRealTerminalCanaryEvidence> {
  await page.getByTestId("lifeos-open-workbench").click();
  const workbenchFrameElement = page.getByTestId("lifeos-workbench-frame");
  await expect(workbenchFrameElement).toBeVisible();
  await expect(workbenchFrameElement).toHaveAttribute("src", `${WORKBENCH_ORIGIN}/workbench/code/`);
  const workbenchFrame = await waitForWorkbenchFrame(page);
  await expect(workbenchFrame.locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
  await trustWorkbenchWorkspace(workbenchFrame);

  expect(new URL(workbenchFrame.url()).origin).toBe(WORKBENCH_ORIGIN);
  expect(new URL(page.url()).origin).toBe(DSH_ORIGIN);
  expect(
    await workbenchFrame.evaluate(() => {
      try {
        void window.parent.document.body;
        return true;
      } catch {
        return false;
      }
    }),
  ).toBe(false);
  await expect(workbenchFrame.locator("body")).toContainText(/workbench-fixture/iu);

  await runWorkbenchCommand(workbenchFrame, "View: Show Explorer");
  const explorerSidebar = workbenchFrame.locator(".part.sidebar:visible");
  const explorerFile = explorerSidebar
    .getByText("fixture.txt", { exact: true })
    .filter({ visible: true });
  await expect(explorerFile.first()).toBeVisible();
  expect(await explorerFile.count()).toBe(1);
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
  expect(await explorerRow.count()).toBe(1);
  await explorerRow.dblclick();
  await expect(explorerRow).toHaveAttribute("aria-selected", "true");
  const editorSurface = workbenchFrame.locator('.monaco-editor[data-uri$="/fixture.txt"]:visible');
  await expect(editorSurface).toBeVisible();
  const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${primaryModifier}+End`);
  await page.keyboard.press("Enter");
  await page.keyboard.type(WORKBENCH_EDIT_MARKER);
  await expect(
    editorSurface.locator(".view-line").filter({ hasText: WORKBENCH_EDIT_MARKER }),
  ).toBeVisible();
  await page.keyboard.press(`${primaryModifier}+S`);

  const fixturePath = resolve(resolveDshRealWorkbenchFixtureRoot(REPO_ROOT), "fixture.txt");
  await expect
    .poll(() => readFileSync(fixturePath, "utf8"), { timeout: 15_000 })
    .toContain(WORKBENCH_EDIT_MARKER);

  await runWorkbenchCommand(workbenchFrame, "View: Show Source Control");
  const scmSidebar = workbenchFrame.locator(".part.sidebar:visible");
  const changedFixture = scmSidebar
    .getByText("fixture.txt", { exact: true })
    .filter({ visible: true });
  await expect(changedFixture.first()).toBeVisible();
  expect(await changedFixture.count()).toBe(1);
  // 固定4.132.0 Git源码的Resource.command携带left/right/title；无参数Palette命令
  // 无法恢复该资源。真实UI先用文本click选中row，再由拥有active descendant的tree
  // 处理Enter，才能按VS Code列表合同触发该Resource.command。
  await changedFixture.click();
  let changedFixtureRow = changedFixture
    .locator("xpath=ancestor::*[@role='treeitem'][1]")
    .filter({ visible: true });
  if ((await changedFixtureRow.count()) === 0) {
    changedFixtureRow = changedFixture
      .locator(
        "xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' monaco-list-row ')][1]",
      )
      .filter({ visible: true });
  }
  expect(await changedFixtureRow.count()).toBe(1);
  await expect(changedFixtureRow).toHaveAttribute("aria-label", /Modified/u);
  await expect(changedFixtureRow).toHaveAttribute("aria-selected", "true");
  const changedFixtureRowId = await changedFixtureRow.getAttribute("id");
  if (changedFixtureRowId === null || changedFixtureRowId === "") {
    throw new Error("SCM fixture row缺少供tree引用的id");
  }
  const scmTree = changedFixtureRow
    .locator("xpath=ancestor::*[@role='tree'][1]")
    .filter({ visible: true });
  expect(await scmTree.count()).toBe(1);
  await expect(scmTree).toHaveAttribute("aria-activedescendant", changedFixtureRowId);
  await scmTree.focus();
  expect(await scmTree.evaluate((tree) => document.activeElement === tree)).toBe(true);
  await page.keyboard.press("Enter");
  // Monaco Diff根节点在4.132.0会因内部布局得到width=0，Playwright的`:visible`
  // 因此是假阴性。用DOM可见性、可见父editor与双URI共同证明单文件Diff真实打开。
  let diffEvidence = {
    diffCount: 0,
    diffVisible: false,
    editorInstanceVisible: false,
    editorInstanceAriaLabel: null as string | null,
    originalUris: [] as string[],
    workingUris: [] as string[],
  };
  const hasSemanticDiffLabel = (label: string | null): boolean => {
    if (label === null || !label.endsWith("preview")) return false;
    const workingTree = label.indexOf("fixture.txt (Working Tree)");
    const targetBasename = label.indexOf("fixture.txt", workingTree + 1);
    return workingTree >= 0 && targetBasename > workingTree;
  };
  const diffDeadline = Date.now() + 20_000;
  while (Date.now() < diffDeadline) {
    diffEvidence = await workbenchFrame.evaluate((workbenchRemotePrefix) => {
      const diffEditors = [...document.querySelectorAll(".monaco-diff-editor")];
      const diffEditor = diffEditors[0];
      const editorInstance = diffEditor?.closest(".editor-instance");
      const editorUris = [...(editorInstance?.querySelectorAll(".monaco-editor[data-uri]") ?? [])]
        .filter((element) => element.checkVisibility())
        .map((element) => element.getAttribute("data-uri"))
        .filter((value): value is string => value !== null);
      return {
        diffCount: diffEditors.length,
        diffVisible: diffEditor?.checkVisibility() === true,
        editorInstanceVisible: editorInstance?.checkVisibility() === true,
        editorInstanceAriaLabel: editorInstance?.getAttribute("aria-label") ?? null,
        originalUris: editorUris.filter(
          (uri) => uri.startsWith("git:") && /\/fixture\.txt(?:\?|$)/u.test(uri),
        ),
        workingUris: editorUris.filter(
          (uri) => uri.startsWith(workbenchRemotePrefix) && /\/fixture\.txt(?:\?|$)/u.test(uri),
        ),
      };
    }, WORKBENCH_REMOTE_PREFIX);
    if (
      diffEvidence.diffCount === 1 &&
      diffEvidence.diffVisible &&
      diffEvidence.editorInstanceVisible &&
      hasSemanticDiffLabel(diffEvidence.editorInstanceAriaLabel) &&
      diffEvidence.originalUris.length === 1 &&
      diffEvidence.workingUris.length === 1
    ) {
      break;
    }
    await page.waitForTimeout(100);
  }
  expect(diffEvidence).toMatchObject({
    diffCount: 1,
    diffVisible: true,
    editorInstanceVisible: true,
  });
  expect(hasSemanticDiffLabel(diffEvidence.editorInstanceAriaLabel)).toBe(true);
  expect(diffEvidence.originalUris).toHaveLength(1);
  expect(diffEvidence.workingUris).toHaveLength(1);

  await page.keyboard.press("Control+Backquote");
  const terminalInput = workbenchFrame.locator(".xterm-helper-textarea:visible").last();
  await expect(terminalInput).toBeVisible({ timeout: 20_000 });
  await terminalInput.focus();
  const terminalCanary = `chat-dsh-workbench-terminal-${randomUUID()}`;
  const terminalCommand = [
    shellQuote(process.execPath),
    "-e",
    shellQuote("console.log(process.argv[1]); setInterval(() => {}, 1000)"),
    terminalCanary,
  ].join(" ");
  await page.keyboard.type(terminalCommand);
  await page.keyboard.press("Enter");
  // xterm 4.132可能使用canvas而没有稳定`.xterm-rows` DOM；Terminal能力以唯一
  // 长寿命argv进程及其完整OS身份链为主证，不能反向依赖渲染实现细节。
  const terminalEvidence = await waitForAndRecordDshRealTerminalCanary(REPO_ROOT, terminalCanary, {
    environment: process.env,
  });
  assertDshRealTerminalCanaryAlive(REPO_ROOT, {
    environment: process.env,
    requireRunningWorkbench: true,
  });

  await expect.poll(() => traffic.webSockets.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
  let dshSocketCount = 0;
  let workbenchSocketCount = 0;
  for (const socketUrl of traffic.webSockets) {
    const parsed = new URL(socketUrl);
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
    expect(parsed.hash).toBe("");
    if (parsed.origin === DSH_WS_ORIGIN) {
      // 固定rc.6 @deepseek-ai/dsh-client-connection与Host仅共享并注册这两条Upgrade。
      expect(["/api/events.mux", "/api/events.host"]).toContain(parsed.pathname);
      dshSocketCount += 1;
      continue;
    }
    if (parsed.origin === WORKBENCH_WS_ORIGIN) {
      expect(parsed.pathname).toMatch(/^\/workbench\/code\/stable-[a-f0-9]{40}$/u);
      workbenchSocketCount += 1;
      continue;
    }
    throw new Error(`浏览器WebSocket越过固定DSH/Workbench白名单：${socketUrl}`);
  }
  expect(dshSocketCount).toBeGreaterThanOrEqual(1);
  expect(workbenchSocketCount).toBeGreaterThanOrEqual(1);

  await expect
    .poll(
      () =>
        workbenchFrame.evaluate(async () =>
          (await navigator.serviceWorker.getRegistrations()).map(
            (registration) => registration.scope,
          ),
        ),
      { timeout: 15_000 },
    )
    .toEqual([`${WORKBENCH_ORIGIN}/workbench/code/`]);

  const externalBrowserRequests = traffic.browserRequests.filter((url) => {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      ![DSH_ORIGIN, WORKBENCH_ORIGIN].includes(parsed.origin)
    );
  });
  expect(externalBrowserRequests).toEqual([]);
  expect(traffic.browserRequests.join("\n")).not.toMatch(
    new RegExp(
      `telemetry\\.coder\\.com|vortex\\.data\\.microsoft\\.com|431\\d{2}|${String(DSH_REAL_E2E_PORTS.webInternal)}`,
      "iu",
    ),
  );

  const iframeIdentity = `workbench-frame-${String(Date.now())}`;
  await workbenchFrameElement.evaluate((element, marker) => {
    element.dataset.workbenchE2eIdentity = marker;
  }, iframeIdentity);
  const socketsBeforeClose = traffic.webSockets.length;
  await page.getByTestId("lifeos-close-workbench").click();
  await expect(page.getByTestId("lifeos-workbench-surface")).toHaveAttribute("data-open", "false");
  await expect(workbenchFrameElement).toHaveCount(1);
  assertDshRealTerminalCanaryAlive(REPO_ROOT, {
    environment: process.env,
    requireRunningWorkbench: true,
  });
  await page.getByTestId("lifeos-open-workbench").click();
  await expect(page.getByTestId("lifeos-workbench-surface")).toHaveAttribute("data-open", "true");
  await expect(workbenchFrameElement).toHaveAttribute(
    "data-workbench-e2e-identity",
    iframeIdentity,
  );
  expect(page.frames().find(isWorkbenchFrame)).toBe(workbenchFrame);
  await expect(terminalInput).toBeVisible();
  expect(traffic.webSockets).toHaveLength(socketsBeforeClose);
  assertDshRealTerminalCanaryAlive(REPO_ROOT, {
    environment: process.env,
    requireRunningWorkbench: true,
  });

  // Browser生命周期不能拥有PTY：关闭页面后进程仍须属于同一code-server instance；
  // 最终退出由Playwright外层finally调用正式reconcile回收并复核。
  await page.close();
  assertDshRealTerminalCanaryAlive(REPO_ROOT, {
    environment: process.env,
    requireRunningWorkbench: true,
  });
  return terminalEvidence;
}
