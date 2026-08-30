import type { NitroAppPlugin } from "nitro/types";
import { ensureChatRuntimeInitialized } from "../runtime-initialization.js";

/** Every product request waits for the single idempotent control-plane initialization. */
const runtimeInitializationPlugin: NitroAppPlugin = (nitro) => {
  nitro.hooks.hook("request", () => ensureChatRuntimeInitialized());
};

export default runtimeInitializationPlugin;
