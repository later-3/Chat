import type { NitroAppPlugin } from "nitro/types";
import { ensureChatRuntimeInitialized } from "../runtime-initialization.js";
import { recoverInterruptedLocalRuns } from "../workflows/local-run-recovery.js";

/** Every product request waits for the single idempotent control-plane initialization. */
const runtimeInitializationPlugin: NitroAppPlugin = (nitro) => {
  nitro.hooks.hook("request", async () => {
    await recoverInterruptedLocalRuns();
    await ensureChatRuntimeInitialized();
  });
};

export default runtimeInitializationPlugin;
