import { Hono } from "hono";
import { start } from "workflow/api";
import {
  MINIMAL_PI_CODING_AGENT_PROMPT,
  minimalPiCodingAgentWorkflow,
} from "./workflows/minimal-pi-coding-agent.js";

const app = new Hono();

app.get("/health", (context) => context.json({ status: "ok" }));

app.post("/run", async (context) => {
  const run = await start(minimalPiCodingAgentWorkflow, [
    {
      cwd: process.cwd(),
      prompt: MINIMAL_PI_CODING_AGENT_PROMPT,
    },
  ]);
  console.log(`[workflow] started runId=${run.runId}`);
  const result = await run.returnValue;
  return context.json({ runId: run.runId, result });
});

export default app;
