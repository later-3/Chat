import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("macOS production and relay templates point at the built Chat service", () => {
  const production = read("deploy/macos/com.later.chat.production.plist.in");
  const directTunnel = read("deploy/macos/com.later.chat.cloudflare-direct.plist.in");
  const relay = read("deploy/macos/com.later.chat.cloud-relay.plist.in");
  const relayScript = read("scripts/service/run-chat-cloud-relay.sh");

  assert.match(production, /\.output\/server\/index\.mjs/);
  assert.match(production, /--env-file=__ENV_FILE__/);
  assert.match(production, /__HOME__\/\.chat\/runtime\/workflow-data/);
  assert.doesNotMatch(production, /scripts\/dev\/start\.mjs/);

  assert.match(directTunnel, /com\.later\.chat\.cloudflare-direct/);
  assert.match(directTunnel, /__CLOUDFLARED__/);
  assert.match(directTunnel, /__CONFIG__/);
  assert.doesNotMatch(directTunnel, /pi-web|30141/);

  assert.match(relay, /__CHAT_CLOUD_TARGET__/);
  assert.match(relayScript, /cloud_target="\$\{CHAT_CLOUD_TARGET:-\}"/);
  assert.match(relay, /<string>33051<\/string>/);
  assert.match(relay, /<string>43110<\/string>/);
  assert.match(relayScript, /127\.0\.0\.1:\$\{local_port\}\/api\/health/);
  assert.match(relayScript, /127\.0\.0\.1:\$\{remote_port\}:127\.0\.0\.1:\$\{local_port\}/);
});

