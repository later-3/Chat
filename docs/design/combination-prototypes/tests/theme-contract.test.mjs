import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getInitialRoute, getTheme, referenceUrl, themeCatalog, themeIds } from "../src/model.js";

const root = new URL("../", import.meta.url);
const appSource = await readFile(new URL("src/App.jsx", root), "utf8");
const expectedThemes = ["source", "warm-room", "quiet-day", "graphite-ops", "common-thread"];
const sources = ["basecamp", "linear", "things", "hey", "agent-feed", "heptabase"];

function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("source baseline and four unified themes have stable ids", () => {
  assert.deepEqual(themeIds, expectedThemes);
  assert.deepEqual(themeCatalog.map((theme) => theme.id), expectedThemes);
  assert.equal(getTheme("missing").id, "source");
  assert.equal(getInitialRoute({ search: "?composition=room-linear&scene=room&theme=missing" }).themeId, "source");
});

test("host exposes five accessible switch buttons and propagates the selected theme", () => {
  assert.match(appSource, /function ThemeChooser/);
  assert.match(appSource, /aria-label="视觉主题"/);
  assert.match(appSource, /aria-pressed=\{theme\.id === activeId\}/);
  assert.match(appSource, /onClick=\{\(\) => onChange\(theme\.id\)\}/);
  assert.match(appSource, /themeId,/);

  const originalWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://example.test" } };
  try {
    const url = new URL(referenceUrl("linear", "room-linear", "?view=issues", "graphite-ops"));
    assert.equal(url.searchParams.get("theme"), "graphite-ops");
  } finally {
    globalThis.window = originalWindow;
  }
});

test("all six reused sources load visual-only theme overrides after source styles", async () => {
  const structuralDeclaration = /(^|[;{]\s*)(?:display|position|grid(?:-template)?|flex(?:-direction|-wrap|-basis)?|inline-size|block-size|width|height|min-width|max-width|min-height|max-height|margin|padding|inset|top|right|bottom|left|transform)\s*:/m;
  for (const source of sources) {
    const main = await readFile(new URL(`references/${source}/src/main.jsx`, root), "utf8");
    const overrides = await readFile(new URL(`references/${source}/src/theme-overrides.css`, root), "utf8");
    assert.match(main, /import "\.\/styles\.css";\s*import "\.\/theme-overrides\.css";/, `${source} loads themes last`);
    assert.match(main, /chat:theme/, `${source} accepts visual-only live theme updates`);
    assert.doesNotMatch(overrides, /data-theme=["']source["']/, `${source} leaves source baseline untouched`);
    for (const theme of expectedThemes.slice(1)) {
      assert.match(overrides, new RegExp(`data-theme=["']${theme}["']`), `${source} implements ${theme}`);
    }
    assert.doesNotMatch(overrides, structuralDeclaration, `${source} theme layer does not redraw layout`);
  }
});

test("every unified primary supports readable white control text", async () => {
  for (const source of sources) {
    const overrides = await readFile(new URL(`references/${source}/src/theme-overrides.css`, root), "utf8");
    for (const theme of expectedThemes.slice(1)) {
      const block = new RegExp(`html\\[data-theme=["']${theme}["']\\]\\s*\\{([^}]+)\\}`).exec(overrides)?.[1] || "";
      const primary = /--theme-primary:\s*(#[0-9a-f]{6})/i.exec(block)?.[1];
      assert.ok(primary, `${source}/${theme} declares a primary color`);
      assert.ok(contrast(primary, "#ffffff") >= 4.5, `${source}/${theme} primary ${primary} reaches 4.5:1`);
    }
  }
});

test("stateful Agent Feed and Heptabase accept live host theme updates", async () => {
  for (const source of ["agent-feed", "heptabase"]) {
    const main = await readFile(new URL(`references/${source}/src/main.jsx`, root), "utf8");
    assert.match(main, /addEventListener\("message"/);
    assert.match(main, /chat:route/);
    assert.match(main, /chat:theme/);
    assert.match(main, /dataset\.theme/);
  }
});

test("theme changes use a dedicated message and do not replay a canonical route", () => {
  assert.match(appSource, /type: "chat:theme"/);
  assert.match(appSource, /const themeRef = useRef\(themeId\)/);
  assert.match(appSource, /initialTheme=\{themeId\}/);
  assert.doesNotMatch(appSource, /\[composition, sceneId, themeId\]/);
});
