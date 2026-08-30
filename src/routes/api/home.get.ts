import { defineEventHandler } from "nitro/h3";
import { openProject } from "../../projects/registry.js";

/** Chat自身也是普通Project；前端默认进入它，但身份来自Registry。 */
export default defineEventHandler(async () => {
  const project = await openProject({ path: process.cwd() });
  return { home: project.cwd, projectId: project.projectId };
});
