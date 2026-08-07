/**
 * chat-debug:wait-*（任务书§8.3）。
 *
 * 用法: node scripts/debug/wait-ready.mjs <name> <url> [timeoutMs=30000]
 * 轮询至2xx退出码0；超时退出码1。只读取，不修改任何状态。
 */

const [name, url, timeoutArg] = process.argv.slice(2);
if (!name || !url) {
  console.error("用法: node scripts/debug/wait-ready.mjs <name> <url> [timeoutMs]");
  process.exit(2);
}
const timeoutMs = Number.parseInt(timeoutArg ?? "30000", 10);
const deadline = Date.now() + timeoutMs;

for (;;) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (response.ok) {
      console.log(`[wait-ready] ${name} 就绪: ${url}`);
      process.exit(0);
    }
  } catch {
    // 服务尚未启动，继续等待
  }
  if (Date.now() >= deadline) {
    console.error(`[wait-ready] 超时：${name} 在 ${timeoutMs}ms 内未就绪（${url}）`);
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
