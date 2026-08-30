import { createError, defineEventHandler, getQuery } from "nitro/h3";
import { getProjectTrust } from "../../projects/trust.js";

export default defineEventHandler(async (event) => {
  const projectId = getQuery(event).projectId;
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw createError({ statusCode: 400, statusMessage: "缺少projectId" });
  }
  return { requiresTrust: true, ...await getProjectTrust(projectId) };
});
