import assert from "node:assert/strict";
import test from "node:test";

import {
  bindProjectRepository,
  detachProjectRepository,
  listProjectRepositories,
  listRepositoryDirectories,
  listRepositorySnapshots,
  listWorkspaceRoots,
  rebindProjectRepository,
  refreshProjectRepository,
} from "../src/features/harness/repository-api.js";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Repository Feature API只传允许根与相对路径并为每条命令生成独立ID", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/repository-roots")) return jsonResponse({ roots: [] });
    if (url.includes("/directories?")) {
      return jsonResponse({
        root_key: "local-code",
        relative_path: "nested/repo",
        parent_relative_path: "nested",
        current_has_git_marker: true,
        directories: [],
        next_cursor: null,
      });
    }
    if (url.includes("/snapshots?")) {
      return jsonResponse({ snapshots: [], next_cursor: null });
    }
    if (!init?.method) return jsonResponse({ repositories: [] });
    return jsonResponse({
      binding: { id: "binding-1" },
      snapshot: null,
      project_row_version: 2,
    });
  }) as typeof fetch;

  try {
    assert.deepEqual(await listWorkspaceRoots(), []);
    await listRepositoryDirectories({
      rootKey: "root / one",
      relativePath: "nested/repo",
      cursor: "cursor / one",
      limit: 25,
    });
    assert.deepEqual(await listProjectRepositories("project / one"), []);
    await bindProjectRepository({
      projectId: "project / one",
      expectedProjectRowVersion: 1,
      alias: "main",
      displayName: "Chat代码",
      role: "primary",
      rootKey: "local-code",
      relativePath: "nested/repo",
    });
    await refreshProjectRepository({
      bindingId: "binding / one",
      expectedBindingRowVersion: 1,
    });
    await rebindProjectRepository({
      bindingId: "binding / one",
      expectedProjectRowVersion: 2,
      expectedBindingRowVersion: 2,
      displayName: "Chat新代码",
      role: "supporting",
      rootKey: "local-code",
      relativePath: "other/repo",
    });
    await detachProjectRepository({
      bindingId: "binding / one",
      expectedProjectRowVersion: 3,
      expectedBindingRowVersion: 3,
    });
    await listRepositorySnapshots({
      bindingId: "binding / one",
      cursor: "cursor / two",
      limit: 10,
    });

    assert.match(
      requests[1].url,
      /repository-roots\/root%20%2F%20one\/directories\?relative_path=nested%2Frepo&limit=25&cursor=cursor(?:\+|%20)%2F(?:\+|%20)one$/,
    );
    assert.match(requests[2].url, /projects\/project%20%2F%20one\/repositories$/);
    assert.match(requests[4].url, /repositories\/binding%20%2F%20one\/refresh$/);
    assert.match(requests[7].url, /repositories\/binding%20%2F%20one\/snapshots\?/);

    const bodies = requests
      .filter((value) => value.init?.body)
      .map((value) => JSON.parse(String(value.init?.body)));
    assert.equal(
      bodies.some((body) => "absolute_path" in body),
      false,
    );
    assert.deepEqual(
      bodies.map((body) => body.command_id.split(":").slice(0, 2).join(":")),
      [
        "web:repository-bind",
        "web:repository-refresh",
        "web:repository-rebind",
        "web:repository-detach",
      ],
    );
    assert.equal(new Set(bodies.map((body) => body.command_id)).size, 4);
    assert.equal(bodies[0].root_key, "local-code");
    assert.equal(bodies[0].relative_path, "nested/repo");
    assert.equal(bodies[2].relative_path, "other/repo");
    assert.equal(bodies[3].expected_project_row_version, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
