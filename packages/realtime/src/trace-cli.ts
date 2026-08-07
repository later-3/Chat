import { pathToFileURL } from "node:url";
import { TraceReadError, readTraceEvents } from "./trace-reader.js";

/**
 * Trace调试入口（任务书§7.4）：
 *   pnpm debug:trace --run run_xxx
 *
 * 输出约定：事件以JSONL写到stdout（默认已脱敏），摘要与错误写到stderr。
 * 退出码：0成功（含0条事件），2用法错误，3读取或校验失败。
 */

interface CliArgs {
  productRunId?: string | undefined;
  requestId?: string | undefined;
  commandId?: string | undefined;
  dir?: string | undefined;
  help: boolean;
}

const USAGE = `用法: pnpm debug:trace --run <productRunId> [--dir <traceDir>]
       pnpm debug:trace --request <requestId> | --command <commandId>
输出: stdout为脱敏后的JSONL事件（按时间排序），stderr为摘要。`;

export function parseTraceCliArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--run":
        args.productRunId = value;
        index += 1;
        break;
      case "--request":
        args.requestId = value;
        index += 1;
        break;
      case "--command":
        args.commandId = value;
        index += 1;
        break;
      case "--dir":
        args.dir = value;
        index += 1;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数: ${flag ?? ""}`);
    }
  }
  return args;
}

export function runTraceCli(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseTraceCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.error(USAGE);
    return 0;
  }
  if (
    args.productRunId === undefined &&
    args.requestId === undefined &&
    args.commandId === undefined
  ) {
    console.error("必须提供 --run、--request 或 --command 之一。");
    console.error(USAGE);
    return 2;
  }

  try {
    const events = readTraceEvents({
      ...(args.dir !== undefined ? { dir: args.dir } : {}),
      ...(args.productRunId !== undefined ? { productRunId: args.productRunId } : {}),
      ...(args.requestId !== undefined ? { requestId: args.requestId } : {}),
      ...(args.commandId !== undefined ? { commandId: args.commandId } : {}),
    });
    for (const event of events) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    }
    const selector = args.productRunId ?? args.requestId ?? args.commandId ?? "";
    if (events.length === 0) {
      console.error(`trace: 未找到匹配 ${selector} 的事件。`);
    } else {
      const first = events[0]?.timestamp ?? "";
      const last = events[events.length - 1]?.timestamp ?? "";
      console.error(`trace: ${events.length} 个事件，${first} .. ${last}（输出已脱敏）`);
    }
    return 0;
  } catch (error) {
    if (error instanceof TraceReadError) {
      console.error(`trace读取失败（原始文件未修改）: ${error.message}`);
    } else {
      console.error(`trace读取失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runTraceCli(process.argv.slice(2));
}
