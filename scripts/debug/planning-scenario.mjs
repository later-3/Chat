// B2调试客户端（任务书§六.9）：只调用Chat公开API完成
// 发送 -> 等待Plan v1 -> 要求修改 -> 等待Plan v2 -> 批准 -> 正式Assistant Message。
// 禁止：直接读写JSON Store、直接调用pi/resumeHook、使用Hook Token或Workflow Run ID。
import { randomUUID } from "node:crypto";

const api = process.argv.includes("--api")
  ? process.argv[process.argv.indexOf("--api") + 1]
  : "http://127.0.0.1:43111";
const text =
  process.argv.includes("--text") && process.argv[process.argv.indexOf("--text") + 1]
    ? process.argv[process.argv.indexOf("--text") + 1]
    : "根据我输入的项目进展，先规划怎样整理，再生成一份结构清楚的Markdown周报。计划必须包含“风险与下一步”。";
const revisionInstruction =
  process.argv.includes("--revision") && process.argv[process.argv.indexOf("--revision") + 1]
    ? process.argv[process.argv.indexOf("--revision") + 1]
    : "把风险单独成节，并增加下周三个行动项";

const cmd = () => `cmd_${randomUUID().replaceAll("-", "")}`;

async function postJson(path, body, expectStatus) {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (res.status !== expectStatus) {
    throw new Error(`POST ${path} -> ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function getJson(path) {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function waitRun(productRunId, predicate, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { run } = await getJson(`/api/runs/${productRunId}`);
    if (predicate(run)) return run;
    if (Date.now() > deadline)
      throw new Error(`等待${label}超时，最后状态:${run.status}/${run.phase}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function log(step, detail) {
  console.log(`[scenario] ${step}${detail !== undefined ? ` ${detail}` : ""}`);
}

const { session } = await postJson("/api/sessions", { commandId: cmd(), payload: {} }, 201);
log("session", session.sessionId);

const sent = await postJson(
  `/api/sessions/${session.sessionId}/messages`,
  { commandId: cmd(), payload: { text } },
  201,
);
const productRunId = sent.run.productRunId;
log("run", productRunId);

await waitRun(productRunId, (run) => run.status === "waiting_human", "Plan v1");
let { items: plans } = await getJson(`/api/runs/${productRunId}/plans`);
const v1 = plans[plans.length - 1];
const { approval } = await getJson(`/api/runs/${productRunId}/approvals/current`);
log("plan v1", `revision=${v1.planRevision} sha256=${v1.sha256.slice(0, 12)}…`);
console.log(v1.content.summary);

let { run: runNow } = await getJson(`/api/runs/${productRunId}`);
await postJson(
  `/api/runs/${productRunId}/decisions`,
  {
    commandId: cmd(),
    expectedRevision: runNow.revision,
    payload: {
      approvalRequestId: approval.approvalRequestId,
      planId: v1.planId,
      planRevision: v1.planRevision,
      planSha256: v1.sha256,
      kind: "request_revision",
      revisionInstruction,
    },
  },
  201,
);
log("decision", "request_revision已提交");

await waitRun(
  productRunId,
  (run) => run.status === "waiting_human" && run.currentPlan?.planRevision === 2,
  "Plan v2",
);
({ items: plans } = await getJson(`/api/runs/${productRunId}/plans`));
const v2 = plans[plans.length - 1];
const { approval: approval2 } = await getJson(`/api/runs/${productRunId}/approvals/current`);
log(
  "plan v2",
  `revision=${v2.planRevision} sha256=${v2.sha256.slice(0, 12)}…（v1=${plans[0].status}）`,
);
console.log(v2.content.summary);

({ run: runNow } = await getJson(`/api/runs/${productRunId}`));
await postJson(
  `/api/runs/${productRunId}/decisions`,
  {
    commandId: cmd(),
    expectedRevision: runNow.revision,
    payload: {
      approvalRequestId: approval2.approvalRequestId,
      planId: v2.planId,
      planRevision: v2.planRevision,
      planSha256: v2.sha256,
      kind: "approve",
    },
  },
  201,
);
log("decision", "approve已提交");

await waitRun(productRunId, (run) => run.status === "succeeded", "succeeded", 300_000);
log("run", "succeeded/completed");

const messages = await getJson(`/api/sessions/${session.sessionId}/messages`);
const finalMessage = messages.items[messages.items.length - 1];
log("final", `${finalMessage.role} message ${finalMessage.messageId}`);
console.log("---- 正式Assistant Message ----");
console.log(finalMessage.content.text);
