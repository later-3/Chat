import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
  assert.doesNotMatch(production, /scripts\/dev\/start\.mjs/);

  assert.match(directTunnel, /com\.later\.chat\.cloudflare-direct/);
  assert.match(directTunnel, /__CLOUDFLARED__/);
  assert.match(directTunnel, /__CONFIG__/);
  assert.doesNotMatch(directTunnel, /pi-web|30141/);

  assert.match(relay, /later-cloud-admin/);
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
  const packageJson = JSON.parse(read("package.json"));

  assert.match(systemd, /\/opt\/chat\/\.output\/server\/index\.mjs/);
  assert.match(macCloudflared, /hostname: chat\.ai4child\.asia/);
  assert.match(macCloudflared, /service: http:\/\/127\.0\.0\.1:43110/);
  assert.match(cloudCloudflared, /service: http:\/\/127\.0\.0\.1:33052/);
  assert.match(nginx, /listen 127\.0\.0\.1:33052/);
  assert.match(nginx, /server 127\.0\.0\.1:33051/);
  assert.match(environment, /CHAT_WEB_AUTH_USERNAME=later/);
  assert.match(environment, /CHAT_WEB_AUTH_PASSWORD=123456/);
  assert.match(deployment, /--branch codex\/pi-web-frontend-in-chat/);
  assert.match(deployment, /不能跨平台复制/);
  assert.match(deployment, /\.pi\/agent\/models\.json/);
  assert.match(deployment, /\.pi\/agent\/auth\.json/);
  assert.match(deployment, /sudo -u chat -H sh -lc 'cd \/opt\/chat && pnpm verify'/);
  assert.match(packageJson.scripts["pi:prepare"], /pi:hydrate-model-data/);
  assert.match(packageJson.scripts["pi:hydrate-model-data"], /hydrate:model-data/);
});
