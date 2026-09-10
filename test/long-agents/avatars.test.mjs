import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureLongAgentShareProject } from "../../src/projects/registry.ts";
import {
  clearLongAgentAvatarImage,
  LongAgentAvatarError,
  MAX_AVATAR_BYTES,
  readLongAgentAvatarImage,
  saveLongAgentAvatarImage,
} from "../../src/long-agents/avatars.ts";
import {
  readLongAgentConfiguration,
  updateLongAgentConfiguration,
} from "../../src/long-agents/configuration.ts";
import { listLongAgents } from "../../src/long-agents/bridge.ts";
import { readLongAgentRegistry, writeLongAgentRegistry } from "../../src/long-agents/storage.ts";
import { parseLongAgentRegistry } from "../../src/long-agents/types.ts";

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


const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-long-agent-avatar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "home");
}

function registryFixture() {
  return {
    schemaVersion: 1,
    instances: [{
      id: "local", name: "Local NanoClaw", executionMode: "chat-pi",
      gatewayBaseUrl: "http://127.0.0.1:3000/webhook/chat-backend",
    }],
    agents: [{
      id: "nexus", name: "Nexus", description: "Daily coworker", enabled: true,
      instanceId: "local", nanoclawAgentGroupId: "nano-agent-1", defaultProjectId: "longagentshare",
      inbox: {
        messagingGroupId: "mg-1", channelType: "telegram", instance: "telegram",
        platformId: "telegram:user-1", threadId: null,
      },
    }],
  };
}

test("registry parsing defaults the avatar to auto and validates configured avatars", () => {
  const parsed = parseLongAgentRegistry(registryFixture());
  assert.deepEqual(parsed.agents[0].avatar, { kind: "auto" });

  const withEmoji = registryFixture();
  withEmoji.agents[0].avatar = { kind: "emoji", emoji: "🦉" };
  assert.deepEqual(parseLongAgentRegistry(withEmoji).agents[0].avatar, { kind: "emoji", emoji: "🦉" });

  const withImage = registryFixture();
  withImage.agents[0].avatar = { kind: "image", file: "avatar.png", revision: 2 };
  assert.deepEqual(parseLongAgentRegistry(withImage).agents[0].avatar, {
    kind: "image", file: "avatar.png", revision: 2,
  });

  for (const avatar of [
    { kind: "emoji", emoji: "" },
    { kind: "emoji", emoji: "x".repeat(17) },
    { kind: "image", file: "../escape.png", revision: 1 },
    { kind: "image", file: "avatar.gif", revision: 1 },
    { kind: "image", file: "avatar.png", revision: 0 },
    { kind: "blob" },
    "🦉",
  ]) {
    const invalid = registryFixture();
    invalid.agents[0].avatar = avatar;
    assert.throws(() => parseLongAgentRegistry(invalid), /avatar/);
  }
});

test("image avatar upload sniffs bytes, bumps revisions, and keeps one asset file", async (t) => {
  const chatHome = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes(registryFixture(), chatHome);

  const readRevision = async () => (await readLongAgentConfiguration("nexus", chatHome)).revision;

  await assert.rejects(
    saveLongAgentAvatarImage("nexus", new TextEncoder().encode("not an image"), await readRevision(), chatHome),
    (error) => error instanceof LongAgentAvatarError && error.statusCode === 415,
  );
  await assert.rejects(
    saveLongAgentAvatarImage("nexus", new Uint8Array(MAX_AVATAR_BYTES + 1), await readRevision(), chatHome),
    (error) => error instanceof LongAgentAvatarError && error.statusCode === 413,
  );
  await assert.rejects(
    saveLongAgentAvatarImage("nexus", PNG_BYTES, "0".repeat(64), chatHome),
    (error) => error instanceof LongAgentAvatarError && error.statusCode === 409,
  );

  const first = await saveLongAgentAvatarImage("nexus", PNG_BYTES, await readRevision(), chatHome);
  assert.deepEqual(first.avatar, { kind: "image", file: "avatar.png", revision: 1 });
  const image = await readLongAgentAvatarImage("nexus", chatHome);
  assert.equal(image.mime, "image/png");
  assert.deepEqual([...image.bytes], [...PNG_BYTES]);

  const second = await saveLongAgentAvatarImage("nexus", JPEG_BYTES, await readRevision(), chatHome);
  assert.deepEqual(second.avatar, { kind: "image", file: "avatar.jpg", revision: 2 });
  const dir = path.join(chatHome, "long-agents-assets", "nexus");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["avatar.jpg"]);
  assert.equal((await readLongAgentAvatarImage("nexus", chatHome)).mime, "image/jpeg");

  const config = await readLongAgentConfiguration("nexus", chatHome);
  assert.deepEqual(config.agent.avatar, { kind: "image", revision: 2 });
  assert.equal(JSON.stringify(config).includes("avatar.jpg"), false, "browser projection hides asset file names");

  await clearLongAgentAvatarImage("nexus", config.revision, chatHome);
  assert.equal(fs.existsSync(dir), true);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(await readLongAgentAvatarImage("nexus", chatHome), null);
  assert.deepEqual((await readLongAgentConfiguration("nexus", chatHome)).agent.avatar, { kind: "auto" });
});

