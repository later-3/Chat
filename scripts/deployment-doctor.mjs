#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function parseArguments(argv) {
  let root = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root requires an absolute path");
      root = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: deployment-doctor.mjs [--root /opt/chat]\n");
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!isAbsolute(root)) throw new Error("--root must be an absolute path");
  return { root: resolve(root) };
}

async function requireReadableJson(path, label) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  try {
    JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function requireWritableDirectory(path, label) {
  try {
    await access(path, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
  } catch (error) {
    throw new Error(`${label} is not readable and writable by the Chat service user: ${path}`, { cause: error });
  }
}

async function main() {
  const { root } = parseArguments(process.argv.slice(2));
  const chatHome = process.env.CHAT_HOME?.trim();
  const workflowDataDir = process.env.WORKFLOW_LOCAL_DATA_DIR?.trim();
  if (!chatHome || !isAbsolute(chatHome)) throw new Error("CHAT_HOME must be an absolute path");
  if (!workflowDataDir || !isAbsolute(workflowDataDir)) {
    throw new Error("WORKFLOW_LOCAL_DATA_DIR must be an absolute path");
  }

  const agentDir = join(chatHome, "agent");
  await Promise.all([
    requireWritableDirectory(chatHome, "CHAT_HOME"),
    requireWritableDirectory(agentDir, "Pi agent directory"),
    requireWritableDirectory(workflowDataDir, "Workflow data directory"),
    requireReadableJson(join(agentDir, "settings.json"), "Pi settings"),
  ]);

  const settingsManager = SettingsManager.create(root, agentDir);
  const settingsErrors = settingsManager.drainErrors();
  if (settingsErrors.length > 0) {
    throw new Error(settingsErrors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
  }
  const provider = settingsManager.getDefaultProvider()?.trim();
  const modelId = settingsManager.getDefaultModel()?.trim();
  if (!provider || !modelId || provider === "replace-me" || modelId === "replace-me") {
    throw new Error(`Pi settings must select defaultProvider and defaultModel: ${join(agentDir, "settings.json")}`);
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: true,
  });
  const modelError = modelRuntime.getError();
  if (modelError !== undefined) throw new Error(`Pi model configuration is invalid: ${modelError}`);
  const model = modelRuntime.getModel(provider, modelId);
  if (model === undefined) throw new Error(`Default model does not exist: ${provider}/${modelId}`);
  if (!modelRuntime.hasConfiguredAuth(provider)) {
    throw new Error(`Default provider has no configured credential: ${provider}`);
  }

  let session;
  try {
    const created = await createAgentSession({
      cwd: root,
      agentDir,
      modelRuntime,
      model,
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      noTools: "all",
    });
    session = created.session;
    const errors = created.diagnostics?.filter((diagnostic) => diagnostic.type === "error") ?? [];
    if (errors.length > 0) {
      throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
    }
  } finally {
    session?.dispose();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    node: process.version,
    chatHome,
    workflowDataDir,
    model: `${provider}/${modelId}`,
    authConfigured: true,
    agentSessionAssembly: "ok",
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`deployment doctor failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
