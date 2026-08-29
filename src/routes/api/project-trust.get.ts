import { defineEventHandler } from "nitro/h3";

/** 当前项目授权策略不阻止用户向已选择的工作目录发送Prompt。 */
export default defineEventHandler(() => ({ requiresTrust: false, trusted: true }));
