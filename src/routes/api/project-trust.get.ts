import { defineEventHandler } from "nitro/h3";

/** 最小Workflow尚未实现项目授权流程，因此不阻止用户发送Prompt。 */
export default defineEventHandler(() => ({ requiresTrust: false, trusted: true }));
