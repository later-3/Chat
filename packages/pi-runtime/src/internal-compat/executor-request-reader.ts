import { z } from "zod";
import {
  startPiExecutorOperationRequestSchema as currentStartPiExecutorOperationRequestSchema,
  type StartPiExecutorOperationRequest,
} from "../executor-service-contract.js";
import { startPiExecutorOperationRequestSchema as legacyStartPiExecutorOperationRequestSchema } from "./executor-request-v1.js";

/** 读旧/写当前共用入口；类型仍只向调用方公开当前私有协议。 */
export const startPiExecutorOperationRequestSchema = z.union([
  legacyStartPiExecutorOperationRequestSchema,
  currentStartPiExecutorOperationRequestSchema,
]) as unknown as z.ZodType<StartPiExecutorOperationRequest>;
