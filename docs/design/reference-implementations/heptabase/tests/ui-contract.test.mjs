import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const modelSource = await readFile(new URL("../src/heptabaseModel.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("enabled controls share the 44px browser hit-area contract", () => {
  assert.match(styles, /\.heptabase-app button:not\(:disabled\)[^{]*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/s);
  assert.match(styles, /\.heptabase-app input:not\(:disabled\)[^{]*[\s\S]*min-height:\s*44px;/);
});

test("placement Cards expose a native keyboard-reachable main action", () => {
  assert.match(appSource, /<button className="placement-card-main"[\s\S]{0,240}aria-label=\{`Open Card \$\{card\.title\}`\}/);
  const placementFunction = appSource.slice(appSource.indexOf("function PlacementCard"), appSource.indexOf("function Canvas"));
  const articleOpening = placementFunction.match(/<article[\s\S]*?>/)?.[0] || "";
  assert.doesNotMatch(articleOpening, /onClick=/);
});

test("mobile panel tabs retain explicit accessible names", () => {
  assert.match(appSource, /role="tab" aria-label=\{label\} aria-selected=/);
});

test("Share dialog traps focus, closes with Escape, and restores focus", () => {
  assert.match(appSource, /element\.inert = true/);
  assert.match(appSource, /event\.key === "Escape"/);
  assert.match(appSource, /event\.key !== "Tab"/);
  assert.match(appSource, /isVisibleFocusTarget\(previousFocus\)/);
  assert.match(appSource, /button\[aria-label='Open navigation'\]/);
});

test("Whiteboard permissions are board-scoped and UI copy derives from current access", () => {
  assert.match(modelSource, /permissionsByBoardId/);
  assert.match(appSource, /boardPermissions\[person\.id\]/);
  assert.match(appSource, /permissionLabels\[permission\]/);
  assert.doesNotMatch(appSource, /<small>\{person\.role\}<\/small>/);
});

test("prototype visual language contains no gradients or inline SVG assets", () => {
  assert.doesNotMatch(styles, /(?:linear|radial|conic)-gradient\s*\(/i);
  assert.doesNotMatch(appSource, /<svg\b/i);
});
