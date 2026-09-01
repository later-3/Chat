import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PromptResourceStore,
  getPromptResourceStore,
  listPromptResources,
} from "./store.ts";
import {
  BUILT_IN_PERSONAL_PROMPT_RESOURCES,
  WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
} from "./builtins.ts";
import { openProject } from "../projects/registry.ts";

function sessionSource(sessionId = "session-1") {
  return {
    type: "session",
    projectId: "project-1",
    sessionId,
    workflowInvocationId: "invocation-1",
    entryIds: ["entry-1", "entry-2"],
    context: "The user asked for explicit module boundaries.",
    capturedAt: "2026-08-30T06:00:00.000Z",
  };
}

test("Prompt resources keep purpose, content, tags and Session provenance", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-resource-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);

  const draft = await store.createDraft({
    kind: "rule",
    title: "Keep modules focused",
    purpose: "Prevent unrelated responsibilities from accumulating in one module.",
    content: "Each module must have one explicit responsibility and a narrow public interface.",
    tags: ["architecture", "quality", "architecture"],
    sources: [sessionSource()],
    author: { type: "agent", agentId: "rule-curator-agent" },
  });
  assert.equal((await store.listDrafts()).length, 1);

  const resource = await store.commitDraft(draft.id);
  assert.equal(resource.revision, 1);
  assert.deepEqual(resource.tags, ["architecture", "quality"]);
  assert.equal(resource.sources[0].sessionId, "session-1");
  assert.equal(resource.author.type, "agent");
  assert.equal(await store.getDraft(draft.id), undefined);
  assert.deepEqual(await store.get(resource.id), resource);
});

test("Prompt resource search covers title, purpose, content, tags and source context", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);
  const first = await store.createDraft({
    kind: "rule",
    title: "Frontend accessibility",
    purpose: "Protect keyboard operation",
    content: "Interactive controls must remain keyboard accessible.",
    tags: ["frontend"],
    sources: [sessionSource()],
    author: { type: "user" },
  });
  await store.commitDraft(first.id);
  const second = await store.createDraft({
    kind: "experience",
    title: "Module review",
    purpose: "Review architecture",
    content: "Inspect imports before moving code.",
    tags: ["backend"],
    sources: [{ ...sessionSource("session-2"), context: "A keyboard regression occurred." }],
    author: { type: "user" },
  });
  await store.commitDraft(second.id);

  assert.equal((await store.list({ query: "keyboard" })).length, 2);
  assert.equal((await store.list({ kind: "rule", tags: ["frontend"] })).length, 1);
  assert.equal((await store.list({ kind: "experience" }))[0].title, "Module review");
});

test("draft review creates an append-only resource revision chain", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-revision-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);
  const firstDraft = await store.createDraft({
    kind: "rule",
    title: "Type safety",
    purpose: "Keep external input explicit",
    content: "Parse external input before using it.",
    author: { type: "user" },
  });
  const first = await store.commitDraft(firstDraft.id);
  const updateDraft = await store.createDraft({
    baseResourceId: first.id,
    kind: first.kind,
    title: first.title,
    purpose: first.purpose,
    content: first.content,
    tags: first.tags,
    sources: first.sources,
    author: { type: "user" },
  });
  const reviewed = await store.updateDraft(updateDraft.id, {
    expectedUpdatedAt: updateDraft.updatedAt,
    content: "Parse and validate every external input before using it.",
    tags: ["typescript", "boundary"],
  });
  assert.equal(reviewed.baseRevision, 1);

  const second = await store.commitDraft(reviewed.id);
  assert.equal(second.revision, 2);
  assert.equal(second.content, "Parse and validate every external input before using it.");
  assert.deepEqual((await store.history(first.id)).map((revision) => revision.revision), [1, 2]);
});

test("draft updates use updatedAt as an optimistic concurrency token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-draft-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstStore = new PromptResourceStore(root);
  const secondStore = new PromptResourceStore(root);
  const draft = await firstStore.createDraft({
    kind: "rule",
    title: "Concurrent review",
    purpose: "Prevent lost draft updates",
    content: "Initial content",
    author: { type: "user" },
  });
  const updated = await firstStore.updateDraft(draft.id, {
    expectedUpdatedAt: draft.updatedAt,
    content: "First update",
  });

  await assert.rejects(secondStore.updateDraft(draft.id, {
    expectedUpdatedAt: draft.updatedAt,
    content: "Stale update",
  }), /已被修改/);
  assert.equal((await secondStore.getDraft(draft.id)).content, updated.content);
});

test("an outdated draft cannot overwrite a newer resource revision", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-conflict-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);
  const seed = await store.createDraft({
    kind: "rule",
    title: "Review",
    purpose: "Require review",
    content: "Review before commit.",
    author: { type: "user" },
  });
  const resource = await store.commitDraft(seed.id);
  const stale = await store.createDraft({
    baseResourceId: resource.id,
    kind: resource.kind,
    title: resource.title,
    purpose: resource.purpose,
    content: "Stale edit",
    author: { type: "user" },
  });
  const current = await store.createDraft({
    baseResourceId: resource.id,
    kind: resource.kind,
    title: resource.title,
    purpose: resource.purpose,
    content: "Current edit",
    author: { type: "user" },
  });
  await store.commitDraft(current.id);

  await assert.rejects(store.commitDraft(stale.id), /已被修改/);
  assert.equal((await store.get(resource.id)).content, "Current edit");
});

