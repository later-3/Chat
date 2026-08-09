import type { Hono } from "hono";
import type { RuntimeBuildEvidence, TraceEventInput } from "@chat/contracts";
import type { RuntimeBindingStore } from "./runtime-bindings.js";
import type { WorkflowWorldHandle } from "./workflow-world.js";

export interface WorkflowRuntimeHttpAppInput {
  readonly workflowDataDir: string;
  readonly credential: string;
  readonly bindings: RuntimeBindingStore;
  readonly world: WorkflowWorldHandle;
  readonly buildEvidence: RuntimeBuildEvidence;
  readonly trace: (event: TraceEventInput) => void;
}

export interface WorkflowRuntimeHttpRouteContext extends WorkflowRuntimeHttpAppInput {
  readonly app: Hono;
}
