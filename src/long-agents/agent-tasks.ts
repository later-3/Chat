import type { LongAgentInstanceConfig } from "./types.js";
import { requestNanoClawTasks } from "./nanoclaw-client.js";

/**
 * 每个 Long Agent 预置的两个日常任务（NanoClaw 是任务事实源）：
 * - 23:30 日终总结与反思（并维护记忆）
 * - 08:00 晨间主动联系（由 Agent 判断是否值得打扰用户）
 *
 * 幂等：以任务 id 前缀识别已存在的同名系列（NanoClaw 用名称生成稳定 id 前缀）。
 */
export const DEFAULT_LONG_AGENT_TASKS = [
  {
    name: "daily-summary",
    recurrence: "30 23 * * *",
    prompt: [
      "对今天做一次总结与反思，输出三部分：",
      "1) 今天实际完成或推进了什么（只写事实与结果）；",
      "2) 卡在哪里、原因是什么、下次怎么改（要具体，不要空话）；",
      "3) 有哪些值得长期保留的信息——用 memory_record 记录稳定事实与结论，并清理已经过时或不再重要的记忆。",
      "把总结写进当前会话，控制在 400 字以内。除非确有必须让用户当天知道的事项，不要主动给用户发消息。",
    ].join("\n"),
  },
  {
    name: "morning-outreach",
    recurrence: "0 8 * * *",
    prompt: [
      "给用户发一条今天的消息（用 channel_send），内容按这个结构，但用你自己的话写，别像模板：",
      "1) 昨天（或最近）做了什么、进展到哪一步；",
      "2) 今天或接下来打算做什么；或者你自己想推进什么、有什么想法。",
      "依据来自你的长期职责、正在进行的任务、昨天的总结和记忆。语言要具体、像同事汇报，不要问候语、不要复述总结全文，控制在 200 字以内。",
      "如果昨天到现在确实没有任何值得一提的进展或想法，就保持安静，只把判断理由写进当前会话。",
    ].join("\n"),
  },
] as const;

/** 预置任务是否已存在（按 id 前缀判断，NanoClaw 用名称生成稳定前缀）。 */
function hasSeries(tasks: readonly { id: string }[], name: string): boolean {
  return tasks.some((task) => task.id === name || task.id.startsWith(`${name}-`));
}

/**
 * 确保该 Agent 拥有两个预置任务。返回本次创建的任务名。
 * 调用方决定失败处理（创建 Agent 时失败应回滚；启动时失败只记录）。
 */
export async function ensureDefaultLongAgentTasks(input: {
  readonly instance: LongAgentInstanceConfig;
  readonly agentGroupId: string;
}): Promise<readonly string[]> {
  const listed = await requestNanoClawTasks({
    instance: input.instance,
    agentGroupId: input.agentGroupId,
    operation: { operation: "list" },
  });
  const existing = listed.tasks ?? [];
  const created: string[] = [];
  for (const task of DEFAULT_LONG_AGENT_TASKS) {
    if (hasSeries(existing, task.name)) continue;
    await requestNanoClawTasks({
      instance: input.instance,
      agentGroupId: input.agentGroupId,
      operation: { operation: "create", name: task.name, prompt: task.prompt, recurrence: task.recurrence },
    });
    created.push(task.name);
  }
  return created;
}
