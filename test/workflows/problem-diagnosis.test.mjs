import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ensureAgentHomeProject } from "../../src/projects/registry.ts";
import { problemDiagnosisWorkflowDefinition } from "../../src/workflows/problem-diagnosis/index.ts";
import { runProblemDiagnosisStep } from "../../src/workflows/problem-diagnosis/step.ts";

function writeFauxConfiguration(agentDir, faux) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider, defaultModel: model.id, defaultThinkingLevel: "off", compaction: { enabled: false },
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: { [model.provider]: { baseUrl: model.baseUrl, api: model.api, apiKey: "faux-key",
      models: [{ id: model.id, name: model.name, reasoning: model.reasoning, input: model.input, cost: model.cost,
        contextWindow: model.contextWindow, maxTokens: model.maxTokens }] } },
  }));
}

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

async function fixture(t) {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-problem-diagnosis-"));
  const faux = registerFauxProvider({ api: "chat-problem-diagnosis-faux", provider: "chat-problem-diagnosis-faux" });
  t.after(() => {
    faux.unregister();
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  process.env.CHAT_HOME = path.join(base, ".chat");
  writeFauxConfiguration(path.join(base, ".chat", "agent"), faux);
  const project = await ensureAgentHomeProject("friend", "Friend", process.env.CHAT_HOME);
  return { base, faux, workspace: project.cwd, project };
}

test("problem-diagnosis workflow: one structured diagnosis turn through the shared assembly", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t);
  const inputs = [];
  faux.setResponses([
    (context) => {
      inputs.push(context.messages.map((message) => `${message.role}:${textOf(message)}`).join("\n---\n"));
      return fauxAssistantMessage([
        "现场事实：订单页偶发空指针；日志 userId 为 null；订单主键 orderId。",
        "假设 A：登录上下文 userId 未注入（最小验证：清除 session 后访问页面，观察是否必现）。",
        "假设 B：订单按 orderId 取数返回空未判空（最小验证：保持登录态指向不存在订单）。",
        "结论边界：两条假设互斥，未拿到 NPE 堆栈首帧前不下结论。",
      ].join("\n"));
    },
    // The workflow's LAST node is the session-memory writer.
    fauxAssistantMessage("本轮无需写入"),
  ]);
  const result = await problemDiagnosisWorkflowDefinition.run({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "定位：订单页偶发空指针，日志 userId 为 null，订单主键 orderId。", workflowInvocationId: "pd-invocation-1",
  });
  assert.equal(typeof result.text, "string");
  assert.match(result.text, /假设 A/);
  assert.match(result.text, /结论边界/);
  assert.notEqual(result.sessionId, undefined);
  assert.equal(inputs.length, 1, "the diagnoser ran exactly one turn");
  assert.equal(inputs[0].includes("userId 为 null"), true, "the problem statement reached the diagnoser");
});

test("problem-diagnosis workflow: the step fails visibly when the Agent returns no text", { concurrency: false }, async (t) => {
  const { faux, workspace, project } = await fixture(t);
  faux.setResponses([fauxAssistantMessage("")]);
  await assert.rejects(runProblemDiagnosisStep({
    projectId: project.projectId, chatHome: process.env.CHAT_HOME, cwd: workspace,
    sessionId: undefined, prompt: "定位空指针", workflowInvocationId: "pd-invocation-2",
  }), /没有返回Assistant文本/);
});
