import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Local fake model exercises the actual Pi tools, including reading the installed Skill. */
export function respondProjectManagement(request, response, chatHome, model) {
  if (!JSON.stringify(request.messages).includes("PROJECT_TOOL_E2E")) return false;
  const results = request.messages.filter((m) => m.role === "tool");
  const parsed = (index) => JSON.parse(typeof results[index].content === "string" ? results[index].content : results[index].content.map((c) => c.text ?? "").join(""));
  const step = results.length;
  let call;
  if (step === 0) {
    assert.match(JSON.stringify(request.messages.filter((m) => m.role === "system")), /project-management/);
    const names = request.tools.map((tool) => tool.function.name);
    for (const name of ["project_create", "project_read", "project_configure", "project_search", "project_update", "project_open"]) assert.ok(names.includes(name));
    call = { name: "read", arguments: { path: path.join(chatHome, "agent/skills/project-management/SKILL.md") } };
  } else if (step === 1) call = { name: "project_create", arguments: { name: "学习道德经 E2E", description: "逐章学习", requestId: "project-tool-e2e" } };
  else {
    const created = parsed(1);
    assert.equal(created.status, "created", JSON.stringify(created));
    const projectId = created.project.projectId;
    if (step === 2) call = { name: "project_read", arguments: { projectId, view: "configuration" } };
    else if (step === 3) call = { name: "project_configure", arguments: { projectId, target: { kind: "project" }, expectedRevision: parsed(2).configuration.revision, operations: [{ op: "set", path: ["defaultWorkflowId"], value: "memory" }] } };
    else if (step === 4) {
      assert.equal(parsed(3).status, "updated");
      call = { name: "project_search", arguments: { query: "道德经 E2E" } };
    } else if (step === 5) {
      assert.equal(parsed(4).items[0].projectId, projectId);
      call = { name: "project_read", arguments: { projectId } };
    } else if (step === 6) call = { name: "project_update", arguments: { projectId, expectedRevision: parsed(5).revision, changes: { description: "记录原文、解释与问题" } } };
    else if (step === 7) {
      assert.equal(parsed(6).status, "updated");
      call = { name: "project_open", arguments: { path: new URL(created.navigation.url, "http://chat.local").searchParams.get("cwd"), requestId: "reopen-e2e" } };
    } else if (step === 8) {
      assert.equal(parsed(7).status, "existing");
      call = { name: "project_read", arguments: { projectId: "nonexistent-e2e-project" } };
    } else assert.equal(parsed(8).code, "PROJECT_NOT_FOUND");
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason) => ({ id: `project-e2e-${step}`, object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason }] });
  const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `project-e2e-call-${step}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "PROJECT_TOOL_E2E_OK" };
  response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  response.write(`data: ${JSON.stringify({ ...chunk({}, call ? "tool_calls" : "stop"), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  response.end("data: [DONE]\n\n");
  return true;
}

export async function exerciseProjectManagementRun(fetchApi, { chatHome, projectId, workspace }) {
  const start = await fetchApi("/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    projectId, cwd: workspace, workflow: "minimal-pi-coding-agent", prompt: "PROJECT_TOOL_E2E: 创建学习道德经项目并设置默认Workflow、简介，然后打开。",
    agentConfigs: { "pi-coding-agent": { tools: { mode: "explicit", names: ["read"], exclude: [], addresses: ["search", "read", "create", "open", "update", "configure"].map((op) => `system:tool/project_${op}`) }, resources: { mode: "inherit" } } },
  }) });
  const started = await start.json();
  assert.equal(start.status, 202, JSON.stringify(started));
  let status;
  const deadline = Date.now() + 20_000;
  do {
    status = await (await fetchApi(`/runs/${encodeURIComponent(started.runId)}`)).json();
    if (["completed", "failed", "cancelled"].includes(status.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(status.status, "completed", JSON.stringify(status));
  assert.equal(status.result.text, "PROJECT_TOOL_E2E_OK");
  const projects = await (await fetchApi("/api/projects")).json();
  const list = Array.isArray(projects) ? projects : projects.projects;
  const created = list.find((p) => p.cachedName === "学习道德经 E2E" || p.name === "学习道德经 E2E");
  assert.ok(created, JSON.stringify(projects));
  assert.notEqual(created.projectId, projectId);
  const config = JSON.parse(fs.readFileSync(path.join(chatHome, "workspaces", created.projectId, ".chat/config.json")));
  assert.equal(config.defaultWorkflowId, "memory");
  const detail = await (await fetchApi(`/api/sessions/${started.sessionId}?projectId=${projectId}`)).json();
  const toolResults = detail.context.messages.filter((m) => m.role === "toolResult" && m.toolName.startsWith("project_"));
  assert.equal(toolResults.length, 8);
  assert.ok(toolResults.slice(0, -1).every((m) => !m.isError), JSON.stringify(toolResults));
  assert.equal(toolResults.at(-1).isError, true);
  return started;
}
