import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { openProject } from "../../src/projects/registry.ts";
import {
  describeChatWorkflowCapabilities,
  resolveWorkflowCallAgentConfigs,
} from "../../src/workflows/workflow-call-capabilities.ts";

function writeFauxConfiguration(agentDir, faux) {
  const model = faux.getModel();
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: model.provider,
    defaultModel: model.id,
    defaultThinkingLevel: "off",
  }));
  fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [model.provider]: {
        baseUrl: model.baseUrl,
        api: model.api,
        apiKey: "faux-key",
        models: [{
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: model.input,
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
        }],
      },
    },
  }));
}

test("a parent Agent discovers names and Backend resolves only its selected child capabilities", { concurrency: false }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-workflow-call-capabilities-"));
  const workspace = path.join(base, "workspace");
  const chatHome = path.join(base, "chat-home");
  const faux = registerFauxProvider({ api: "workflow-call-capability-faux", provider: "workflow-call-capability-faux" });
  t.after(() => {
    faux.unregister();
    fs.rmSync(base, { recursive: true, force: true });
  });
  fs.mkdirSync(workspace, { recursive: true });
  const project = await openProject({
    path: workspace,
    chatHome,
    id: "workflow-call-capabilities",
    name: "Workflow Call Capabilities",
  });
  const reviewSkillDir = path.join(project.projectConfigDir, "skills", "review");
  fs.mkdirSync(reviewSkillDir, { recursive: true });
  fs.writeFileSync(path.join(reviewSkillDir, "SKILL.md"), [
    "---",
    "name: review",
    "description: Review code",
    "---",
    "Review the changed code.",
  ].join("\n"));
  writeFauxConfiguration(path.join(chatHome, "agent"), faux);

  const input = {
    projectId: project.projectId,
    chatHome,
    cwd: workspace,
    targetWorkflowId: "memory",
  };
  const description = await describeChatWorkflowCapabilities(input);
  const child = description.agents[0];
  // 单 Agent 工作流（memory）：父 Agent 看到的就是它的唯一子 Agent。
  assert.equal(child.agentId, "memory-agent");
  assert.ok(child.tools.length > 0, "子 Agent 应暴露可用工具");
  assert.ok(child.skills.some((skill) => skill.name === "review"), "项目 Skill 应对子 Agent 可见");

  const configs = await resolveWorkflowCallAgentConfigs(input, [{
    agentId: "memory-agent",
    tools: ["read", "workflow_call"],
    skills: ["review"],
  }]);
  assert.equal(configs["memory-agent"].tools.mode, "explicit");
  assert.deepEqual(configs["memory-agent"].tools.names, ["read"]);
  assert.deepEqual(configs["memory-agent"].tools.addresses, ["system:tool/workflow_call"]);
  assert.deepEqual(configs["memory-agent"].resources, {
    mode: "explicit",
    skillPaths: [path.join(reviewSkillDir, "SKILL.md")],
    extensionPaths: [],
    pluginSources: [],
  });

  await assert.rejects(
    resolveWorkflowCallAgentConfigs(input, []),
    /必须为每个Child Agent明确选择能力/,
  );
  await assert.rejects(
    resolveWorkflowCallAgentConfigs(input, [{
      agentId: "memory-agent",
      tools: ["not-a-tool"],
      skills: [],
    }]),
    /可委派Tool不存在/,
  );
});
