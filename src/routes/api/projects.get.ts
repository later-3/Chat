import { defineEventHandler } from "nitro/h3";
import { listProjects } from "../../projects/registry.js";

export default defineEventHandler(async () => ({ projects: await listProjects() }));
