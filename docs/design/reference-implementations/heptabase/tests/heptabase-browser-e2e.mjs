import assert from "node:assert/strict";

async function viewportMetrics(tab) {
  return tab.playwright.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
}

async function interactionScan(tab) {
  return tab.playwright.evaluate(() => {
    const controls = [...document.querySelectorAll(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [role='tab']:not([aria-disabled='true'])",
    )].filter((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    });
    return {
      visible: controls.length,
      small: controls
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            label: element.getAttribute("aria-label") || element.textContent?.trim().slice(0, 80) || element.tagName,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        .filter((item) => item.width < 44 || item.height < 44),
    };
  });
}

function assertNoSmallTargets(scan, surface) {
  assert.deepEqual(scan.small, [], `${surface} has controls below 44px: ${JSON.stringify(scan.small)}`);
}

/**
 * Real-browser E2E contract for Codex Desktop's in-app Browser.
 *
 * The caller supplies the selected IAB Tab and its viewport capability. This
 * deliberately avoids a second browser stack: the same user-selected browser
 * used for visual QA runs the repeatable semantic path.
 */
export async function runHeptabaseBrowserE2E(tab, viewport, { baseUrl = "http://127.0.0.1:4175/" } = {}) {
  const gates = [];

  await tab.goto(baseUrl);
  await viewport.set({ width: 1080, height: 675 });
  await tab.playwright.waitForTimeout(500);

  const desktop = await viewportMetrics(tab);
  assert.deepEqual({ width: desktop.width, height: desktop.height, scrollWidth: desktop.scrollWidth }, { width: 1440, height: 900, scrollWidth: 1440 });
  assertNoSmallTargets(await interactionScan(tab), "desktop initial");
  gates.push("desktop viewport + 44px");

  for (const name of ["Card", "Locations", "Library", "Chat"]) {
    assert.equal(await tab.playwright.getByRole("tab", { name, exact: true }).count(), 1, `${name} tab needs an accessible name`);
  }
  await tab.playwright.getByRole("button", { name: "Open Card Project Context Package v4" }).press("Enter");
  assert.equal(await tab.playwright.getByRole("textbox", { name: "Card title" }).count(), 1);
  gates.push("keyboard Card entry + named panel tabs");

  await tab.playwright.getByRole("tab", { name: "Library", exact: true }).click();
  await tab.playwright.getByPlaceholder("Search Card Library").fill("周末陶艺");
  await tab.playwright.getByRole("button", { name: "Place", exact: true }).click();
  assert.equal(await tab.playwright.getByRole("button", { name: /On board/ }).count(), 1);
  assertNoSmallTargets(await interactionScan(tab), "desktop Library");
  gates.push("Library placement preserves Card identity");

  await tab.playwright.getByRole("tab", { name: "Card", exact: true }).click();
  await tab.playwright.getByRole("tab", { name: "Locations", exact: true }).click();
  await tab.playwright.getByRole("button", { name: /PS2 · Shaping 与 Iteration.*Focus Card/ }).click();
  assert.equal(await tab.playwright.getByRole("button", { name: "Back to previous context" }).count(), 1);
  await tab.playwright.getByRole("button", { name: "Back to previous context" }).click();
  assert.equal(await tab.playwright.getByText("Project Solution · 研究地图", { exact: true }).count() > 0, true);
  gates.push("location focus + Back continuity");

  await tab.playwright.getByRole("tab", { name: "Chat", exact: true }).click();
  await tab.playwright.getByRole("button", { name: "Ask with 2 sources" }).click();
  assert.equal(await tab.playwright.getByText("AI access log", { exact: true }).count(), 1);
  await tab.playwright.getByRole("button", { name: "Save as Card with provenance" }).click();
  assert.equal(await tab.playwright.getByText("This Card is in the Library but not on a Whiteboard.", { exact: true }).count(), 1);
  gates.push("explicit AI context + provenance Card");

  await tab.playwright.getByRole("button", { name: "Share", exact: true }).click();
  await tab.playwright.waitForTimeout(100);
  const modalState = await tab.playwright.evaluate(() => ({
    active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent?.trim(),
    workspaceInert: document.querySelector(".workspace")?.hasAttribute("inert"),
  }));
  assert.equal(modalState.active, "Close share dialog");
  assert.equal(modalState.workspaceInert, true);
  const ajuAccess = tab.playwright.getByLabel("阿橘 access for Project Solution · 研究地图");
  await ajuAccess.selectOption("none");
  const ajuRole = await ajuAccess.evaluate((element) => element.closest("label")?.querySelector("small")?.textContent || "");
  assert.equal(ajuRole, "No access");
  await tab.playwright.getByRole("dialog").press("Escape");
  await tab.playwright.waitForTimeout(100);
  assert.equal(await tab.playwright.getByRole("dialog").count(), 0);
  const restoredFocus = await tab.playwright.evaluate(() => document.activeElement?.textContent?.trim());
  assert.equal(restoredFocus, "Share");
  gates.push("board-scoped Share + modal focus lifecycle");

  await tab.playwright.getByRole("button", { name: "Share", exact: true }).click();
  await viewport.set({ width: 293, height: 633 });
  await tab.playwright.waitForTimeout(100);
  await tab.playwright.getByRole("dialog").press("Escape");
  await tab.playwright.waitForTimeout(100);
  const responsiveFallbackFocus = await tab.playwright.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  assert.equal(responsiveFallbackFocus, "Open navigation");
  gates.push("Share focus fallback across responsive breakpoint");

  await viewport.set({ width: 293, height: 633 });
  await tab.reload();
  await tab.playwright.waitForTimeout(500);
  const mobile = await viewportMetrics(tab);
  assert.deepEqual({ width: mobile.width, height: mobile.height, scrollWidth: mobile.scrollWidth }, { width: 391, height: 844, scrollWidth: 391 });
  assertNoSmallTargets(await interactionScan(tab), "mobile Card panel");
  for (const name of ["Card", "Locations", "Library", "Chat"]) {
    assert.equal(await tab.playwright.getByRole("tab", { name, exact: true }).count(), 1, `${name} mobile tab needs an accessible name`);
  }

  await tab.playwright.getByRole("tab", { name: "Library", exact: true }).click();
  assertNoSmallTargets(await interactionScan(tab), "mobile Library");
  await tab.playwright.getByRole("tab", { name: "Chat", exact: true }).click();
  assertNoSmallTargets(await interactionScan(tab), "mobile Chat");
  await tab.playwright.getByRole("button", { name: "Close context sidebar" }).click();
  await tab.playwright.getByRole("button", { name: "Open navigation" }).click();
  await tab.playwright.getByRole("button", { name: /个人工作室 · 陶艺/ }).click();
  assert.equal(await tab.playwright.getByRole("heading", { name: "这周练习" }).count(), 1);
  assertNoSmallTargets(await interactionScan(tab), "mobile Whiteboard outline");
  gates.push("mobile panels + navigation + 44px");

  const consoleMessages = await tab.dev.logs({ levels: ["error", "warn"], limit: 100 });
  const appConsoleMessages = consoleMessages.filter((entry) => !/immersive|translate/i.test(`${entry.message} ${entry.url || ""}`));
  assert.deepEqual(appConsoleMessages, []);
  gates.push("console 0");

  return {
    passed: gates.length,
    gates,
    desktop,
    mobile,
    console: appConsoleMessages.length,
  };
}
