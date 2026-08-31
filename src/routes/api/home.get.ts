import { homedir } from "node:os";
import { defineEventHandler } from "nitro/h3";

/** Browser display helper only; Project selection comes from the Registry. */
export default defineEventHandler(() => ({ home: homedir() }));
