import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationDeps } from "@chat/application";
import {
  listPlaneProjectBindingsResponseSchema,
  listPlaneProjectInboundChangesResponseSchema,
} from "@chat/contracts";
import { JsonProductStore } from "@chat/product-store-json";
import { describe, expect, it } from "vitest";
import { createApiApp } from "./app.js";
import { createIdFactory, DEBUG_PRINCIPAL_ID } from "./composition.js";

const NOW = "2026-08-24T14:00:00.000Z";
const PLANE_CLIENT_KEY = `pck_${"a".repeat(32)}`;

async function fixture(options: { readonly configured?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "chat-plane-routes-"));
  const deps: ApplicationDeps = {
    store: await JsonProductStore.open({
      filePath: join(directory, "product-store.json"),
      now: () => NOW,
    }),
    now: () => NOW,
    ids: createIdFactory(),
  };
  return {
    directory,
    deps,
    app: createApiApp({
      traceSink: null,
      product: {
        deps,
        principalId: DEBUG_PRINCIPAL_ID,
        planeEnabled: true,
        ...(options.configured === false ? {} : { planeCoordinationCredential: PLANE_CLIENT_KEY }),
      },
      internalRuntime: { credential: "rtk_runtime_scope_must_not_work" },
    }),
  };
}

describe("Plane项目协调公开路由", () => {
  it("默认产品路由不挂载外部事项Provider或旧项目初始化入口", async () => {
    const f = await fixture();
    try {
      const app = createApiApp({
        traceSink: null,
        product: { deps: f.deps, principalId: DEBUG_PRINCIPAL_ID },
      });
      expect((await app.request("/api/plane-projects/bindings")).status).toBe(404);
      expect((await app.request("/api/project-bootstrap/configuration")).status).toBe(404);
      expect(
        (await app.request("/api/content-production-projects/prj_missing/plane-rollout-dry-run"))
          .status,
      ).toBe(404);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("已挂载状态查询且只接受独立Plane客户端凭据", async () => {
    const f = await fixture();
    try {
      expect((await f.app.request("/api/plane-projects/bindings")).status).toBe(403);
      expect(
        (
          await f.app.request("/api/plane-projects/bindings", {
            headers: { "x-chat-runtime-key": "rtk_runtime_scope_must_not_work" },
          })
        ).status,
      ).toBe(403);
      const response = await f.app.request("/api/plane-projects/bindings", {
        headers: { "x-chat-plane-client-key": PLANE_CLIENT_KEY },
      });
      expect(response.status).toBe(200);
      expect(listPlaneProjectBindingsResponseSchema.parse(await response.json())).toEqual({
        bindings: [],
      });
      const inbound = await f.app.request("/api/plane-projects/inbound-changes", {
        headers: { "x-chat-plane-client-key": PLANE_CLIENT_KEY },
      });
      expect(inbound.status).toBe(200);
      expect(listPlaneProjectInboundChangesResponseSchema.parse(await inbound.json())).toEqual({
        inboundChanges: [],
      });
      expect(
        (await f.app.request("/api/plane-projects/opening-packet?workspaceRootId=root_contentlab"))
          .status,
      ).toBe(403);
      expect(
        (
          await f.app.request(
            "/api/plane-projects/opening-packet?workspaceRootId=root_contentlab&includeResourceContext=false&refreshPlane=true",
            { headers: { "x-chat-plane-client-key": PLANE_CLIENT_KEY } },
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await f.app.request(
            "/api/project-agent/opening-packet?workspaceRootId=root_contentlab&includeResourceContext=false&refreshPlane=true",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await f.app.request(
            "/api/content-production-projects/prj_missing/plane-rollout-dry-run?workspaceRootId=root_contentlab&planeWorkspaceSlug=later&planeProjectIdentifier=CONTENTLAB",
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await f.app.request("/api/plane-projects/adopt", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-chat-plane-client-key": PLANE_CLIENT_KEY,
            },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(404);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

  it("未配置服务端凭据时失败关闭，未知Query严格拒绝", async () => {
    const unconfigured = await fixture({ configured: false });
    const configured = await fixture();
    try {
      expect(
        (
          await unconfigured.app.request("/api/plane-projects/bindings", {
            headers: { "x-chat-plane-client-key": PLANE_CLIENT_KEY },
          })
        ).status,
      ).toBe(503);
      expect(
        (
          await configured.app.request("/api/plane-projects/bindings?unknown=1", {
            headers: { "x-chat-plane-client-key": PLANE_CLIENT_KEY },
          })
        ).status,
      ).toBe(400);
    } finally {
      rmSync(unconfigured.directory, { recursive: true, force: true });
      rmSync(configured.directory, { recursive: true, force: true });
    }
  });
});
