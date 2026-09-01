import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InvalidChatModelsConfigError,
  readChatModelsConfig,
  writeChatModelsConfig,
} from "./models-config.ts";

test("Chat models configuration reads and writes only Chat Home's agent directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-models-config-"));
  const chatHome = path.join(root, "chat-home");
  const piAgentDir = path.join(root, "pi-agent");
  fs.mkdirSync(piAgentDir, { recursive: true });
  fs.writeFileSync(path.join(piAgentDir, "models.json"), "not valid json", "utf8");
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  t.after(() => {
    if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const empty = await readChatModelsConfig(chatHome);
  assert.equal(empty.source.kind, "chat-home");
  assert.equal(empty.source.path, path.join(chatHome, "agent", "models.json"));
  assert.deepEqual(empty.config, { providers: {} });

  const saved = await writeChatModelsConfig({
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "local",
        models: [{ id: "local-model", name: "Local Model" }],
      },
    },
  }, chatHome);
  assert.equal(saved.config.providers.local.models[0].id, "local-model");
  assert.deepEqual((await readChatModelsConfig(chatHome)).config, saved.config);
  assert.equal(fs.readFileSync(path.join(piAgentDir, "models.json"), "utf8"), "not valid json");
  assert.equal(fs.statSync(saved.source.path).mode & 0o777, 0o600);
});

test("invalid Chat models configuration cannot replace the last valid file", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-models-invalid-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const valid = {
    providers: {
      local: {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "local",
        models: [{ id: "valid" }],
      },
    },
  };
  await writeChatModelsConfig(valid, root);

  await assert.rejects(
    writeChatModelsConfig({
      providers: {
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          api: "openai-completions",
          apiKey: "local",
          models: [{ id: "" }],
        },
      },
    }, root),
    InvalidChatModelsConfigError,
  );
  assert.deepEqual((await readChatModelsConfig(root)).config, valid);
});

test("Chat models configuration accepts Pi's comments and trailing commas on read", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-models-jsonc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modelsPath = path.join(root, "agent", "models.json");
  fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
  fs.writeFileSync(modelsPath, `{
    // Chat-owned custom models
    "providers": {
      "local": {
        "baseUrl": "http://127.0.0.1:11434/v1",
        "api": "openai-completions",
        "apiKey": "local",
        "models": [{ "id": "jsonc-model", }],
      },
    },
  }`, "utf8");

  assert.equal((await readChatModelsConfig(root)).config.providers.local.models[0].id, "jsonc-model");
});
