import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getChatHomePaths } from "../chat-home.js";

/** 通用规范的固定读取顺序（需求 → 前端 → 开发 → 维护）；只读存在的文件。 */
const COMMON_STANDARDS = ["需求规范.md", "前端规范.md", "开发规范.md", "维护规范.md"] as const;
/** 某个 Long Agent 在某个 project 下的专属规范；两种命名都识别。 */
const PROJECT_STANDARDS = ["交互harness.md", "interaction-harness.md"] as const;

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    const text = await readFile(path, "utf8");
    return text.trim() === "" ? undefined : text.trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface InteractionHarnessSections {
  readonly common: readonly { readonly name: string; readonly text: string }[];
  readonly project?: { readonly name: string; readonly text: string };
}

/**
 * 读取交互 harness：通用规范来自 Chat Home 下的 `interaction-harness/standards/`，
 * 项目专属规范来自该 Long Agent 在该 project 下的 harness 文件。
 *
 * 交互 harness 与 Agent 的 prompt 相关——它本身是一套规则，因此这里只负责读文件，
 * 注入由公共装配完成（不新建注入机制，也不复制多份规范）。
 */
export async function readInteractionHarness(input: {
  readonly chatHome: string;
  readonly longAgentId: string;
  readonly projectId: string | null;
}): Promise<InteractionHarnessSections> {
  const paths = getChatHomePaths(input.chatHome);
  const standardsDir = resolve(paths.root, "interaction-harness", "standards");
  const common: { name: string; text: string }[] = [];
  for (const name of COMMON_STANDARDS) {
    const text = await readIfPresent(resolve(standardsDir, name));
    if (text !== undefined) common.push({ name, text });
  }
  if (input.projectId === null) return { common };
  const projectDir = resolve(paths.root, "long-agents", input.longAgentId, "projects", input.projectId);
  for (const name of PROJECT_STANDARDS) {
    const text = await readIfPresent(resolve(projectDir, name));
    if (text !== undefined) return { common, project: { name, text } };
  }
  return { common };
}

/** 是否有任何可注入内容（避免为空时也写一段壳）。 */
export function hasInteractionHarness(sections: InteractionHarnessSections): boolean {
  return sections.common.length > 0 || sections.project !== undefined;
}

/**
 * 组装成一条可注入的自定义指令，带来源与内容修订号：每轮装配冻结 revision，
 * 记录“这一轮遵守的是哪一版规范”。
 */
export function interactionHarnessInstruction(sections: InteractionHarnessSections): string {
  const parts: string[] = [];
  for (const section of sections.common) parts.push(`## 通用规范 · ${section.name}\n\n${section.text}`);
  if (sections.project !== undefined) parts.push(`## 本项目专属规范 · ${sections.project.name}\n\n${sections.project.text}`);
  const body = parts.join("\n\n---\n\n");
  const revision = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return [
    `<chat_interaction_harness revision="${revision}">`,
    "以下是用户与该项目的交互 harness（协作规范），必须在本次开发中遵守；",
    "新概念先解释、决策先给依据、结论按第一性原理、每轮回填案例与每日记录。",
    "完整资产（飞轮、概念空间、案例、每日记录）位于 Chat Home 的 interaction-harness 目录，可按需读取。",
    "",
    body,
    "</chat_interaction_harness>",
  ].join("\n");
}

/** 仅用于诊断：交互 harness 是否存在（不读取内容）。 */
export function interactionHarnessExists(chatHome: string): boolean {
  const paths = getChatHomePaths(chatHome);
  return existsSync(resolve(paths.root, "interaction-harness"));
}