test("configuration updates switch the display avatar and clean up image assets", async (t) => {
  const chatHome = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  await writeLongAgentRegistryWithHomes(registryFixture(), chatHome);

  const base = await readLongAgentConfiguration("nexus", chatHome);
  const update = (document, avatar) => {
    const definition = document.agent.definition;
    return {
      schemaVersion: 1,
      expectedRevision: document.revision,
      name: document.agent.name,
      description: document.agent.description,
      ...(avatar === undefined ? {} : { avatar }),
      enabled: document.agent.enabled,
      defaultProjectId: document.agent.defaultProjectId,
      definition: {
        schemaVersion: 1,
        id: definition.id,
        name: document.agent.name,
        description: document.agent.description,
        ...(definition.model == null ? {} : { model: definition.model }),
        ...(definition.thinkingLevel == null ? {} : { thinkingLevel: definition.thinkingLevel }),
        systemPrompt: definition.systemPrompt,
        customInstructions: definition.customInstructions,
        tools: definition.tools,
        resources: definition.resources,
      },
    };
  };

  const emojiDoc = await updateLongAgentConfiguration("nexus", update(base, { kind: "emoji", emoji: "🦉" }), chatHome);
  assert.deepEqual(emojiDoc.agent.avatar, { kind: "emoji", emoji: "🦉" });

  const withImage = await saveLongAgentAvatarImage("nexus", PNG_BYTES, emojiDoc.revision, chatHome);
  assert.equal(withImage.avatar.kind, "image");
  const imageDoc = await readLongAgentConfiguration("nexus", chatHome);
  const dir = path.join(chatHome, "long-agents-assets", "nexus");
  assert.deepEqual(fs.readdirSync(dir), ["avatar.png"]);

  // A regular form save that echoes the image avatar keeps the asset untouched.
  const echoDoc = await updateLongAgentConfiguration("nexus", update(imageDoc, { kind: "image" }), chatHome);
  assert.deepEqual(echoDoc.agent.avatar, { kind: "image", revision: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["avatar.png"]);

  // Switching to auto removes the managed asset.
  const autoDoc = await updateLongAgentConfiguration("nexus", update(echoDoc, { kind: "auto" }), chatHome);
  assert.deepEqual(autoDoc.agent.avatar, { kind: "auto" });
  assert.deepEqual(fs.readdirSync(dir), []);

  // Emoji is validated through the same configuration contract.
  await assert.rejects(
    updateLongAgentConfiguration("nexus", update(autoDoc, { kind: "emoji", emoji: "x".repeat(17) }), chatHome),
    /avatar.emoji最多16个字符/,
  );
  await assert.rejects(
    updateLongAgentConfiguration("nexus", update(autoDoc, { kind: "blob" }), chatHome),
    /avatar/,
  );
});

test("effective model resolves from the definition or from Chat defaults", async (t) => {
  const chatHome = fixture(t);
  await ensureLongAgentShareProject(chatHome);

  // Agent without an explicit model resolves the Chat default (agent/settings.json).
  await writeLongAgentRegistryWithHomes(registryFixture(), chatHome);
  fs.mkdirSync(path.join(chatHome, "agent"), { recursive: true });
  fs.writeFileSync(path.join(chatHome, "agent", "settings.json"), JSON.stringify({
    defaultProvider: "kimi6603",
    defaultModel: "kimi-for-coding",
    defaultThinkingLevel: "high",
  }));
  const following = await readLongAgentConfiguration("nexus", chatHome);
  assert.deepEqual(following.agent.effective, {
    model: { provider: "kimi6603", modelId: "kimi-for-coding" },
    thinkingLevel: "high",
    modelSource: "chat-default",
    thinkingSource: "chat-default",
  });

  // An explicit model in the definition wins and is marked as such (read path,
  // which does not re-check provider auth: that is a save-time validation).
  const withModel = registryFixture();
  withModel.agents[0].definition = {
    schemaVersion: 1,
    id: "nexus",
    name: "Nexus",
    description: "Daily coworker",
    model: { provider: "kimi6603", modelId: "kimi-for-coding" },
    thinkingLevel: "low",
    systemPrompt: { mode: "pi-default" },
    customInstructions: [],
    tools: { mode: "pi-default" },
    resources: { mode: "inherit" },
  };
  await writeLongAgentRegistryWithHomes(withModel, chatHome);
  const explicit = await readLongAgentConfiguration("nexus", chatHome);
  assert.deepEqual(explicit.agent.effective, {
    model: { provider: "kimi6603", modelId: "kimi-for-coding" },
    thinkingLevel: "low",
    modelSource: "explicit",
    thinkingSource: "explicit",
  });
});

test("summary projection carries the public avatar", async (t) => {
  const chatHome = fixture(t);
  await ensureLongAgentShareProject(chatHome);
  const registry = registryFixture();
  registry.agents[0].avatar = { kind: "emoji", emoji: "🦉" };
  await writeLongAgentRegistryWithHomes(registry, chatHome);
  const listed = await listLongAgents({ projectId: "longagentshare", chatHome });
  assert.deepEqual(listed.agents[0].avatar, { kind: "emoji", emoji: "🦉" });
});
