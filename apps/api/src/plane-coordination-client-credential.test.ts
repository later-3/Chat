import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadPlaneCoordinationClientCredential,
  planeCoordinationClientCredentialPath,
} from "./plane-coordination-client-credential.js";

describe("Plane协调客户端窄凭据", () => {
  it("在配置路径创建0600凭据并稳定复用", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chat-plane-client-key-")));
    try {
      const path = join(root, "private", "plane-client-key");
      const environment = { CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: path };
      const first = await loadPlaneCoordinationClientCredential(root, environment);
      const second = await loadPlaneCoordinationClientCredential(root, environment);
      expect(first).toMatch(/^pck_[A-Za-z0-9-]{16,128}$/u);
      expect(second).toBe(first);
      expect(planeCoordinationClientCredentialPath(root, environment)).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝宽权限和symlink凭据", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chat-plane-client-key-unsafe-")));
    try {
      const path = join(root, "plane-client-key");
      writeFileSync(path, `pck_${"a".repeat(32)}\n`, { mode: 0o600 });
      chmodSync(path, 0o644);
      await expect(
        loadPlaneCoordinationClientCredential(root, {
          CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: path,
        }),
      ).rejects.toThrow(/group\/world/u);
      chmodSync(path, 0o600);
      const link = join(root, "plane-client-link");
      symlinkSync(path, link);
      await expect(
        loadPlaneCoordinationClientCredential(root, {
          CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: link,
        }),
      ).rejects.toThrow(/symlink/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("拒绝相对路径、dot segment和现有父链symlink", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chat-plane-client-path-")));
    try {
      expect(() =>
        planeCoordinationClientCredentialPath(root, {
          CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: ".data/runtime/plane-client-key",
        }),
      ).toThrow(/绝对路径/u);
      expect(() =>
        planeCoordinationClientCredentialPath(root, {
          CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: `${root}/private/../plane-client-key`,
        }),
      ).toThrow(/规范绝对路径/u);

      const actual = join(root, "actual");
      const link = join(root, "linked-parent");
      mkdirSync(actual);
      symlinkSync(actual, link);
      expect(() =>
        planeCoordinationClientCredentialPath(root, {
          CHAT_PLANE_COORDINATION_CLIENT_CREDENTIAL_PATH: join(link, "plane-client-key"),
        }),
      ).toThrow(/symlink/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
