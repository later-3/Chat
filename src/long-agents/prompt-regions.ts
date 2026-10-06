/**
 * Prompt 区域构成：把本轮装配注入的指令段解析成结构化区域清单，
 * 让「检查视图」能按区域回答“这一轮到底装了什么、依据哪一版”。
 *
 * 只做展示与核对，不参与执行；解析失败不抛错，退化为“无名区域 + 原始字符数”。
 */
export interface PromptRegion {
  /** 顶层区域标签名（如 chat_identity、chat_interaction_harness）。 */
  readonly name: string;
  /** 该区域的 revision 属性值（如有），用于回答“依据哪一版”。 */
  readonly revision: string | null;
  readonly characters: number;
}

const OPENING_TAG = /^\s*<([a-z][a-z0-9_]*)/i;
const REVISION = /\brevision="([^"]+)"/;

export function summarizePromptRegions(texts: readonly string[]): PromptRegion[] {
  const regions: PromptRegion[] = [];
  for (const text of texts) {
    if (text.trim() === "") continue;
    const name = OPENING_TAG.exec(text)?.[1] ?? "(unnamed)";
    regions.push({
      name,
      revision: REVISION.exec(text)?.[1] ?? null,
      characters: text.length,
    });
  }
  return regions;
}
