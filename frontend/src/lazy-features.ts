import { lazy } from "react";

export const AgentPage = lazy(() =>
  import("./agent-page").then((module) => ({ default: module.AgentPage })),
);
export const HomeView = lazy(() =>
  import("./features/home/home-view").then((module) => ({ default: module.HomeView })),
);
export const WorkspaceView = lazy(() =>
  import("./features/workspace/workspace-view").then((module) => ({
    default: module.WorkspaceView,
  })),
);
export const HarnessWorkbench = lazy(() =>
  import("./harness-workbench").then((module) => ({ default: module.HarnessWorkbench })),
);
export const HitlPage = lazy(() =>
  import("./hitl-page").then((module) => ({ default: module.HitlPage })),
);
export const ProtocolPage = lazy(() =>
  import("./features/protocols/protocol-page").then((module) => ({ default: module.ProtocolPage })),
);
export const ModelCallReview = lazy(() =>
  import("./model-call-review").then((module) => ({ default: module.ModelCallReview })),
);
export const ProductDecisionReview = lazy(() =>
  import("./product-decision-review").then((module) => ({ default: module.ProductDecisionReview })),
);
export const ToolPage = lazy(() =>
  import("./tool-page").then((module) => ({ default: module.ToolPage })),
);
export const WorkflowPage = lazy(() =>
  import("./workflow-page").then((module) => ({ default: module.WorkflowPage })),
);
export const WorkflowRunView = lazy(() =>
  import("./workflow-run-view").then((module) => ({ default: module.WorkflowRunView })),
);
