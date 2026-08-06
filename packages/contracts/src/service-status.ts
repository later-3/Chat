import { z } from "zod";

/** 服务健康检查合同（供Web外壳与运维探针共用）。 */
export const serviceStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
