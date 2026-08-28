import { defineEventHandler } from "nitro/h3";

/** 当前最小版本把Chat进程工作目录作为前端默认工作目录。 */
export default defineEventHandler(() => ({ home: process.cwd() }));
