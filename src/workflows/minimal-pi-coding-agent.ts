import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { localTimestamp } from "../runtime-log.js";

// `POST /run`把这个固定Prompt作为Workflow输入。
export const MINIMAL_PI_CODING_AGENT_PROMPT = `
回复你好。
`.trim();

// Workflow函数接收一个参数对象；这个接口提供TypeScript编译期类型检查。
export interface MinimalPiCodingAgentWorkflowInput {
  readonly cwd: string;
  readonly prompt: string;
}

// Workflow返回Assistant文本、本次使用的模型以及Pi Session ID和文件路径。
export interface MinimalPiCodingAgentWorkflowResult {
  readonly text: string;
  readonly piSessionId: string;
  readonly piSessionFile: string;
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
  } | null;
}

export async function minimalPiCodingAgentWorkflow(
  input: MinimalPiCodingAgentWorkflowInput,
): Promise<MinimalPiCodingAgentWorkflowResult> {
  /**
   * `workflow/nitro`在构建时识别`"use workflow"`并转换这个函数。
   * 当前函数只调用一次`runPiCodingAgentStep`并返回该Step的结果。
   */
  "use workflow";

  return runPiCodingAgentStep(input);
}

async function runPiCodingAgentStep(
  input: MinimalPiCodingAgentWorkflowInput,
): Promise<MinimalPiCodingAgentWorkflowResult> {
  /**
   * `"use step"`让`workflow/nitro`把这个函数编译为Workflow Step。
   * Workflow运行到这里时，Step Runtime执行函数体，并保存Step状态和返回值。
   * 这个函数创建Pi AgentSession、调用`session.prompt()`并读取最终Assistant文本。
   */
  "use step";

  const stepStartedAt = Date.now();
  const cwd = resolve(input.cwd);

  /**
   * 当前运行使用三个不同的位置保存数据：
   * - `<input.cwd>/.pi/agent`：Pi的settings、models和auth配置；
   * - `<input.cwd>/.pi/sessions`：Pi Coding Agent的Session文件；
   * - `<Chat进程工作目录>/.workflow-data`：Workflow Local World的Run、Step和Event文件。
   */
  const agentDir = resolve(cwd, ".pi/agent");
  const sessionDir = resolve(cwd, ".pi/sessions");
  console.log(`${localTimestamp()} [pi] step starting cwd=${cwd}`);
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  // 加载sessionDir中cwd相同的最近Session；找不到时创建新Session。
  const sessionManager = SessionManager.continueRecent(cwd, sessionDir);
  console.log(`${localTimestamp()} [pi] creating AgentSession`);

  /**
   * `agentDir`指定Pi读取settings.json、models.json和auth.json的目录。
   * `sessionManager`指定本次使用的Session和Session文件目录。
   */
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

  console.log(`${localTimestamp()} [pi] source=${import.meta.resolve("@earendil-works/pi-coding-agent")}`);
  console.log(`${localTimestamp()} [pi] agentDir=${agentDir}`);
  console.log(`${localTimestamp()} [pi] sessionDir=${sessionDir}`);
  console.log(`${localTimestamp()} [pi] sessionFile=${piSessionFile}`);
  console.log(
    `${localTimestamp()} [pi] model=${session.model?.provider ?? "none"}/${session.model?.id ?? "none"}`,
  );
  if (modelFallbackMessage !== undefined) {
    console.log(`${localTimestamp()} [pi] modelFallback=${modelFallbackMessage}`);
  }

  /**
   * 订阅AgentSession事件并打印Agent、Turn、Tool、重试和压缩状态。
   * 日志不读取消息正文、模型请求体、工具参数、工具结果或认证信息。
   */
  let turn = 0;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_start") {
      console.log(`${localTimestamp()} [pi] agent started`);
    } else if (event.type === "turn_start") {
      turn += 1;
      console.log(`${localTimestamp()} [pi] turn ${turn} started`);
    } else if (event.type === "tool_execution_start") {
      console.log(`${localTimestamp()} [pi] tool started name=${event.toolName}`);
    } else if (event.type === "tool_execution_end") {
      console.log(
        `${localTimestamp()} [pi] tool finished name=${event.toolName} status=${event.isError ? "error" : "ok"}`,
      );
    } else if (event.type === "turn_end") {
      console.log(`${localTimestamp()} [pi] turn ${turn} finished`);
    } else if (event.type === "agent_end") {
      console.log(`${localTimestamp()} [pi] agent ended willRetry=${String(event.willRetry)}`);
    } else if (event.type === "auto_retry_start") {
      console.log(
        `${localTimestamp()} [pi] retry scheduled attempt=${event.attempt}/${event.maxAttempts} delayMs=${event.delayMs}`,
      );
    } else if (event.type === "compaction_start") {
      console.log(`${localTimestamp()} [pi] compaction started reason=${event.reason}`);
    } else if (event.type === "compaction_end") {
      console.log(
        `${localTimestamp()} [pi] compaction finished reason=${event.reason} aborted=${String(event.aborted)}`,
      );
    }
  });

  try {
    console.log(`${localTimestamp()} [pi] prompt submitted chars=${input.prompt.length}`);

    /**
     * `prompt()`启动一次Pi Agent运行并等待它结束。一次运行可以包含多个Turn；
     * 每个Turn可以包含一次模型响应和零个或多个工具调用。
     */
    await session.prompt(input.prompt);
    console.log(
      `${localTimestamp()} [pi] prompt completed elapsedMs=${Date.now() - stepStartedAt}`,
    );

    // 从Session消息中查找最后一条Assistant消息，并提取其中的text内容。
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
    return {
      text,
      piSessionId: session.sessionId,
      piSessionFile,
      model: session.model === undefined
        ? null
        : { provider: session.model.provider, modelId: session.model.id },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${localTimestamp()} [pi] step failed elapsedMs=${Date.now() - stepStartedAt} error=${message}`,
    );
    throw error;
  } finally {
    // 成功或失败后都解除事件订阅，并释放AgentSession持有的运行时资源。
    unsubscribe();
    session.dispose();
    console.log(`${localTimestamp()} [pi] session disposed`);
  }
}

// maxRetries=0表示Step首次失败后不重试；默认值是3次重试。
runPiCodingAgentStep.maxRetries = 0;
