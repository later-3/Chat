import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { debugEnvironment, debugHome, debugRoot, nanoRoot, ports, prepareDebug } from "./debug-environment.mjs";
import { controlRole } from "./debug-processes.mjs";
const exec = promisify(execFile);

/** Operator-only lab bootstrap. Native CLI owns entities; Gateway owns Memory scaffold. */
export async function ensureDebugLab({ ncl, gateway, registry, save }) {
  const existing = registry?.agents?.find(agent => agent.id === "debug-agent");
  if (registry && (!existing || existing.instanceId !== "debug" || !registry.instances?.some(instance => instance.id === "debug"
    && instance.gatewayBaseUrl === `http://127.0.0.1:${ports.nanoclaw}/webhook/chat-backend`))) {
    throw new Error("Existing debug Registry differs; preserve it and configure the lab explicitly");
  }
  const groups = await ncl("groups", "list");
  let group = groups.find(group => existing ? group.id === existing.nanoclawAgentGroupId : group.folder === "debug-agent");
  if (existing && !group) throw new Error("Existing debug Agent references a missing Nano Group; refusing to replace its identity");
  group ??= await ncl("groups", "create", "--name", "Debug Agent", "--folder", "debug-agent");
  const messagingGroups = await ncl("messaging-groups", "list");
  let inbox = messagingGroups.find(group => group.channel_type === "cli" && group.instance === "cli" && group.platform_id === "local");
  inbox ??= await ncl("messaging-groups", "create", "--channel-type", "cli", "--instance", "cli", "--platform-id", "local",
    "--name", "Local debug terminal", "--is-group", "0", "--unknown-sender-policy", "public");
  const wirings = await ncl("wirings", "list");
  if (!wirings.some(wiring => wiring.messaging_group_id === inbox.id && wiring.agent_group_id === group.id)) {
    await ncl("wirings", "create", "--messaging-group-id", inbox.id, "--agent-group-id", group.id,
      "--engage-mode", "pattern", "--engage-pattern", "^DEBUG_", "--sender-scope", "all");
  }
  // Creates only missing OKF files in Nano; never copy memory or write the database from Chat.
  const profile = await gateway("/agent-groups/get", { schemaVersion: 1, agentGroupId: group.id });
  if (profile.agentGroup?.id !== group.id || !Number.isInteger(profile.agentGroup.workspace?.memoryFileCount) || profile.agentGroup.workspace.memoryFileCount < 3) {
    throw new Error("Nano Group/Memory initialization did not validate");
  }
  if (!registry) await save({ schemaVersion: 1,
    instances: [{ id: "debug", name: "Debug NanoClaw", executionMode: "chat-pi", gatewayBaseUrl: `http://127.0.0.1:${ports.nanoclaw}/webhook/chat-backend` }],
    agents: [{ id: "debug-agent", name: "Debug Agent", description: "Isolated local debugging", enabled: true,
      instanceId: "debug", nanoclawAgentGroupId: group.id, defaultProjectId: "daily",
      inbox: { messagingGroupId: inbox.id, channelType: "cli", instance: "cli", platformId: "local", threadId: null } }],
  });
  console.log(`[debug] lab ready: Group ${group.id}; Workspace and Memory initialized; existing content preserved`);
}
export async function bootstrapDebugLab(signal) {
  await prepareDebug();
  const env = await debugEnvironment("nanoclaw");
  const base = `http://127.0.0.1:${ports.nanoclaw}/webhook/chat-backend/v1`;
  const headers = { Authorization: `Bearer ${env.CHAT_CHANNEL_GATEWAY_TOKEN}`, "Content-Type": "application/json" };
  let ready = false;
  for (let i = 0; i < 100; i++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(1000) });
      if (response.status === 401) throw new Error("Debug Gateway authentication failed");
      const health = await response.json();
      if (response.ok && health.ok && health.instanceId === "debug") { ready = true; break; }
    } catch (error) { if (error.message.includes("authentication")) throw error; }
    await delay(200, undefined, { signal });
  }
  if (!ready) throw new Error("Debug NanoClaw Gateway is not ready; inspect its startup log");
  await controlRole(debugRoot, "lab", async () => {
    const path = join(debugHome, "long-agents.json");
    let registry;
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Debug Registry must not be redirected");
      registry = JSON.parse(await readFile(path, "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    await ensureDebugLab({ registry,
      ncl: async (...args) => {
        const { stdout } = await exec(process.execPath, ["--import", "tsx", "src/cli/client.ts", ...args, "--json"],
          { cwd: nanoRoot, env, timeout: 15000, maxBuffer: 1024 * 1024 });
        const response = JSON.parse(stdout);
        if (!response.ok || !response.data) throw new Error(`Nano CLI ${args[0]} ${args[1]} failed`);
        return response.data;
      },
      gateway: async (route, body) => {
        const response = await fetch(base + route, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error(`Debug Group resource request failed (${response.status})`);
        return response.json();
      },
      save: value => writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 }),
    });
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await bootstrapDebugLab();
