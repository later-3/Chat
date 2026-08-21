import {
  createSnapshotStore,
  type ClientContext,
  type ISessions,
  type SessionId,
} from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { CodeWorkbenchSidebarAction, CodeWorkbenchSurface } from "./CodeWorkbench.tsx";
import { LifeosDock, type LifeosDockInjected } from "./LifeosDock.tsx";
import { LifeosProjectionController } from "./controller.ts";
import { installStyles } from "./styles.ts";
import {
  TraceTimestampToggle,
  type TraceTimestampToggleInjected,
} from "./TraceTimestampToggle.tsx";
import { WorkbenchSurfaceController } from "./workbench-controller.ts";
import { ExecutionTraceProjection } from "./execution-trace-projection.ts";
import { SessionRecordsController } from "./session-records-controller.ts";
import { SessionRecordsView, type SessionRecordsInjected } from "./SessionRecordsView.tsx";
import { PromptStudio, type PromptStudioInjected } from "./PromptStudio.tsx";
import { PromptStudioController } from "./prompt-studio-controller.ts";
import { installPromptStudioStyles } from "./prompt-studio-styles.ts";
import { PromptComposerController } from "./prompt-composer-controller.ts";
import { PromptControlBar, type PromptControlBarInjected } from "./PromptControlBar.tsx";
import {
  ProjectBootstrapSidebarAction,
  type ProjectBootstrapSidebarInjected,
} from "./ProjectBootstrapSidebarAction.tsx";
import { projectBootstrapPresetSchema } from "../contracts.ts";

export const name = "chat-dsh-lifeos-bridge-client";
// Cordis只允许读取显式注入的Service。项目建项入口同时操作公开Sessions与Workspaces
// face，因此必须把两者声明为启动依赖；遗漏时静态类型仍可通过，但浏览器会在apply阶段失败。
export const inject = ["slots", "conversationEvents", "sessions", "workspaces"];

