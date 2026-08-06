import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

function renderApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("web skeleton", () => {
  it("渲染外壳并通过合同校验投影API状态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "ok", service: "chat-api" }))),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText(/API状态/).textContent).toContain("ok"));
  });

  it("合同校验失败时显示不可达，不伪造成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "degraded" }))),
    );
    renderApp();
    await waitFor(() => expect(screen.getByText(/API状态/).textContent).toContain("不可达"));
  });
});
