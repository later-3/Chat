import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface InlineSourceMap {
  readonly version: number;
  readonly sources: readonly string[];
  readonly sourcesContent?: readonly (string | null)[];
}

const INLINE_SOURCE_MAP_PATTERN =
  /\/\/# sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)/gu;

function decodeInlineSourceMaps(bundle: string, label: string): readonly InlineSourceMap[] {
  const encodedMaps = [...bundle.matchAll(INLINE_SOURCE_MAP_PATTERN)].map((match) => match[1]);
  if (encodedMaps.length === 0) {
    throw new Error(`${label}缺少Workflow Builder内联Source Map`);
  }
  return encodedMaps.map((encoded, index) => {
    if (encoded === undefined) throw new Error(`${label}第${String(index + 1)}个Source Map为空`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch (error) {
      throw new Error(`${label}第${String(index + 1)}个Source Map无法解析`, { cause: error });
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 3 ||
      !Array.isArray((parsed as { sources?: unknown }).sources)
    ) {
      throw new Error(`${label}第${String(index + 1)}个Source Map不符合v3合同`);
    }
    return parsed as InlineSourceMap;
  });
}

function assertEmbeddedSources(
  maps: readonly InlineSourceMap[],
  label: string,
  requiredSources: readonly string[],
): void {
  const containsSource = (sources: readonly string[], required: string): boolean =>
    sources.some((source) => {
      const normalized = source.replaceAll("\\", "/");
      return normalized === required || normalized.endsWith(`/${required}`);
    });
  const map = maps.find((candidate) =>
    requiredSources.every((required) => containsSource(candidate.sources, required)),
  );
  if (map === undefined) {
    throw new Error(`${label}没有覆盖必须可调试的TypeScript源码：${requiredSources.join("、")}`);
  }
  if (
    map.sourcesContent === undefined ||
    map.sourcesContent.length !== map.sources.length ||
    map.sourcesContent.some((content) => content === null)
  ) {
    throw new Error(`${label}必须内嵌完整sourcesContent，避免VS Code退回Bundle断点`);
  }
}

/**
 * Workflow编排在确定性VM中执行，Builder必须把Map内嵌在workflowCode字符串；Step bundle
 * 也使用内联Map。外置`.map`无法随这段字符串进入vm.Script，因此这里只验证真实运行形态，
 * VS Code再通过launch.json把VM中的`src/*`映射回本包TypeScript源码。
 */
export async function assertWorkflowBundleSourceMaps(bundleDir: string): Promise<void> {
  const [workflows, steps] = await Promise.all([
    readFile(join(bundleDir, "workflows.mjs"), "utf8"),
    readFile(join(bundleDir, "steps.mjs"), "utf8"),
  ]);
  assertEmbeddedSources(decodeInlineSourceMaps(workflows, "workflows.mjs"), "workflows.mjs", [
    "src/configurable-planning-workflow.ts",
    "src/planning-execution-workflow.ts",
    "contracts/src/product.ts",
  ]);
  assertEmbeddedSources(decodeInlineSourceMaps(steps, "steps.mjs"), "steps.mjs", [
    "src/workflow-planning-steps.ts",
    "src/workflow-execution-steps.ts",
    "src/workflow-result-steps.ts",
  ]);
}
