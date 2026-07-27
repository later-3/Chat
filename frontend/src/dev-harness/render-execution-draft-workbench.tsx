/**
 * Dev-only harness entry for real-component layout tests.
 *
 * Playwright loads this module from the Vite dev server so the *actual*
 * ExecutionDraftWorkbench component (not a hand-built DOM twin) renders with
 * intercepted API responses.  Nothing in production imports this entry.
 */

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { ExecutionDraftWorkbench } from "../execution-draft-workbench";

declare global {
  interface Window {
    __WORKBENCH_HARNESS__?: { draftId: string };
  }
}

const props = window.__WORKBENCH_HARNESS__ ?? { draftId: "harness-draft" };
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("harness root missing");

createRoot(rootElement).render(
  createElement(ExecutionDraftWorkbench, {
    draftId: props.draftId,
    busy: false,
    onReapprove: () => {},
  }),
);
