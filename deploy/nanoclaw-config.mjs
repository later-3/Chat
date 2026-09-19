// Installation and readiness only. NanoClaw remains the owner of its data and runtime.
import { readFile, writeFile, lstat, chmod } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

export function gatewayConfiguration(environment) {
  const token = environment.CHAT_CHANNEL_GATEWAY_TOKEN;
  if (!token || token.length < 32 || token.includes("replace-with") || /[\r\n]/.test(token)) {
    throw new Error("Backend service token is missing or invalid");
  }
  const gateway = new URL(environment.CHAT_NANOCLAW_GATEWAY_URL || "http://127.0.0.1:3000/webhook/chat-backend");
  if (gateway.protocol !== "http:" || gateway.hostname !== "127.0.0.1" || !gateway.port
    || gateway.pathname !== "/webhook/chat-backend" || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error("Managed NanoClaw requires a loopback gateway URL with an explicit port");
  }
  const port = Number(environment.PORT);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === Number(gateway.port) || Number(gateway.port) < 1024) {
    throw new Error("Backend and NanoClaw need different unprivileged ports");
  }
  return { gateway, values: {
    NANOCLAW_EXECUTION_MODE: "chat-pi",
    CHAT_BACKEND_URL: `http://127.0.0.1:${port}`,
    CHAT_INTEGRATION_INSTANCE_ID: "local",
    CHAT_CHANNEL_GATEWAY_TOKEN: token,
    WEBHOOK_PORT: gateway.port,
  } };
}

export async function prepareEnvironment(nanoRoot, environment) {
  const { values } = gatewayConfiguration(environment);
  const path = join(nanoRoot, ".env");
  let text = "";
  let exists = false;
  try {
    if (!(await lstat(path)).isFile()) throw new Error("NanoClaw .env must be a regular file");
    text = await readFile(path, "utf8");
    exists = true;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const existing = parseEnv(text);
  for (const [key, value] of Object.entries(values)) {
    if (existing[key] !== undefined && existing[key] !== value) {
      throw new Error(`NanoClaw ${key} differs from this deployment; reconcile its private configuration before retrying`);
    }
  }
  const missing = Object.entries(values).filter(([key]) => existing[key] === undefined);
  if (missing.length) {
    // Exclusive first creation; existing files are replaced atomically under chatctl's deployment lock.
    // Single-quote serialization preserves spaces and '#' in an existing Backend token.
    if (missing.some(([, value]) => value.includes("'"))) throw new Error("Service configuration cannot contain single quotes");
    const next = `${text}${text.endsWith("\n") || !text ? "" : "\n"}${missing.map(([key, value]) => `${key}='${value}'`).join("\n")}\n`;
    if (!exists) await writeFile(path, next, { flag: "wx", mode: 0o600 });
    else {
      const { rename } = await import("node:fs/promises");
      const temp = `${path}.install-${process.pid}`;
      await writeFile(temp, next, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    }
  }
  await chmod(path, 0o600);
}

export async function checkGateway(environment, { attempts = 30, delayMs = 1000 } = {}) {
  const { gateway, values } = gatewayConfiguration(environment);
  let reason = "not ready";
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(`${gateway}/v1/health`, {
        headers: { authorization: `Bearer ${values.CHAT_CHANNEL_GATEWAY_TOKEN}` },
        signal: AbortSignal.timeout(2000), redirect: "error",
      });
      if (!response.ok) throw new Error(`Gateway HTTP ${response.status}`);
      const result = await response.json();
      if (result?.schemaVersion !== 1 || result.ok !== true || result.instanceId !== values.CHAT_INTEGRATION_INSTANCE_ID) {
        throw new Error("Gateway identity or version does not match");
      }
      return;
    } catch (error) { reason = error instanceof Error ? error.message : "Gateway request failed"; }
    if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error(`NanoClaw readiness failed: ${reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, nanoRoot, envPath] = process.argv.slice(2);
    if (!["prepare", "health"].includes(command) || !isAbsolute(nanoRoot || "") || !isAbsolute(envPath || "")) {
      throw new Error("Usage: nanoclaw-config.mjs prepare|health /absolute/nanoclaw /absolute/chat.env");
    }
    const environment = parseEnv(await readFile(envPath, "utf8"));
    if (command === "prepare") await prepareEnvironment(nanoRoot, environment);
    else await checkGateway(environment);
    console.log(`NanoClaw ${command}: ok`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "NanoClaw configuration failed");
    process.exitCode = 1;
  }
}
