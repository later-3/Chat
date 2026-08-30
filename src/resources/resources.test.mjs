import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listPiExtensions, togglePiExtension } from "./extensions.ts";
import { changePiPlugin, listPiPlugins } from "./plugins.ts";
import { listPiSkills, setSkillModelInvocation } from "./skills.ts";

test("Chat global Skill, Extension and Plugin resources use .chat/agent", { concurrency: false }, async (t) => {
  const previousCwd = process.cwd();
  const previousChatHome = process.env.CHAT_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "chat-pi-resources-"));
  t.after(() => {
    process.chdir(previousCwd);
    if (previousChatHome === undefined) delete process.env.CHAT_HOME;
    else process.env.CHAT_HOME = previousChatHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  process.chdir(base);
  process.env.CHAT_HOME = path.join(base, ".chat");
  const cwd = path.join(base, "workspace");
  const agentDir = path.join(base, ".chat", "agent");
  const skillDir = path.join(agentDir, "skills", "review");
  const extensionPath = path.join(agentDir, "extensions", "guard.ts");
  const pluginDir = path.join(agentDir, "plugins", "test-plugin");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(skillDir, { recursive: true });
  fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, "skills", "plugin-review"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), [
    "---", "name: review", "description: Review code", "---", "Review carefully.",
  ].join("\n"));
  fs.writeFileSync(extensionPath, "export default function register() {}\n");
  fs.writeFileSync(path.join(pluginDir, "skills", "plugin-review", "SKILL.md"), [
    "---", "name: plugin-review", "description: Plugin review", "---", "Review from plugin.",
  ].join("\n"));
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({
    name: "test-plugin",
    version: "1.0.0",
    pi: { skills: ["./skills/plugin-review"] },
  }));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: ["./plugins/test-plugin"],
  }));

  const skills = await listPiSkills(cwd);
  assert.ok(skills.skills.some((skill) => skill.name === "review"));
  await setSkillModelInvocation(cwd, path.join(skillDir, "SKILL.md"), true);
  assert.equal((await listPiSkills(cwd)).skills.find((skill) => skill.name === "review")?.disableModelInvocation, true);

  const canonicalExtensionPath = fs.realpathSync(extensionPath);
  assert.equal((await listPiExtensions(cwd)).extensions.find((extension) => extension.path === canonicalExtensionPath)?.enabled, true);
  await togglePiExtension(cwd, extensionPath, false);
  assert.equal((await listPiExtensions(cwd)).extensions.find((extension) => extension.path === canonicalExtensionPath)?.enabled, false);
  await togglePiExtension(cwd, extensionPath, true);

  const plugins = await listPiPlugins(cwd);
  const plugin = plugins.packages.find((item) => item.source === "./plugins/test-plugin");
  assert.equal(plugin?.status, "loaded");
  assert.equal(plugin?.counts.skills, 1);
  assert.equal((await changePiPlugin({
    cwd,
    action: "disable",
    source: "./plugins/test-plugin",
    scope: "global",
  })).packages[0]?.status, "disabled");
  assert.equal((await changePiPlugin({
    cwd,
    action: "enable",
    source: "./plugins/test-plugin",
    scope: "global",
  })).packages[0]?.status, "loaded");
});
