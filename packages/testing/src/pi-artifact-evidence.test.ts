import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pi运行工件证据", () => {
  it("package与pnpm锁文件共同固定审核过的npm 0.82.1工件", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "packages/pi-runtime/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies["@earendil-works/pi-agent-core"]).toBe("0.82.1");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("0.82.1");

    const lock = await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain(
      "sha512-Z3kloziJIE2dmrisRckZX8zDca/gIv9/YdFAzeoqpHiLV2wsni6bL4hInNSjVKLbqT+4kqLIkph2JQLKvSepjg==",
    );
    expect(lock).toContain(
      "sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==",
    );
  });

  it("文档明确区分能力对照提交与实际运行工件", async () => {
    const evidence = await readFile(
      resolve(repoRoot, "docs/architecture/version-evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("10e99ae9914cd34f622633fac42f9a90714e9cf4");
    expect(evidence).toContain("b4f293684bba718d59cc1157679bcf6157b3a7f5");
    expect(evidence).toContain("它不是运行时依赖来源");
  });
});
