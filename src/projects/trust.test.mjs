import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { ensureChatHome } from "../chat-home.ts";
import { openProject } from "./registry.ts";
import { getProjectTrust, setProjectTrust } from "./trust.ts";

test("nested Projects keep exact independent trust decisions", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-project-trust-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const parentRoot = path.join(root, "parent");
  const childRoot = path.join(parentRoot, "child");
  fs.mkdirSync(childRoot, { recursive: true });
  const parent = await openProject({ path: parentRoot, chatHome, id: "parent" });
  const child = await openProject({ path: childRoot, chatHome, id: "child" });
  const home = await ensureChatHome(chatHome);

  new ProjectTrustStore(home.agentDir).set(parent.projectRoot, true);
  assert.deepEqual(await getProjectTrust(parent.projectId, chatHome), {
    projectId: "parent",
    trusted: true,
    decision: true,
    inheritedFrom: parent.projectRoot,
  });
  assert.deepEqual(await getProjectTrust(child.projectId, chatHome), {
    projectId: "child",
    trusted: false,
    decision: null,
    inheritedFrom: null,
  });

  await setProjectTrust(child.projectId, false, chatHome);
  assert.equal((await getProjectTrust(child.projectId, chatHome)).decision, false);
  assert.equal((await getProjectTrust(parent.projectId, chatHome)).decision, true);
});
