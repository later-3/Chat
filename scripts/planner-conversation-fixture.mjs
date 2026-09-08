import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const requests = [];

/** Deterministic malformed output; exercised through both real server builds. */
export function respondPlannerConversation(request, response) {
  const text = JSON.stringify(request.messages);
  if (!text.includes("PLANNER_CONVERSATION_")) return false;
  requests.push(request);
  const system = request.messages.filter((message) => message.role === "system").map((message) => JSON.stringify(message.content)).join("\n");
  const planner = system.includes("你是Planning Execution Workflow中的Planner Agent");
  const latest = JSON.stringify(request.messages.at(-1)?.content);
  const repair = latest.includes("这是唯一一次格式修正机会");
  const user = request.messages.findLast((message) => message.role === "user"
    && JSON.stringify(message.content).includes("PLANNER_CONVERSATION_"));
  const marker = JSON.stringify(user?.content).match(/PLANNER_CONVERSATION_(?:NORMAL|REPAIR|FAIL|AFTER)/)?.[0];
  let answer = `Conversation execution completed: ${marker}`;
  if (planner) {
    assert.match(text, /你现在进入新一轮的Planner阶段|你正在修订第/);
    assert.doesNotMatch(text, /<workflow_execution_task_brief>|<workflow_delegation_task_brief>/);
    if (repair) assert.equal(request.tools?.length ?? 0, 0);
    answer = marker === "PLANNER_CONVERSATION_FAIL" || (marker === "PLANNER_CONVERSATION_REPAIR" && !repair)
      ? "# Draft without required metadata"
      : '<!-- chat-planner-output {"schemaVersion":1,"readiness":"ready_for_review","blockingQuestions":[]} -->\n# Reviewed plan\nRespond with the deterministic summary only.';
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: answer }, null], [{}, "stop"]]) {
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-planner-conversation", object: "chat.completion.chunk", created: 0, model: request.model,
      choices: [{ index: 0, delta, finish_reason }],
      ...(finish_reason ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
  return true;
}

export async function exercisePlannerConversation(fetch, { projectId, workspace, chatHome }) {
  for (const workflow of ["planning-execution", "planner-orchestrator"]) {
    let sessionId;
    let priorLines = [];
    let priorMessages = [];
    const runs = [];
    for (const mode of ["NORMAL", "REPAIR", "FAIL", "AFTER"]) {
      const prompt = `PLANNER_CONVERSATION_${mode}: revise the earlier task, preserving all history.`;
      const requestOffset = requests.length;
      const startedResponse = await fetch("/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, cwd: fs.realpathSync(workspace), workflow, prompt, ...(sessionId ? { sessionId } : {}) }),
      });
      const started = await startedResponse.json();
      assert.equal(startedResponse.status, 202, JSON.stringify(started));
      if (sessionId) assert.equal(started.sessionId, sessionId);
      sessionId = started.sessionId;
      assert.equal(runs.includes(started.workflowInvocationId), false);
      runs.push(started.workflowInvocationId);
      const statusPath = `/runs/${started.runId}?${new URLSearchParams({ projectId, workflowInvocationId: started.workflowInvocationId })}`;
      const wait = async (predicate) => {
        const deadline = Date.now() + 15_000;
        let status;
        do {
          const response = await fetch(statusPath);
          status = await response.json();
          assert.equal(response.status, 200, JSON.stringify(status));
          if (predicate(status)) return status;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        assert.fail(JSON.stringify(status));
      };
      const status = await wait((value) => value.phase === "waiting_review" || value.status === "failed");
      const planningRequests = requests.slice(requestOffset);
      assert.equal(planningRequests.length, ["REPAIR", "FAIL"].includes(mode) ? 2 : 1);
      for (const message of priorMessages.filter((message) => ["user", "assistant"].includes(message.role))) {
        // Original authored content remains available to the next model turn.
        for (const block of message.content ?? []) {
          if (block.type === "text") assert.ok(JSON.stringify(planningRequests[0].messages).includes(JSON.stringify(block.text).slice(1, -1)));
        }
      }
      if (mode === "FAIL") {
        assert.equal(status.status, "failed");
        assert.equal(status.review, undefined);
      } else {
        assert.equal(status.phase, "waiting_review", JSON.stringify(status));
        assert.equal(status.review.planRevision, 1);
        const approval = await fetch(`/runs/${started.runId}/review`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, decision: {
            kind: "approve", reviewId: status.review.reviewId,
            workflowInvocationId: started.workflowInvocationId,
            planRevision: status.review.planRevision, planSha256: status.review.planSha256,
          } }),
        });
        assert.equal(approval.status, 202, await approval.text());
        const completed = await wait((value) => ["completed", "failed"].includes(value.status));
        assert.equal(completed.status, "completed", JSON.stringify(completed));
      }
      const sessionResponse = await fetch(`/api/sessions/${sessionId}?projectId=${projectId}`);
      const detail = await sessionResponse.json();
      assert.equal(sessionResponse.status, 200, JSON.stringify(detail));
      assert.deepEqual(detail.context.messages.slice(0, priorMessages.length), priorMessages);
      assert.equal(detail.context.messages.filter((message) => message.role === "user"
        && JSON.stringify(message.content).includes(prompt)).length, 1);
      priorMessages = detail.context.messages;
      const directory = path.join(chatHome, "projects", projectId, "sessions");
      const file = fs.readdirSync(directory).find((name) => name.endsWith(`_${sessionId}.jsonl`));
      const lines = fs.readFileSync(path.join(directory, file), "utf8").trimEnd().split("\n");
      assert.deepEqual(lines.slice(0, priorLines.length), priorLines, "Pi history must stay append-only");
      const entries = lines.map((line) => JSON.parse(line));
      const repairs = entries.filter((entry) => entry.type === "custom_message"
        && entry.customType === "chat.planner_output_repair" && entry.details?.invocationId === started.workflowInvocationId);
      assert.equal(repairs.length, ["REPAIR", "FAIL"].includes(mode) ? 1 : 0);
      if (mode === "FAIL") assert.match(JSON.stringify(detail.context.messages), /格式修正后仍不符合协议/);
      priorLines = lines;
    }
    // Switching workflows is ordinary continued conversation, not a Session reset.
    for (const nextWorkflow of ["minimal-pi-coding-agent", "memory", "rule-management"]) {
      const offset = requests.length;
      const startResponse = await fetch("/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, cwd: fs.realpathSync(workspace), sessionId,
          workflow: nextWorkflow, prompt: `PLANNER_CONVERSATION_AFTER: continue with ${nextWorkflow}.` }),
      });
      const started = await startResponse.json();
      assert.equal(startResponse.status, 202, JSON.stringify(started));
      assert.equal(started.sessionId, sessionId);
      let completed;
      const deadline = Date.now() + 15_000;
      do {
        completed = await (await fetch(`/runs/${started.runId}`)).json();
        if (["completed", "failed"].includes(completed.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      assert.equal(completed?.status, "completed", JSON.stringify(completed));
      const modelContext = JSON.stringify(requests[offset].messages);
      assert.match(modelContext, new RegExp(`当前Workflow=${nextWorkflow}`));
      assert.doesNotMatch(modelContext, /<workflow_execution_task_brief>|<workflow_delegation_task_brief>|这是唯一一次格式修正机会/);
      const detail = await (await fetch(`/api/sessions/${sessionId}?projectId=${projectId}`)).json();
      assert.deepEqual(detail.context.messages.slice(0, priorMessages.length), priorMessages);
      priorMessages = detail.context.messages;
      const directory = path.join(chatHome, "projects", projectId, "sessions");
      const file = fs.readdirSync(directory).find((name) => name.endsWith(`_${sessionId}.jsonl`));
      const lines = fs.readFileSync(path.join(directory, file), "utf8").trimEnd().split("\n");
      assert.deepEqual(lines.slice(0, priorLines.length), priorLines);
      priorLines = lines;
    }
  }
}
