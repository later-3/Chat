import { realpath } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pi运行工件证据", () => {
  it("Pi Coding Agent直接链接Later Fork稳定分支构建", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "packages/pi-runtime/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies["@earendil-works/pi-agent-core"]).toBe(
      "link:../../../opc-os/pi/packages/agent",
    );
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe(
      "link:../../../opc-os/pi/packages/ai",
    );
    expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe(
      "link:../../../opc-os/pi/packages/coding-agent",
    );

    const installed = await realpath(
      resolve(repoRoot, "packages/pi-runtime/node_modules/@earendil-works/pi-coding-agent"),
    );
    expect(installed).toMatch(/\/opc-os\/pi\/packages\/coding-agent$/u);

    const lock = await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain("link:../../../opc-os/pi/packages/agent");
    expect(lock).toContain("link:../../../opc-os/pi/packages/ai");
    expect(lock).toContain("link:../../../opc-os/pi/packages/coding-agent");
    expect(lock).not.toContain("@earendil-works/pi-coding-agent@0.84.2(patch_hash=");
  });

  it("文档明确记录Later Fork地址、稳定分支与直接链接规则", async () => {
    const evidence = await readFile(
      resolve(repoRoot, "docs/architecture/version-evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("https://github.com/later-3/pi");
    expect(evidence).toContain("codex/later-custom");
    expect(evidence).toContain("providerRequestGate");
    expect(evidence).toContain("不再生成或消费Pi package patch");
  });
});
