import { resolveChatHome } from "../chat-home.js";
import { MemoryStoreManager } from "./manager.js";

const managers = new Map<string, MemoryStoreManager>();

export function getMemoryStoreManager(chatHome = resolveChatHome()): MemoryStoreManager {
  const existing = managers.get(chatHome);
  if (existing !== undefined) return existing;
  const manager = new MemoryStoreManager(chatHome);
  managers.set(chatHome, manager);
  return manager;
}
