import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest exposes the native DSH bundle patch and client factory contract", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const dsh = manifest.dsh as {
    bundle?: { patch?: unknown };
    client?: { platform?: unknown; inject?: unknown };
  };
  assert.equal(manifest.name, "@chat/dsh-lifeos-bridge");
  assert.equal(manifest.main, "dist/dsh-bundle.js");
  assert.deepEqual(manifest.files, [
    "dist/dsh-bundle.js",
    "dist/dsh-bundle.js.map",
    "dist/client.js",
    "dist/client.js.map",
    "cordis.patch.yml",
  ]);
  assert.equal(dsh.bundle?.patch, "./cordis.patch.yml");
  assert.equal(dsh.client?.platform, "web");
  assert.deepEqual(dsh.client?.inject, [
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-ui-conversation",
    "@deepseek-ai/dsh-client-ui-layout",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-sidebar",
    "@deepseek-ai/dsh-client-ui-settings",
    "@deepseek-ai/dsh-client-ui-trajectory",
  ]);
  const host = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(host, /ExecutionTraceRecorder|lifeos\/execution-trace/);
  assert.match(client, /"conversationEvents"/);
  assert.match(client, /ExecutionTraceProjection/);
  assert.match(host, /"sessionQuery"/);
  assert.match(client, /ctx\.slots\.inject\("conversation\.view"/);
  assert.match(client, /id: "lifeos-session-records"/);
});

test("unified session records stay an additive DSH view with two independent sources", async () => {
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const view = await readFile(
    new URL("../src/client/SessionRecordsView.tsx", import.meta.url),
    "utf8",
  );
  const history = await readFile(new URL("../src/dsh-session-history.ts", import.meta.url), "utf8");
  assert.match(client, /name: "conversation\.view"/);
  assert.match(view, /Chat 正式消息/);
  assert.match(view, /DSH 原始日志/);
  assert.match(view, /不会把归档伪装成删除/);
  assert.match(history, /SessionQuery/);
  assert.doesNotMatch(`${client}\n${view}`, /conversation\.session["']\s*,/u);
});

test("host and browser bundles emit source maps for stable TypeScript breakpoints", async () => {
  const config = await readFile(new URL("../tsdown.config.ts", import.meta.url), "utf8");
  assert.equal((config.match(/sourcemap:\s*true/g) ?? []).length, 2);
});

test("workflow selector uses the additive DSH composer tool-row slot", async () => {
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const picker = await readFile(
    new URL("../src/client/WorkflowPicker.tsx", import.meta.url),
    "utf8",
  );
  assert.match(client, /ctx\.slots\.inject\("conversation\.input\.left"/);
  assert.match(client, /name: "conversation\.input\.left"/);
  assert.doesNotMatch(picker, /PropsRuntime<"conversation\.input\.dock">/);
  assert.match(picker, /PropsRuntime<"conversation\.input\.left">/);
  assert.match(picker, /@deepseek-ai\/dsh-client-ui-primitives/);
});

test("LifeOS dock exposes a mobile-safe Note review surface and all product decisions", async () => {
  const dock = await readFile(new URL("../src/client/LifeosDock.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/client/styles.ts", import.meta.url), "utf8");
  assert.match(dock, /data-testid="lifeos-note-candidate"/);
  assert.match(dock, /data-testid="lifeos-confirm-note"/);
  assert.match(dock, /data-testid="lifeos-request-note-revision"/);
  assert.match(dock, /data-testid="lifeos-reject-note"/);
  assert.match(styles, /@media\(max-width:600px\)[\s\S]*\.lifeos-note-content/);
});

test("trace display options use public additive DSH contracts without touching trajectory DOM", async () => {
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const toggle = await readFile(
    new URL("../src/client/TraceTimestampToggle.tsx", import.meta.url),
    "utf8",
  );
  const projection = await readFile(
    new URL("../src/client/execution-trace-definition.ts", import.meta.url),
    "utf8",
  );
  assert.match(client, /createSnapshotStore/);
  assert.match(client, /ctx\.slots\.inject\("conversation\.session\.header\.utilities"/);
  assert.match(client, /ExecutionTraceProjection/);
  assert.match(projection, /registerExecutionTraceDefinition/);
  assert.match(toggle, /PropsRuntime<"conversation\.session\.header\.utilities">/);
  assert.match(toggle, /aria-pressed=\{visible\}/);
  assert.match(projection, /target: "trajectory"/);
  assert.match(projection, /subCalls/);
  assert.doesNotMatch(`${client}\n${toggle}\n${projection}`, /data-trajectory|MutationObserver/);
});

test("context manager uses public Session and blank-safe composer contracts without DOM scraping", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { peerDependencies?: Record<string, unknown> };
  const host = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const manager = await readFile(
    new URL("../src/client/ContextInjectionManager.tsx", import.meta.url),
    "utf8",
  );
  assert.equal(manifest.peerDependencies?.["@deepseek-ai/dsh-session"], "^0.1.0-rc.6");
  assert.match(host, /"sessions"/u);
  assert.match(host, /ctx\.sessions\.get\(SessionId\(dshSessionId\)\)/u);
  assert.match(client, /id: "lifeos-context-injections"/u);
  assert.match(manager, /PropsRuntime<"conversation\.input\.left">/u);
  assert.match(manager, /<Modal/u);
  assert.match(manager, /最新用户输入和当前 Workspace 指令/u);
  assert.match(manager, /仅 Workspace 指令进入 Chat 规划上下文/u);
  assert.doesNotMatch(`${client}\n${manager}`, /querySelector|MutationObserver/u);
});

test("prompt composer keeps every Region independent and stages exact revisions before send", async () => {
  const client = await readFile(new URL("../src/client/index.tsx", import.meta.url), "utf8");
  const composer = await readFile(
    new URL("../src/client/PromptComposer.tsx", import.meta.url),
    "utf8",
  );
  const controller = await readFile(
    new URL("../src/client/prompt-composer-controller.ts", import.meta.url),
    "utf8",
  );
  assert.match(client, /id: "lifeos-prompt-composer"/u);
  assert.match(composer, /提示词/u);
  assert.match(composer, /默认/u);
  assert.match(composer, /覆盖/u);
  assert.match(composer, /追加/u);
  assert.match(composer, /当前 Workspace/u);
  assert.match(composer, /前端发送前语义预览/u);
  assert.match(composer, /不是最终 Provider HTTP 请求/u);
  assert.match(controller, /chat\.prompt-composer\.selection\.v1\./u);
  assert.match(controller, /method: "PUT"/u);
  assert.match(controller, /\/lifeos\/prompts\/assembly-previews/u);
  assert.doesNotMatch(`${composer}\n${controller}`, /querySelector|MutationObserver/u);
});

test("bundle patch makes Chat workflow the only enabled product model route", async () => {
  const patch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");
  assert.match(patch, /id: agent-default-model[\s\S]*provider: lifeos[\s\S]*model: workflow/);
  assert.match(patch, /id: llm-deepseek[\s\S]*disabled: true/);
  assert.match(patch, /id: llm-pi-ai[\s\S]*disabled: true/);
  assert.equal((patch.match(/id: lifeos-bridge/g) ?? []).length, 1);
  assert.equal((patch.match(/name:\s*["']?@chat\/dsh-lifeos-bridge["']?/g) ?? []).length, 1);
  assert.doesNotMatch(patch, /process\.env|CHAT_(?:API_BASE_URL|DSH_STATE_PATH|REPO_ROOT)/);
});
