import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { ensureLongAgentShareProject, openProject } from "../../src/projects/registry.ts";
import { buildChatSkillTree } from "../../src/resources/skills-tree.ts";

// 归一后：每个已登记的 Long Agent 都有自己的 home Project（id 即 longAgentId）。
// 测试在写入 Registry 后补齐 home 项目，等价于生产启动时的归一/创建 provisioning。
async function writeLongAgentRegistryWithHomes(value, chatHome) {
  const { ensureAgentHomeProject } = await import("../../src/projects/registry.ts");
  const { writeLongAgentRegistry } = await import("../../src/long-agents/storage.ts");
  const registry = await writeLongAgentRegistry(value, chatHome);
  for (const agent of registry.agents) {
    await ensureAgentHomeProject(agent.id, agent.name, chatHome);
  }
  return registry;
}


function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-skill-tree-"));
  const chatHome = path.join(base, ".chat");
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return { base, chatHome };
}

function writeSkill(dir, name, description) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "---",
    `Body of ${name}.`,
  ].join("\n"));
}

test("Skill tree lists Personal, Project, Workflow and Long Agent ownership", async (t) => {
  const { base, chatHome } = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  fs.mkdirSync(path.join(base, "workspace"));
  const project = await openProject({
    path: path.join(base, "workspace"),
    chatHome,
    id: "tree-project",
    name: "Tree Project",
  });
  writeSkill(path.join(chatHome, "agent", "skills", "personal-note"), "personal-note", "Personal note skill");
  writeSkill(path.join(project.projectConfigDir, "skills", "project-review"), "project-review", "Project review skill");
  await writeLongAgentRegistryWithHomes({
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "private-agent-group", defaultProjectId: "longagentshare",
      inbox: {
        messagingGroupId: "mg", channelType: "telegram", instance: "telegram",
        platformId: "telegram:user", threadId: null,
      },
    }],
  }, chatHome);

  const tree = await buildChatSkillTree({ projectId: project.projectId, chatHome });

  assert.equal(tree.schemaVersion, 1);
  assert.deepEqual(tree.personal.skills.map((skill) => skill.name), ["personal-note"]);

  const ownProject = tree.projects.find((entry) => entry.projectId === project.projectId);
  assert.ok(ownProject);
  assert.deepEqual(ownProject.skills.map((skill) => skill.name), ["project-review"]);
  const daily = tree.projects.find((entry) => entry.projectId === "longagentshare");
  assert.ok(daily);
  // Project sections must not leak Personal skills.
  assert.equal(tree.projects.every((entry) => entry.skills.every((skill) => skill.name !== "personal-note")), true);

  assert.ok(tree.workflows.length > 0);
  const coordinator = tree.workflows
    .find((workflow) => workflow.workflowId === "planner-orchestrator")
    ?.agents.find((agent) => agent.agentId === "coordinator");
  assert.ok(coordinator);
  assert.deepEqual(coordinator.skills.map((skill) => skill.name), ["workflow-delegation"]);
  // Workflow sections keep only Workflow-injected Skills, not Personal/Project ones.
  for (const workflow of tree.workflows) {
    for (const agent of workflow.agents) {
      assert.equal(agent.skills.every((skill) => skill.name !== "personal-note" && skill.name !== "project-review"), true);
    }
  }

  assert.deepEqual(tree.longAgents.map((agent) => agent.longAgentId), ["nexus"]);
  assert.deepEqual(tree.longAgents[0].skills, []);

  // S4：自有目录的 Skill 出现在该 Agent 的树节点下。
  writeSkill(
    path.join(chatHome, "long-agents", "nexus", "skills", "daily-briefing"),
    "daily-briefing",
    "Nexus-owned daily briefing skill",
  );
  const refreshed = await buildChatSkillTree({ projectId: project.projectId, chatHome });
  assert.deepEqual(refreshed.longAgents[0].skills.map((skill) => skill.name), ["daily-briefing"]);
});