test("server and Cloudflare examples expose only the intended Chat origin", () => {
  const systemd = read("deploy/systemd/chat.service");
  const macCloudflared = read("deploy/cloudflared/config.example.yml");
  const cloudCloudflared = read("deploy/cloudflared/cloud-relay.example.yml");
  const nginx = read("deploy/nginx/chat.conf");
  const environment = read("deploy/chat.env.example");
  const deployment = read("docs/deployment.md");
  const chatctl = read("deploy/chatctl");
  const deviceDirectoryExample = JSON.parse(read("deploy/devices.json.example"));
  const packageJson = JSON.parse(read("package.json"));

  assert.match(systemd, /__RUNTIME_ROOT__\/current\/server\/index\.mjs/);
  assert.doesNotMatch(systemd, /\/opt\/chat\/\.output\/server\/index\.mjs/);
  assert.match(macCloudflared, /hostname: chat\.example\.com/);
  assert.match(macCloudflared, /service: http:\/\/127\.0\.0\.1:43110/);
  assert.match(cloudCloudflared, /service: http:\/\/127\.0\.0\.1:33052/);
  assert.match(nginx, /listen 127\.0\.0\.1:33052/);
  assert.match(nginx, /server 127\.0\.0\.1:33051/);
  assert.match(environment, /CHAT_WEB_AUTH_USERNAME=chat/);
  assert.match(environment, /CHAT_PUBLIC_URL=https:\/\/chat\.example\.com/);
  assert.doesNotMatch(environment, /^CHAT_WEB_AUTH_PASSWORD=123456$/m);
  assert.match(environment, /^CHAT_WEB_AUTH_PASSWORD=__REQUIRED_STRONG_PASSWORD__$/m);
  assert.match(environment, /CHAT_HOME=\/home\/chat\/\.chat/);
  assert.match(environment, /WORKFLOW_LOCAL_DATA_DIR=\/home\/chat\/\.chat\/runtime\/workflow-data/);
  assert.doesNotMatch(deployment, /codex\/pi-web-frontend-in-chat/);
  assert.match(deployment, /不能从其他机器复制/);
  assert.match(deployment, /\.chat\/agent\/models\.json/);
  assert.match(deployment, /\.chat\/agent\/auth\.json/);
  for (const command of ["install", "update", "doctor", "rollback", "validate-config"]) {
    assert.match(chatctl, new RegExp(`\\b${command}\\b`));
  }
  assert.match(chatctl, /flock --nonblock/);
  assert.match(chatctl, /env -i/);
  assert.match(chatctl, /\{\"ok\":true,\"service\":\"chat\"\}/);
  assert.match(chatctl, /chmod -R u=rwX,g=rX,o=/);
  assert.match(packageJson.scripts["pi:prepare"], /pi:hydrate-model-data/);
  assert.match(packageJson.scripts["pi:hydrate-model-data"], /hydrate:model-data/);
  assert.equal(deviceDirectoryExample.version, 1);
  assert.deepEqual(Object.keys(deviceDirectoryExample.devices[0]).sort(), ["id", "name", "url"]);
  assert.match(deployment, /\$CHAT_HOME\/devices\.json/);
});

test("GitHub CI verifies the pinned public Submodules through the release gate", () => {
  const ci = read(".github/workflows/ci.yml");
  const documentation = read("docs/ci.md");
  const gitmodules = read(".gitmodules");
  const chatctl = read("deploy/chatctl");
  const commands = [
    "submodules: recursive",
    "pnpm pi:prepare",
    "pnpm install --frozen-lockfile",
    "pnpm verify",
    "git diff --exit-code --submodule=short",
  ];

  assert.match(ci, /^name: ci$/m);
  assert.match(ci, /^\s{2}ci:$/m);
  assert.match(ci, /^\s{4}name: ci$/m);
  assert.doesNotMatch(ci, /CHAT_CI_SUBMODULE_TOKEN/);
  assert.match(ci, /persist-credentials: false/);
  assert.match(ci, /runs-on: ubuntu-24\.04/);
  assert.match(ci, /node-version: 22\.19\.0/);
  assert.match(ci, /version: 10\.13\.1/);
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.doesNotMatch(ci, /pnpm (bootstrap|lint|format:check|test:browser)/);
  for (let index = 1; index < commands.length; index += 1) {
    assert.ok(ci.indexOf(commands[index - 1]) < ci.indexOf(commands[index]), `${commands[index]} is out of order`);
  }
  assert.match(gitmodules, /https:\/\/github\.com\/later-3\/pi\.git/);
  assert.match(gitmodules, /https:\/\/github\.com\/later-3\/chat-frontend\.git/);
  assert.doesNotMatch(gitmodules, /git@github\.com/);
  assert.match(chatctl, /CHAT_REPO_URL="\$\{CHAT_REPO_URL:-https:\/\/github\.com\/later-3\/Chat\.git\}"/);
  assert.match(documentation, /不需要个人Token、SSH私钥或额外的Actions Secret/);
  assert.match(documentation, /不缓存`node_modules`/);
});

test("chatctl validates production authentication without echoing credentials", (t) => {
  const tempDirectory = mkdtempSync(join(tmpdir(), "chat-deployment-config-"));
  t.after(() => rmSync(tempDirectory, { recursive: true, force: true }));

  const strongPassword = "deployment-test-password-2026";
  const sessionSecret = "deployment-test-session-secret-at-least-32-characters";
  const strongEnvironmentPath = join(tempDirectory, "strong.env");
  const weakEnvironmentPath = join(tempDirectory, "weak.env");
  const traversalEnvironmentPath = join(tempDirectory, "traversal.env");
  const escapedWorkflowEnvironmentPath = join(tempDirectory, "escaped-workflow.env");
  const chatHome = join(tempDirectory, "chat-home");
  mkdirSync(join(chatHome, "agent"), { recursive: true });
  writeFileSync(join(chatHome, "agent", "settings.json"), JSON.stringify({
    defaultProvider: "openai",
    defaultModel: "gpt-5.5",
  }), { mode: 0o600 });
  const baseEnvironment = [
    "HOST=127.0.0.1",
    "PORT=43110",
    "WORKFLOW_TARGET_WORLD=local",
    `CHAT_HOME=${chatHome}`,
    `WORKFLOW_LOCAL_DATA_DIR=${join(chatHome, "runtime", "workflow-data")}`,
    "CHAT_PUBLIC_URL=https://chat.example.test",
    "CHAT_WEB_AUTH_ENABLED=1",
    "CHAT_WEB_AUTH_USERNAME=test-user",
    `CHAT_WEB_AUTH_PASSWORD=${strongPassword}`,
    "CHAT_WEB_AUTH_SESSION_DAYS=30",
    `CHAT_WEB_AUTH_SESSION_SECRET=${sessionSecret}`,
    "",
  ].join("\n");
  writeFileSync(strongEnvironmentPath, baseEnvironment, { mode: 0o600 });
  writeFileSync(weakEnvironmentPath, baseEnvironment.replace(strongPassword, "123456"), { mode: 0o600 });
  writeFileSync(
    traversalEnvironmentPath,
    baseEnvironment.replace(`CHAT_HOME=${chatHome}`, `CHAT_HOME=${chatHome}/../../etc`),
    { mode: 0o600 },
  );
  writeFileSync(
    escapedWorkflowEnvironmentPath,
    baseEnvironment.replace(
      `WORKFLOW_LOCAL_DATA_DIR=${join(chatHome, "runtime", "workflow-data")}`,
      `WORKFLOW_LOCAL_DATA_DIR=${join(tempDirectory, "outside-chat-home")}`,
    ),
    { mode: 0o600 },
  );

  const runValidateConfig = (environmentPath) => spawnSync(
    "bash",
    ["deploy/chatctl", "validate-config", "--env-file", environmentPath],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const strongResult = runValidateConfig(strongEnvironmentPath);
  assert.equal(strongResult.status, 0, strongResult.stderr || strongResult.stdout);

  const weakResult = runValidateConfig(weakEnvironmentPath);
  assert.notEqual(weakResult.status, 0, "the public default password must be rejected");

  assert.notEqual(runValidateConfig(traversalEnvironmentPath).status, 0, "path traversal must be rejected");
  assert.notEqual(
    runValidateConfig(escapedWorkflowEnvironmentPath).status,
    0,
    "Workflow data must stay inside CHAT_HOME",
  );

  const combinedOutput = [
    strongResult.stdout,
    strongResult.stderr,
    weakResult.stdout,
    weakResult.stderr,
  ].join("\n");
  assert.doesNotMatch(combinedOutput, new RegExp(strongPassword));
  assert.doesNotMatch(combinedOutput, new RegExp(sessionSecret));
});

test("deployment doctor is offline and assembles an in-memory AgentSession", () => {
  const doctor = read("scripts/deployment-doctor.mjs");

  assert.match(doctor, /allowModelNetwork:\s*false/);
  assert.match(doctor, /refreshOnCreate:\s*true/);
  assert.match(doctor, /SessionManager\.inMemory\(\)/);
  assert.match(doctor, /createAgentSession\(/);
  assert.doesNotMatch(doctor, /\.prompt\(/);

  const tempDirectory = mkdtempSync(join(tmpdir(), "chat-deployment-doctor-"));
  try {
    const chatHome = join(tempDirectory, "chat-home");
    const workflowDataDirectory = join(tempDirectory, "workflow-data");
    const agentDirectory = join(chatHome, "agent");
    mkdirSync(agentDirectory, { recursive: true });
    mkdirSync(workflowDataDirectory, { recursive: true });
    writeFileSync(join(agentDirectory, "settings.json"), JSON.stringify({
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    }), { mode: 0o600 });

    const fakeCredential = "deployment-doctor-test-credential";
    writeFileSync(join(agentDirectory, "auth.json"), JSON.stringify({
      openai: { type: "api_key", key: fakeCredential },
    }), { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      ["scripts/deployment-doctor.mjs", "--root", repositoryRoot],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CHAT_HOME: chatHome,
          WORKFLOW_LOCAL_DATA_DIR: workflowDataDirectory,
          PI_OFFLINE: "1",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"agentSessionAssembly":"ok"/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(fakeCredential));
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
