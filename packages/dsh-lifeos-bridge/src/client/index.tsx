import {
  createSnapshotStore,
  type ClientContext,
  type SessionId,
} from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import { CodeWorkbenchSidebarAction, CodeWorkbenchSurface } from "./CodeWorkbench.tsx";
import { LifeosDock, type LifeosDockInjected } from "./LifeosDock.tsx";
import { WorkflowPicker, type WorkflowPickerInjected } from "./WorkflowPicker.tsx";
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
import {
  ContextInjectionManager,
  type ContextInjectionManagerInjected,
} from "./ContextInjectionManager.tsx";
import { PromptStudio, type PromptStudioInjected } from "./PromptStudio.tsx";
import { PromptStudioController } from "./prompt-studio-controller.ts";
import { installPromptStudioStyles } from "./prompt-studio-styles.ts";

export const name = "chat-dsh-lifeos-bridge-client";
export const inject = ["slots", "conversationEvents"];

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
  const controllers = new Map<SessionId, LifeosProjectionController>();
  const recordControllers = new Map<SessionId, SessionRecordsController>();
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

  ctx.effect(
    () => () => {
      for (const controller of recordControllers.values()) controller.dispose();
      recordControllers.clear();
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

  ctx.slots.inject("conversation.input.left", () => {
    const disposePicker = ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "lifeos-workflow-picker",
        order: 14,
        inject: (sessionId: SessionId): WorkflowPickerInjected => {
          const controller = controllerFor(sessionId);
          return {
            hooks: { lifeos: controller },
            loadWorkflows: () => controller.loadWorkflows(),
            selectWorkflow: (selection) => controller.selectWorkflow(selection),
          };
        },
      },
      WorkflowPicker,
    );
    return disposePicker;
  });

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

  ctx.slots.inject("conversation.input.left", () =>
    ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "lifeos-context-injections",
        order: 15,
        inject: (sessionId: SessionId): ContextInjectionManagerInjected => {
          const controller = controllerFor(sessionId);
          return {
            hooks: { lifeos: controller },
            loadContextInjections: () => controller.loadContextInjections(),
          };
        },
      },
      ContextInjectionManager,
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
