import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { gatewayConfiguration, prepareEnvironment, checkGateway } from "../deploy/nanoclaw-config.mjs";

const root = new URL("../", import.meta.url).pathname;
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "chatctl-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const units = join(dir, "units"); mkdirSync(units);
  const runtime = join(dir, "runtime"); mkdirSync(join(runtime, "current/server"), { recursive: true });
  writeFileSync(join(runtime, "current/server/index.mjs"), "");
  const state = join(dir, "state"); mkdirSync(state);
  const log = join(dir, "calls"); writeFileSync(log, "");
  function run(command, { setup = "", body = "service_command" } = {}) {
    const script = `source deploy/chatctl ${command}
      require_linux_root() { :; }
      acquire_deployment_lock() { :; }
      load_installed_environment() { CONFIGURED_PORT=43110; }
      systemctl() {
        local IFS=' '
        printf '%s\\n' "$*" >> "$TEST_LOG"
        case "$1" in
          show) if [[ "$2" == --property=WorkingDirectory ]]; then
            [[ "$4" != nanoclaw-chat.service ]] && echo /opt/chat || echo /opt/chat/nanoclaw
          elif [[ "$2" == --property=User ]]; then echo "\${TEST_UNIT_OWNER:-chat}"; fi ;;
          is-active) test -f "$TEST_STATE/\${3%.service}" ;;
          start) touch "$TEST_STATE/\${2%.service}" ;;
          stop) rm -f "$TEST_STATE/\${2%.service}" ;;
        esac
      }
      wait_for_health() { test -f "$TEST_STATE/chat"; }
      nano_health() { test -f "$TEST_STATE/nanoclaw-chat"; }
      ${setup}
      ${body}`;
    const result = spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: {
      ...process.env, CHAT_RUNTIME_ROOT: runtime, CHAT_SYSTEMD_DIR: units, TEST_LOG: log, TEST_STATE: state,
    } });
    return { ...result, calls: readFileSync(log, "utf8") };
  }
  return { dir, units, state, run };
}

test("installation prepares a release without starting or enabling services", t => {
  const f = fixture(t);
  const steps = ["require_services_stopped", "install_build_dependencies", "ensure_run_user", "ensure_node_toolchain", "checkout_source", "prepare_dependencies", "generate_user_configuration", "validate_config", "load_configured_paths", "ensure_configured_directories", "build_release", "install_systemd_unit", "atomic_link", "prune_old_releases"];
  const result = f.run("install", { setup: `NEW_RELEASE=/tmp/release\n${steps.map(step => `${step}() { echo ${step} >> "$TEST_LOG"; }`).join("\n")}`, body: "deploy_selected_ref" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.indexOf("require_services_stopped") < result.calls.indexOf("checkout_source"));
  assert.doesNotMatch(result.calls, /systemctl|restart|enable|^start/m);
  assert.match(result.stderr, /services remain stopped/);
});

test("daily start is idempotent; stop reverses dependency order without install or data reset", t => {
  const f = fixture(t); writeFileSync(join(f.units, "nanoclaw-chat.service"), "");
  assert.equal(f.run("start").status, 0);
  const twice = f.run("start"); assert.equal(twice.status, 0, twice.stderr);
  assert.equal((twice.calls.match(/^start chat.service$/gm) || []).length, 1);
  assert.equal((twice.calls.match(/^start nanoclaw-chat.service$/gm) || []).length, 1);
  const stopped = f.run("stop"); assert.equal(stopped.status, 0);
  assert.match(stopped.calls, /stop nanoclaw-chat.service\nstop chat.service/);
  assert.doesNotMatch(stopped.calls, /install|disable|npm|git/);
});

test("failed Nano readiness preserves an already-running Backend", t => {
  const f = fixture(t); writeFileSync(join(f.units, "nanoclaw-chat.service"), ""); writeFileSync(join(f.state, "chat"), "");
  const result = f.run("start", { setup: "nano_health() { return 1; }" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(f.state, "chat")), true);
  assert.equal(existsSync(join(f.state, "nanoclaw-chat")), false);
  assert.doesNotMatch(result.calls, /^stop chat.service$/m);
});

test("backend-only start and boot policy are independent from Nano startup", t => {
  const f = fixture(t); writeFileSync(join(f.units, "nanoclaw-chat.service"), "");
  const result = f.run("start --only backend"); assert.equal(result.status, 0);
  assert.doesNotMatch(result.calls, /nanoclaw/);
  const enabled = f.run("enable"); assert.equal(enabled.status, 0);
  assert.match(enabled.calls, /enable nanoclaw-chat.service/);
  assert.equal(existsSync(join(f.state, "nanoclaw-chat")), false);
});

test("Nano environment preparation preserves credentials and refuses conflicting ownership", async t => {
  const f = fixture(t); const nano = join(f.dir, "nano"); mkdirSync(nano);
  const environment = { PORT: "43110", CHAT_CHANNEL_GATEWAY_TOKEN: "private-fixture-service-token-32-characters" };
  writeFileSync(join(nano, ".env"), "CUSTOM_CHANNEL_KEY=keep-this\n");
  await prepareEnvironment(nano, environment);
  const first = readFileSync(join(nano, ".env"), "utf8");
  await prepareEnvironment(nano, environment);
  assert.equal(readFileSync(join(nano, ".env"), "utf8"), first);
  assert.match(first, /CUSTOM_CHANNEL_KEY=keep-this/);
  await assert.rejects(prepareEnvironment(nano, { ...environment, PORT: "43111" }), /differs/);
  assert.equal(readFileSync(join(nano, ".env"), "utf8"), first);
  assert.throws(() => gatewayConfiguration({ ...environment, CHAT_NANOCLAW_GATEWAY_URL: "http://other-host:3000/webhook/chat-backend" }), /loopback/);
});

test("readiness authenticates and validates Nano instance identity, not just an open port", async t => {
  const token = "fixture-channel-service-token-32-characters";
  let instanceId = "local";
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ schemaVersion: 1, ok: true, instanceId }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const environment = { PORT: "43110", CHAT_CHANNEL_GATEWAY_TOKEN: token, CHAT_NANOCLAW_GATEWAY_URL: `http://127.0.0.1:${server.address().port}/webhook/chat-backend` };
  await checkGateway(environment, { attempts: 1 });
  instanceId = "wrong-instance";
  await assert.rejects(checkGateway(environment, { attempts: 1 }), /identity/);
});


test("service control refuses another owner's unit and stop does not need valid model configuration", t => {
  const f = fixture(t); writeFileSync(join(f.units, "chat.service"), "");
  const refused = f.run("stop", { setup: "export TEST_UNIT_OWNER=other-user" });
  assert.notEqual(refused.status, 0);
  assert.doesNotMatch(refused.calls, /^stop /m);
  const stopped = f.run("stop", { setup: 'load_installed_environment() { fail "configuration broken"; }' });
  assert.equal(stopped.status, 0, stopped.stderr);
});
