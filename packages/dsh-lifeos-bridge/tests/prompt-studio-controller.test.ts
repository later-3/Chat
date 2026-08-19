import assert from "node:assert/strict";
import test from "node:test";
import { PromptStudioController } from "../src/client/prompt-studio-controller.ts";

const SHA = "a".repeat(64);
const region = {
  schemaVersion: "chat-prompt-studio-api.v1",
  regionKey: "rules",
  title: "规则与规范",
  description: "本次运行必须遵守的规则。",
  category: "context",
  plannedPlacement: "messages",
  contentKind: "markdown",
  cardinality: "multiple",
  userManageable: true,
  availability: "active",
  stableOrder: 60,
  catalogRevision: 1,
  sha256: SHA,
  sourceRelativePath: "prompts/regions/catalog.md",
} as const;

const summary = {
  schemaVersion: "chat-prompt-studio-api.v1",
  promptFragmentId: "pfg_testfragment",
  ownerKind: "principal",
  status: "active",
  regionKey: "rules",
  title: "我的规则",
  contentKind: "markdown",
  currentRevisionId: "pfr_testfragmentv1",
  currentRevisionNumber: 1,
  currentRevisionSha256: SHA,
  revision: 1,
  updatedAt: "2026-08-19T00:00:00.000Z",
  allowedActions: ["revise", "archive"],
} as const;

const revision = {
  schemaVersion: "chat-prompt-studio-api.v1",
  promptFragmentId: "pfg_testfragment",
  promptFragmentRevisionId: "pfr_testfragmentv1",
  ownerKind: "principal",
  revision: 1,
  regionKey: "rules",
  title: "我的规则",
  content: { kind: "markdown", bodyMarkdown: "必须基于证据。" },
  sha256: SHA,
  createdAt: "2026-08-19T00:00:00.000Z",
} as const;

const detail = {
  schemaVersion: "chat-prompt-studio-api.v1",
  fragment: summary,
  currentRevision: revision,
  revisions: [
    {
      schemaVersion: "chat-prompt-studio-api.v1",
      promptFragmentRevisionId: "pfr_testfragmentv1",
      revision: 1,
      title: "我的规则",
      sha256: SHA,
      createdAt: "2026-08-19T00:00:00.000Z",
    },
  ],
} as const;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Prompt Studio按需读取区域/组件，并用当前CAS保存新版本", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init === undefined ? {} : { init }) });
    if (url === "/lifeos/prompts/regions") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        catalogSha256: SHA,
        items: [region],
      });
    }
    if (url === "/lifeos/prompts/fragments?limit=100") {
      return json({ schemaVersion: "chat-prompt-studio-api.v1", items: [summary] });
    }
    if (url === "/lifeos/prompts/fragments/pfg_testfragment" && init?.method === undefined) {
      return json(detail);
    }
    if (url === "/lifeos/prompts/fragments/pfg_testfragment/revisions" && init?.method === "POST") {
      return json(
        { schemaVersion: "chat-prompt-studio-api.v1", promptFragment: detail, replayed: false },
        201,
      );
    }
    return json({ title: "not found", code: "not_found" }, 404);
  };
  const controller = new PromptStudioController(fetchImpl);
  await controller.refresh();
  assert.equal(controller.getSnapshot().regions[0]?.regionKey, "rules");
  assert.equal(controller.getSnapshot().fragments[0]?.title, "我的规则");

  await controller.select("pfg_testfragment");
  assert.equal(controller.getSnapshot().selected?.currentRevision.content.kind, "markdown");
  await controller.revise({
    currentRevisionId: "pfr_testfragmentv1" as never,
    currentRevisionSha256: SHA,
    revision: {
      regionKey: "rules",
      title: "我的规则 v2",
      content: { kind: "markdown", bodyMarkdown: "必须读取权威事实。" },
    },
  });
  const write = requests.find((item) => item.init?.method === "POST");
  assert.ok(write?.init?.body);
  const body = JSON.parse(String(write.init.body)) as {
    commandId: string;
    expectedRevision: number;
    payload: { currentRevisionId: string; currentRevisionSha256: string };
  };
  assert.match(body.commandId, /^cmd_[a-f0-9]+$/u);
  assert.equal(body.expectedRevision, 1);
  assert.equal(body.payload.currentRevisionId, "pfr_testfragmentv1");
  assert.equal(body.payload.currentRevisionSha256, SHA);
  controller.dispose();
});

test("Prompt Studio写响应丢失后只用同一commandId原样重试", async () => {
  const writeBodies: string[] = [];
  let firstWrite = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === "/lifeos/prompts/regions") {
      return json({
        schemaVersion: "chat-prompt-studio-api.v1",
        catalogSha256: SHA,
        items: [region],
      });
    }
    if (url === "/lifeos/prompts/fragments?limit=100") {
      return json({ schemaVersion: "chat-prompt-studio-api.v1", items: [summary] });
    }
    if (url === "/lifeos/prompts/fragments/pfg_testfragment" && init?.method === undefined) {
      return json(detail);
    }
    if (url === "/lifeos/prompts/fragments/pfg_testfragment/revisions" && init?.method === "POST") {
      writeBodies.push(String(init.body));
      if (firstWrite) {
        firstWrite = false;
        throw new TypeError("response lost");
      }
      return json(
        { schemaVersion: "chat-prompt-studio-api.v1", promptFragment: detail, replayed: true },
        200,
      );
    }
    return json({ title: "not found", code: "not_found" }, 404);
  };
  const controller = new PromptStudioController(fetchImpl);
  await controller.refresh();
  await controller.select("pfg_testfragment");
  const intended = {
    currentRevisionId: "pfr_testfragmentv1" as never,
    currentRevisionSha256: SHA,
    revision: {
      regionKey: "rules",
      title: "结果未知重试",
      content: { kind: "markdown" as const, bodyMarkdown: "必须使用同一命令。" },
    },
  };

  await assert.rejects(controller.revise(intended), /response lost/u);
  await assert.rejects(
    controller.revise({
      ...intended,
      revision: { ...intended.revision, title: "不同正文" },
    }),
    /只能原样重试/u,
  );
  assert.equal(writeBodies.length, 1);

  await controller.revise(intended);
  assert.equal(writeBodies.length, 2);
  const first = JSON.parse(writeBodies[0]!) as { commandId: string };
  const replay = JSON.parse(writeBodies[1]!) as { commandId: string };
  assert.equal(replay.commandId, first.commandId);
  controller.dispose();
});
