import { resolve } from "node:path";
import { resolveChatHome } from "./chat-home.js";
import { migrateLegacyProjectLayout } from "./migrations/project-layout-v1.js";

const initializations = new Map<string, Promise<void>>();

/** Initializes the local Chat control plane once before serving requests. */
export function ensureChatRuntimeInitialized(options: {
  readonly projectRoot?: string;
  readonly chatHome?: string;
} = {}): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const chatHome = resolveChatHome(options.chatHome);
  const key = `${chatHome}\0${projectRoot}`;
  const existing = initializations.get(key);
  if (existing !== undefined) return existing;
  const initialized = migrateLegacyProjectLayout({ projectRoot, chatHome })
    .then(() => undefined)
    .catch((error: unknown) => {
      initializations.delete(key);
      throw error;
    });
  initializations.set(key, initialized);
  return initialized;
}
