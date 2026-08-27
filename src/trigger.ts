const baseUrl = process.env.WORKFLOW_BASE_URL ?? "http://127.0.0.1:43112";

export {};

async function waitUntilReady(): Promise<void> {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // VS Code会同时启动Runtime和Trigger；等待Runtime完成首次编译。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workflow Runtime未在30秒内启动：${baseUrl}`);
}

await waitUntilReady();
console.log(`[trigger] starting Minimal Pi Coding Agent Workflow at ${baseUrl}`);

const response = await fetch(`${baseUrl}/run`, { method: "POST" });
const body = await response.text();
if (!response.ok) throw new Error(`Workflow执行失败 (${String(response.status)}): ${body}`);

const parsed = JSON.parse(body) as {
  readonly runId: string;
  readonly result: {
    readonly text: string;
    readonly piSessionId: string;
    readonly piSessionFile: string;
  };
};

console.log(`\n[workflow] runId=${parsed.runId}`);
console.log(`[pi] sessionId=${parsed.result.piSessionId}`);
console.log(`[pi] sessionFile=${parsed.result.piSessionFile}`);
console.log("\n--- Pi Coding Agent ---\n");
console.log(parsed.result.text);
