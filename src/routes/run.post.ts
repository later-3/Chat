import { defineEventHandler } from "nitro/h3";
import { start } from "workflow/api";
import {
  MINIMAL_PI_CODING_AGENT_PROMPT,
  minimalPiCodingAgentWorkflow,
} from "../workflows/minimal-pi-coding-agent.js";

export default defineEventHandler(async () => {
  const run = await start(minimalPiCodingAgentWorkflow, [
    {
      cwd: process.cwd(),
      prompt: MINIMAL_PI_CODING_AGENT_PROMPT,
    },
  ]);
  console.log(`[workflow] started runId=${run.runId}`);
  const result = await run.returnValue;
  return { runId: run.runId, result };
});
