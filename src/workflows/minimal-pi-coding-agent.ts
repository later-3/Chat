import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createAgentSession,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

export const MINIMAL_PI_CODING_AGENT_PROMPT = `
请检查当前工作目录，概括这个项目包含的文件，并说明它现在实现了什么。
`.trim();

export interface MinimalPiCodingAgentWorkflowInput {
  readonly cwd: string;
  readonly prompt: string;
}

export interface MinimalPiCodingAgentWorkflowResult {
  readonly text: string;
  readonly piSessionId: string;
  readonly piSessionFile: string;
}

export async function minimalPiCodingAgentWorkflow(
  input: MinimalPiCodingAgentWorkflowInput,
): Promise<MinimalPiCodingAgentWorkflowResult> {
  "use workflow";

  return runPiCodingAgentStep(input);
}

async function runPiCodingAgentStep(
  input: MinimalPiCodingAgentWorkflowInput,
): Promise<MinimalPiCodingAgentWorkflowResult> {
  "use step";

  const cwd = resolve(input.cwd);
  const agentDir = getAgentDir();
  const sessionDir = resolve(cwd, ".runtime/pi/sessions");
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
  const { session, modelFallbackMessage } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager,
  });

  const piSessionFile = session.sessionFile;
  if (piSessionFile === undefined) {
    session.dispose();
    throw new Error("Pi Coding Agent没有创建持久Session文件");
  }

  console.log(`[pi] source=${import.meta.resolve("@earendil-works/pi-coding-agent")}`);
  console.log(`[pi] cwd=${cwd}`);
  console.log(`[pi] agentDir=${agentDir}`);
  console.log(`[pi] sessionDir=${sessionDir}`);
  console.log(`[pi] sessionFile=${piSessionFile}`);
  if (modelFallbackMessage !== undefined) console.log(`[pi] model=${modelFallbackMessage}`);

  try {
    await session.prompt(input.prompt);
    const assistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    const text =
      assistant?.role === "assistant"
        ? assistant.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n")
            .trim()
        : "";
    if (text === "") throw new Error("Pi Coding Agent没有返回Assistant文本");
    return { text, piSessionId: session.sessionId, piSessionFile };
  } finally {
    session.dispose();
  }
}

runPiCodingAgentStep.maxRetries = 0;
