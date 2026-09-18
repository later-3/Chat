import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const clientBase = process.env.CHAT_TEST_CLI_PACKAGE === undefined
  ? new URL("../cli/dist/", import.meta.url)
  : pathToFileURL(`${resolve(process.env.CHAT_TEST_CLI_PACKAGE, "dist")}/`);
const { ChatApi } = await import(new URL("api.js", clientBase).href);
const { WorkflowTerminal } = await import(new URL("controller.js", clientBase).href);

// Exercise the shipped client against both real server modes; models remain local test fixtures.
export async function exerciseWorkflowTui({ baseUrl, cookie, projectId }) {
  const api = new ChatApi(baseUrl, cookie);
  const notices = [];
  let draft = "";
  const view = { history() {}, status() {}, notice: (s) => notices.push(s), draft: (s) => { draft = s; }, select: async () => undefined, event() {} };
  let client = new WorkflowTerminal(api, view, projectId);
  const wait = async (predicate) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await client.refresh(true);
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail(`TUI runtime timeout: ${JSON.stringify({ notices, active: client.snapshot?.activeRun })}`);
  };
  try {
    await client.initialize("minimal-pi-coding-agent");
    await client.submit("TUI first conversation");
    await wait(() => notices.includes("Workflow已完成"));
    const parentId = client.sessionId;
    const webPath = `/api/sessions/${parentId}?projectId=${projectId}`;
    const web = await api.json(webPath);
    assert.ok(web.context.messages.some((m) => m.role === "user" && JSON.stringify(m).includes("TUI first conversation")));
    assert.ok(web.context.messages.some((m) => m.role === "assistant"));
    assert.ok((await api.json(`/api/sessions?projectId=${projectId}`)).sessions.some((s) => s.id === parentId));

    // A Web-originated turn is discovered from the same durable transcript.
    const webRun = await api.json("/runs", { method: "POST", body: JSON.stringify({ projectId, sessionId: parentId, workflow: "minimal-pi-coding-agent", prompt: "Web second conversation" }) });
    await wait(() => client.snapshot.entries.some((e) => e.message?.role === "user" && JSON.stringify(e.message).includes("Web second conversation")) && !client.snapshot.activeRun);
    assert.equal((await api.json(`/runs/${webRun.runId}`)).status, "completed");

    await client.submit("/workflow planning-execution");
    await client.submit("Add an explicit rollback step before execution.");
    await wait(() => client.snapshot?.activeRun?.phase === "waiting_review");
    const waiting = await api.json(webPath);
    assert.equal(waiting.activeWorkflowRun.runId, client.snapshot.activeRun.runId);
    await assert.rejects(client.submit("overlapping prompt"), /仍在运行/);
    await assert.rejects(client.submit("/fork"), /先完成/);
    client.stop();
    client = new WorkflowTerminal(api, view, projectId, parentId);
    await client.initialize();
    assert.equal(client.snapshot.activeRun.phase, "waiting_review");
    await client.submit("/approve");
    await wait(() => client.snapshot.activeRun === null);
    const beforeFork = JSON.stringify((await api.json(webPath)).context.messages);
    const selected = client.snapshot.entries.findLast((e) => e.message?.role === "user");
    assert.ok(selected);
    await client.submit(`/fork ${selected.id}`);
    assert.notEqual(client.sessionId, parentId);
    assert.ok(draft.length);
    assert.equal(client.snapshot.activeRun, null);
    const child = (await api.json(`/api/sessions?projectId=${projectId}`)).sessions.find((s) => s.id === client.sessionId);
    assert.equal(child.parentSessionId, parentId);
    assert.equal(JSON.stringify((await api.json(webPath)).context.messages), beforeFork);
    await client.submit("/workflow minimal-pi-coding-agent");
    notices.length = 0;
    await client.submit("TUI fork continuation");
    await wait(() => notices.includes("Workflow已完成"));
    assert.ok(JSON.stringify(await api.json(`/api/sessions/${client.sessionId}?projectId=${projectId}`)).includes("TUI fork continuation"));
    assert.equal(JSON.stringify((await api.json(webPath)).context.messages), beforeFork);

    await client.submit("/new");
    await client.submit("/workflow planning-execution");
    await client.submit("Create a plan that will be cancelled during review.");
    await wait(() => client.snapshot?.activeRun?.phase === "waiting_review");
    await client.cancel();
    await wait(() => client.snapshot.activeRun === null);
    assert.ok(notices.includes("Workflow已取消"));
  } finally { client.stop(); }
}
