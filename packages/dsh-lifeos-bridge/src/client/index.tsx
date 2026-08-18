import type { ClientContext, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import { CodeWorkbenchSidebarAction, CodeWorkbenchSurface } from "./CodeWorkbench.tsx";
import { LifeosDock, type LifeosDockInjected } from "./LifeosDock.tsx";
import { WorkflowPicker, type WorkflowPickerInjected } from "./WorkflowPicker.tsx";
import { LifeosProjectionController } from "./controller.ts";
import { installStyles } from "./styles.ts";
import { WorkbenchSurfaceController } from "./workbench-controller.ts";

export const name = "chat-dsh-lifeos-bridge-client";
export const inject = ["slots"];

/** Additive Workflow/Plan/HITL/Workbench surfaces; native ChatView and Composer remain owners. */
export function apply(ctx: ClientContext): void {
  installStyles(ctx);
  const workbench = new WorkbenchSurfaceController();
  const controllers = new Map<SessionId, LifeosProjectionController>();
  const controllerFor = (sessionId: SessionId): LifeosProjectionController => {
    let controller = controllers.get(sessionId);
    if (controller === undefined) {
      controller = new LifeosProjectionController(String(sessionId));
      controllers.set(sessionId, controller);
    }
    return controller;
  };

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
