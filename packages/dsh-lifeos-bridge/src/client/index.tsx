import type { ClientContext, SessionId } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { LifeosDock, type LifeosDockInjected } from "./LifeosDock.tsx";
import { LifeosProjectionController } from "./controller.ts";
import { installStyles } from "./styles.ts";

export const name = "chat-dsh-lifeos-bridge-client";
export const inject = ["slots"];

/** Additive Plan/HITL dock; the native ChatView and Composer remain owners. */
export function apply(ctx: ClientContext): void {
  installStyles(ctx);
  const controllers = new Map<SessionId, LifeosProjectionController>();
  const controllerFor = (sessionId: SessionId): LifeosProjectionController => {
    let controller = controllers.get(sessionId);
    if (controller === undefined) {
      controller = new LifeosProjectionController(String(sessionId));
      controllers.set(sessionId, controller);
    }
    return controller;
  };

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