/** Additive Workflow/Plan/HITL/Workbench surfaces; native ChatView and Composer remain owners. */
export function apply(ctx: ClientContext): void {
  installStyles(ctx);
  installPromptStudioStyles(ctx);
  const traceTimestamps = createSnapshotStore(false, {
    persist: { name: "chat.lifeos.trace-timestamps.v1" },
  });
  const executionTraces = new ExecutionTraceProjection(ctx, {
    showTimestamps: traceTimestamps.getSnapshot(),
  });
  ctx.effect(() => {
    const unsubscribe = traceTimestamps.subscribe(() => {
      executionTraces.setOptions({
        showTimestamps: traceTimestamps.getSnapshot(),
      });
    });
    return () => {
      unsubscribe();
      executionTraces.dispose();
    };
  }, "lifeos bridge: execution trace trajectory");
  const workbench = new WorkbenchSurfaceController();
  const promptStudio = new PromptStudioController();
  // `@deepseek-ai/dsh-session`与浏览器Runtime都扩展Cordis的`sessions`键；此处运行在
  // Client插件根，真实对象是公开ISessions face，显式收窄避免服务端类型声明污染。
  const clientSessions = ctx.sessions as unknown as ISessions;
  const startProjectBootstrap = async (): Promise<void> => {
    const presetResponse = await fetch("/lifeos/project-bootstrap/preset", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    const presetJson = (await presetResponse.json()) as unknown;
    if (!presetResponse.ok) throw new Error("项目初始化配置不可用");
    const preset = projectBootstrapPresetSchema.parse(presetJson);
    if (!preset.enabled) throw new Error("当前部署未配置Plane CE项目初始化能力");
    // DSH会复用当前Workspace里的空白Session。若用户已经停在那个空白Session，单纯比较
    // current前后无法知道`startSession()`已完成。先通过公开Sessions face清除选择，再启动
    // New Session flow，使新目标必然从undefined变为精确Session ID；这不归档或删除旧会话。
    clientSessions.clear();
    ctx.workspaces.startSession();
    const sessionId = await new Promise<SessionId>((resolve, reject) => {
      let settled = false;
      const finish = (value: SessionId): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        clearTimeout(timeout);
        resolve(value);
      };
      const inspect = (): void => {
        const current = clientSessions.list.getSnapshot().current;
        if (current !== undefined) finish(current);
      };
      const unsubscribe = clientSessions.list.subscribe(inspect);
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(new Error("DSH未能创建新的项目会话"));
      }, 8_000);
      inspect();
    });
    const initialized = await fetch(
      `/lifeos/project-bootstrap/sessions/${encodeURIComponent(String(sessionId))}/initialize`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      },
    );
    if (!initialized.ok) throw new Error("项目会话预设初始化失败");
    clientSessions.open(sessionId);
  };
  const controllers = new Map<SessionId, LifeosProjectionController>();
  const recordControllers = new Map<SessionId, SessionRecordsController>();
  const promptComposerControllers = new Map<SessionId, PromptComposerController>();
  const controllerFor = (sessionId: SessionId): LifeosProjectionController => {
    let controller = controllers.get(sessionId);
    if (controller === undefined) {
      controller = new LifeosProjectionController(String(sessionId), undefined, (traces) => {
        if (traces.length === 0) executionTraces.remove(String(sessionId));
        else executionTraces.replace(String(sessionId), traces);
      });
      controllers.set(sessionId, controller);
    }
    return controller;
  };
  const recordsFor = (sessionId: SessionId): SessionRecordsController => {
    let controller = recordControllers.get(sessionId);
    if (controller === undefined) {
      controller = new SessionRecordsController(String(sessionId));
      recordControllers.set(sessionId, controller);
    }
    return controller;
  };
  const promptComposerFor = (sessionId: SessionId): PromptComposerController => {
    let controller = promptComposerControllers.get(sessionId);
    if (controller === undefined) {
      controller = new PromptComposerController(String(sessionId));
      promptComposerControllers.set(sessionId, controller);
    }
    return controller;
  };

  ctx.effect(
    () => () => {
      for (const controller of recordControllers.values()) controller.dispose();
      recordControllers.clear();
      for (const controller of promptComposerControllers.values()) controller.dispose();
      promptComposerControllers.clear();
    },
    "lifeos bridge: session records controllers",
  );

  ctx.effect(() => () => promptStudio.dispose(), "lifeos bridge: prompt studio controller");

  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: "lifeos-prompts",
        order: 30,
        label: "提示词",
        inject: (): PromptStudioInjected => ({
          hooks: { promptStudio },
          refresh: () => promptStudio.refresh(),
          select: (promptFragmentId) => promptStudio.select(promptFragmentId),
          closeDetail: () => promptStudio.closeDetail(),
          viewRevision: (promptFragmentRevisionId) =>
            promptStudio.viewRevision(promptFragmentRevisionId),
          create: (payload) => promptStudio.create(payload),
          copy: (payload) => promptStudio.copy(payload),
          revise: (payload) => promptStudio.revise(payload),
          archive: (payload) => promptStudio.archive(payload),
          openSourceFile: (relativePath, openerId) =>
            promptStudio.openSourceFile(relativePath, openerId),
        }),
      },
      PromptStudio,
    ),
  );

  ctx.slots.inject("conversation.view", () =>
    ctx.slots.register(
      {
        name: "conversation.view",
        id: "lifeos-session-records",
        order: 20,
        label: () => "会话记录",
        inject: (sessionId: SessionId): SessionRecordsInjected => {
          const controller = recordsFor(sessionId);
          return {
            hooks: { sessionRecords: controller },
            refresh: () => controller.refresh(),
            loadMoreChat: () => controller.loadMoreChat(),
            loadMoreDsh: () => controller.loadMoreDsh(),
          };
        },
      },
      SessionRecordsView,
    ),
  );

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "lifeos-project-bootstrap",
        order: 20,
        inject: (): ProjectBootstrapSidebarInjected => ({ startProjectBootstrap }),
      },
      ProjectBootstrapSidebarAction,
    ),
  );

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "lifeos-code-workbench",
        order: 30,
        inject: () => ({ workbench }),
      },
      CodeWorkbenchSidebarAction,
    ),
  );

  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "lifeos-code-workbench-surface",
        order: 30,
        inject: () => ({ workbench }),
      },
      CodeWorkbenchSurface,
    ),
  );

  ctx.slots.inject("conversation.session.header.utilities", () =>
    ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "lifeos-trace-timestamps",
        order: 20,
        inject: (): TraceTimestampToggleInjected => ({
          hooks: { traceTimestamps },
          setTraceTimestamps: (visible) => traceTimestamps.set(visible),
        }),
      },
      TraceTimestampToggle,
    ),
  );

  ctx.slots.inject("conversation.input.dock", () =>
    ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "lifeos-prompt-control-bar",
        order: 14,
        inject: (sessionId: SessionId): PromptControlBarInjected => {
          const controller = promptComposerFor(sessionId);
          const lifeos = controllerFor(sessionId);
          return {
            hooks: { lifeos, promptComposer: controller, promptStudio },
            loadWorkflows: () => lifeos.loadWorkflows(),
            selectWorkflow: (selection) => lifeos.selectWorkflow(selection),
            loadContextInjections: () => lifeos.loadContextInjections(),
            setDshSendReviewEnabled: (enabled) => lifeos.setDshSendReviewEnabled(enabled),
            setBridgeDispatchReviewEnabled: (enabled) =>
              lifeos.setBridgeDispatchReviewEnabled(enabled),
            load: async () => {
              await Promise.all([controller.load(), promptStudio.refresh()]);
            },
            setMode: (regionKey, mode) => controller.setMode(regionKey, mode),
            toggleRevision: (fragment) => controller.toggleRevision(fragment),
            reset: () => controller.reset(),
            previewConfiguration: () => controller.previewConfiguration(),
            previewBridgeSend: (text) => controller.previewBridgeSend(text),
            clearPreviews: () => controller.clearPreviews(),
            refresh: () => promptStudio.refresh(),
            select: (promptFragmentId) => promptStudio.select(promptFragmentId),
            closeDetail: () => promptStudio.closeDetail(),
            viewRevision: (promptFragmentRevisionId) =>
              promptStudio.viewRevision(promptFragmentRevisionId),
            create: async (payload) => {
              await promptStudio.create(payload);
              await controller.load();
            },
            copy: async (payload) => {
              await promptStudio.copy(payload);
              await controller.load();
            },
            revise: async (payload) => {
              await promptStudio.revise(payload);
              await controller.load();
            },
            archive: async (payload) => {
              await promptStudio.archive(payload);
              await controller.load();
            },
            openSourceFile: (relativePath, openerId) =>
              promptStudio.openSourceFile(relativePath, openerId),
          };
        },
      },
      PromptControlBar,
    ),
  );

  ctx.slots.inject("conversation.input.dock", () => {
    const dispose = ctx.slots.register(
      {
        name: "conversation.input.dock",
        id: "lifeos-plan",
        order: 15,
        inject: (sessionId: SessionId): LifeosDockInjected => {
          const controller = controllerFor(sessionId);
          return {
            hooks: { lifeos: controller },
            decide: (request) => controller.decide(request),
            decideNote: (request) => controller.decideNote(request),
            decidePromptReview: (request) => controller.decidePromptReview(request),
            decideProjectBootstrap: (request) => controller.decideProjectBootstrap(request),
            openProjectWorkspace: async (cwd) => {
              const workspace = await ctx.workspaces.create({ path: cwd });
              const sessionId = await ctx.workspaces.connectWorkspace(workspace.workspaceId);
              clientSessions.open(sessionId);
            },
            openPlaneProject: (url) => {
              window.open(url, "_blank", "noopener,noreferrer");
            },
            decideDshSendReview: (request) => controller.decideDshSendReview(request),
            decideBridgeDispatchReview: (request) => controller.decideBridgeDispatchReview(request),
          };
        },
      },
      LifeosDock,
    );
    return () => {
      dispose();
      for (const controller of controllers.values()) controller.dispose();
      controllers.clear();
    };
  });
}
