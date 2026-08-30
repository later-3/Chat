import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { appendChatAuditEvent } from "../audit-log.js";
import { ensureChatHome, resolveChatHome } from "../chat-home.js";
import { resolveProjectContext } from "./registry.js";

export async function getProjectTrust(projectId: string, chatHome = resolveChatHome()) {
  const [project, home] = await Promise.all([
    resolveProjectContext(projectId, chatHome),
    ensureChatHome(chatHome),
  ]);
  const store = new ProjectTrustStore(home.agentDir);
  const entry = store.getEntry(project.projectRoot);
  return {
    projectId,
    trusted: entry?.decision === true,
    decision: entry?.decision ?? null,
    inheritedFrom: entry?.path ?? null,
  };
}

export async function setProjectTrust(
  projectId: string,
  trusted: boolean,
  chatHome = resolveChatHome(),
) {
  const [project, home] = await Promise.all([
    resolveProjectContext(projectId, chatHome),
    ensureChatHome(chatHome),
  ]);
  new ProjectTrustStore(home.agentDir).set(project.projectRoot, trusted);
  await appendChatAuditEvent({
    action: "project.trust",
    target: { type: "project", projectId },
    details: { trusted, projectRoot: project.projectRoot },
  }, home.root);
  return getProjectTrust(projectId, chatHome);
}