test("archiving is a reviewed resource revision rather than deletion", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-archive-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);
  const seed = await store.createDraft({
    kind: "experience",
    title: "Old workaround",
    purpose: "Record an old workaround",
    content: "Use the old endpoint.",
    author: { type: "user" },
  });
  const resource = await store.commitDraft(seed.id);
  const archive = await store.createDraft({
    baseResourceId: resource.id,
    kind: resource.kind,
    title: resource.title,
    purpose: resource.purpose,
    content: resource.content,
    tags: resource.tags,
    sources: resource.sources,
    status: "archived",
    author: { type: "user" },
  });
  await store.commitDraft(archive.id);

  assert.equal((await store.list()).length, 0);
  assert.equal((await store.list({ status: "all" })).length, 1);
  assert.equal((await store.list({ status: "archived" }))[0].revision, 2);
});

test("the built-in Workflow incident is seeded once into the Personal experience library", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-built-in-experience-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");

  const firstStore = await getPromptResourceStore({ type: "personal" }, chatHome);
  const experience = await firstStore.get(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID);
  assert.equal(experience?.kind, "experience");
  assert.equal(experience?.status, "active");
  assert.equal(experience?.revision, 3);
  assert.match(experience?.content ?? "", /Frontend Run 到 Pi SDK/);

  const secondStore = await getPromptResourceStore({ type: "personal" }, chatHome);
  assert.equal(
    (await secondStore.history(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID)).length,
    3,
  );
});

test("a built-in experience upgrades only while its stored revision prefix is unchanged", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-built-in-experience-upgrade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  const builtIn = BUILT_IN_PERSONAL_PROMPT_RESOURCES[0];
  const personalRoot = path.join(chatHome, "prompt-resources");
  const store = new PromptResourceStore(personalRoot);

  await store.ensureDocuments([{ ...builtIn, revisions: [builtIn.revisions[0]] }]);
  const upgradedStore = await getPromptResourceStore({ type: "personal" }, chatHome);
  assert.equal((await upgradedStore.get(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID))?.revision, 3);

  const customRoot = path.join(root, "custom-prompt-resources");
  const customStore = new PromptResourceStore(customRoot);
  await customStore.ensureDocuments([{ ...builtIn, revisions: [builtIn.revisions[0]] }]);
  const first = await customStore.get(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID);
  assert.ok(first);
  const draft = await customStore.createDraft({
    baseResourceId: first.id,
    kind: first.kind,
    title: first.title,
    purpose: first.purpose,
    content: "用户已经修订的案例",
    tags: first.tags,
    status: first.status,
    sources: first.sources,
    author: { type: "user" },
  });
  await customStore.commitDraft(draft.id);
  await customStore.ensureDocuments(BUILT_IN_PERSONAL_PROMPT_RESOURCES);
  assert.equal((await customStore.get(WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID))?.content, "用户已经修订的案例");
});

test("retrying after a committed revision but failed Draft cleanup is idempotent", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-commit-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new PromptResourceStore(root);
  const seedDraft = await store.createDraft({
    kind: "rule",
    title: "Recover commits",
    purpose: "Make commit retry deterministic",
    content: "Version one",
    author: { type: "user" },
  });
  const seed = await store.commitDraft(seedDraft.id);
  const updateDraft = await store.createDraft({
    baseResourceId: seed.id,
    kind: seed.kind,
    title: seed.title,
    purpose: seed.purpose,
    content: "Version two",
    author: { type: "user" },
  });
  const committed = await store.commitDraft(updateDraft.id);
  fs.writeFileSync(
    path.join(root, "drafts", `${updateDraft.id}.json`),
    `${JSON.stringify(updateDraft, null, 2)}\n`,
  );

  const recovered = await store.commitDraft(updateDraft.id);
  assert.deepEqual(recovered, committed);
  assert.equal((await store.history(seed.id)).length, 2);
  assert.equal(await store.getDraft(updateDraft.id), undefined);
});

test("Personal and Project Prompt libraries stay isolated unless Targets are explicit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-prompt-targets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const chatHome = path.join(root, "home");
  for (const projectId of ["project-a", "project-b"]) {
    const projectRoot = path.join(root, projectId);
    fs.mkdirSync(projectRoot, { recursive: true });
    await openProject({
      path: projectRoot,
      chatHome,
      id: projectId,
      name: projectId,
    });
  }
  const targets = [
    { type: "personal" },
    { type: "project", projectId: "project-a" },
    { type: "project", projectId: "project-b" },
  ];
  const committed = [];
  for (const [index, target] of targets.entries()) {
    const store = await getPromptResourceStore(target, chatHome);
    const draft = await store.createDraft({
      kind: "experience",
      title: `Target ${index}`,
      purpose: "Verify target isolation",
      content: `Only target ${index} owns this content.`,
      author: { type: "user" },
    });
    committed.push(await store.commitDraft(draft.id));
  }

  const currentView = await listPromptResources(targets.slice(0, 2), {}, chatHome);
  assert.deepEqual(
    currentView
      .filter((resource) => resource.id !== WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID)
      .map((resource) => resource.title)
      .sort(),
    ["Target 0", "Target 1"],
  );
  assert.deepEqual(
    currentView.find((resource) => resource.id === WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID)?.target,
    { type: "personal" },
  );
  assert.equal(await (await getPromptResourceStore(targets[1], chatHome)).get(committed[2].id), undefined);
  assert.equal((await listPromptResources([targets[2]], {}, chatHome))[0].title, "Target 2");
});
