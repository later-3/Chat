import { serviceStatusSchema } from "@chat/contracts";
import { useQuery } from "@tanstack/react-query";

async function fetchServiceStatus() {
  const res = await fetch("/api/healthz");
  if (!res.ok) {
    throw new Error(`healthz failed: ${res.status}`);
  }
  return serviceStatusSchema.parse(await res.json());
}

/**
 * P0外壳：只投影服务端状态，不持有权威事实。
 * 浏览器通过REST Query读取`@chat/contracts`定义的合同形状。
 */
export function App() {
  const status = useQuery({ queryKey: ["service-status"], queryFn: fetchServiceStatus });

  return (
    <main>
      <h1>Chat</h1>
      <p>P0工程与合同骨架。</p>
      <p aria-live="polite">
        API状态：
        {status.isPending ? "加载中" : status.isError ? "不可达" : status.data.status}
      </p>
    </main>
  );
}
