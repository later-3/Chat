import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("pi运行工件证据", () => {
  it("package与pnpm锁文件共同固定审核过的npm 0.84.2工件", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repoRoot, "packages/pi-runtime/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies["@earendil-works/pi-agent-core"]).toBe("0.84.2");
    expect(packageJson.dependencies["@earendil-works/pi-ai"]).toBe("0.84.2");
    expect(packageJson.dependencies["@earendil-works/pi-coding-agent"]).toBe("0.84.2");

    const lock = await readFile(resolve(repoRoot, "pnpm-lock.yaml"), "utf8");
    expect(lock).toContain(
      "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
    );
    expect(lock).toContain(
      "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
    );
    expect(lock).toContain(
      "sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==",
    );
  });

  it("文档明确记录later-3受管分支与固定补丁的过渡运行方式", async () => {
    const evidence = await readFile(
      resolve(repoRoot, "docs/architecture/version-evidence.md"),
      "utf8",
    );
    expect(evidence).toContain("1f2b9ff53c0adefff454f02bdcf60aeaf4d28684");
    expect(evidence).toContain("a6e2c157c8ce5c225d64a9779c233d90fc28b942");
    expect(evidence).toContain("https://github.com/later-3/pi");
    expect(evidence).toContain("providerRequestGate");
    expect(evidence).toContain("受管分支正式发布固定npm Artifact前的过渡消费方式");
  });
});
