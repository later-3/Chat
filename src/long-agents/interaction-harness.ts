import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getChatHomePaths } from "../chat-home.js";

/** 通用规范的固定读取顺序（需求 → 前端 → 开发 → 任务 → 维护）；只读存在的文件。 */
const COMMON_STANDARDS = ["需求规范.md", "前端规范.md", "开发规范.md", "task规范.md", "测试规范.md", "维护规范.md"] as const;
/**
 * 必须全文注入的 harness 资产：本层指引（AGENTS.md）、案例（正例与反例）、飞轮（积累）、
 * 概念空间的元规则与索引（概念正文按需读取）。
 * 案例与飞轮是“量变引起质变”的来源，每次交互都要先读；与规范同等重要，因此一起注入。
 */
const HARNESS_ASSETS = [
  "AGENTS.md", "cases.md", "flywheel.md",
  // 概念空间：注入元规则与两级索引（都很短）；概念正文按需读取，不占用每轮上下文。
  "concept-space.md", "concept-space/00-索引.md", "concept-space/harness/00-索引.md",
] as const;
/** 某个 Long Agent 在某个 project 下的专属指引/规范（文件名一律英文）。 */
const PROJECT_STANDARDS = [
  "project-guidance.md", "AGENTS.md",
  // 项目层概念索引：项目层可以有概念正文（一概念一正文），其索引同样要在每轮可见，正文按需读取。
  "concept-space/00-索引.md",
] as const;

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
  /** 通用规范（standards/ 下按固定顺序）。 */
  readonly common: readonly { readonly name: string; readonly text: string }[];
  /** 必须全文注入的资产（案例、飞轮）。 */
  readonly assets: readonly { readonly name: string; readonly text: string }[];
  /** 该 Long Agent 在该 project 下的专属文件（可多个：project-guidance.md、AGENTS.md）。 */
  readonly projects: readonly { readonly name: string; readonly text: string }[];
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
  const harnessDir = resolve(paths.root, "interaction-harness");
  const standardsDir = resolve(harnessDir, "standards");
  const common: { name: string; text: string }[] = [];
  for (const name of COMMON_STANDARDS) {
    const text = await readIfPresent(resolve(standardsDir, name));
    if (text !== undefined) common.push({ name, text });
  }
  const assets: { name: string; text: string }[] = [];
  for (const name of HARNESS_ASSETS) {
    const text = await readIfPresent(resolve(harnessDir, name));
    if (text !== undefined) assets.push({ name, text });
  }
  if (input.projectId === null) return { common, assets, projects: [] };
  const projectDir = resolve(paths.root, "long-agents", input.longAgentId, "projects", input.projectId);
  const projects: { name: string; text: string }[] = [];
  // 收集全部存在的项目专属文件：早退会漏掉后面的文件（如 AGENTS.md 被 project-guidance.md 挡掉）。
  for (const name of PROJECT_STANDARDS) {
    const text = await readIfPresent(resolve(projectDir, name));
    if (text !== undefined) projects.push({ name, text });
  }
  return { common, assets, projects };
}

/** 是否有任何可注入内容（避免为空时也写一段壳）。 */
export function hasInteractionHarness(sections: InteractionHarnessSections): boolean {
  return sections.common.length > 0 || sections.assets.length > 0 || sections.projects.length > 0;
}

/**
 * 组装成一条可注入的自定义指令，带来源与内容修订号：每轮装配冻结 revision，
 * 记录“这一轮遵守的是哪一版规范”。
 */
export function interactionHarnessInstruction(sections: InteractionHarnessSections): string {
  const parts: string[] = [];
  for (const section of sections.common) parts.push(`## 通用规范 · ${section.name}\n\n${section.text}`);
  for (const asset of sections.assets) parts.push(`## 通用资产 · ${asset.name}\n\n${asset.text}`);
  for (const project of sections.projects) {
    parts.push(`## 本项目专属规范 · ${project.name}\n\n${project.text}`);
  }
  const body = parts.join("\n\n---\n\n");
  const revision = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  return [
    `<chat_interaction_harness revision="${revision}">`,
    "以下是用户与该项目的交互 harness（协作规范 + 案例 + 概念索引），必须在本次开发中遵守；",
    "**动手前先读反例与正例**：正例照做，反例不得重犯；新概念先解释、决策先给依据、结论按第一性原理。",
    "每轮结束后回填案例（正例/反例）与每日记录；需要某个概念的完整解释时，按概念索引读取对应正文。",
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
