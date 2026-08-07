import { z } from "zod";

/** 服务健康检查合同（供Web外壳与运维探针共用）。 */
export const serviceStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
});

/**
 * Readiness合同：区分基础API Ready与真实Provider配置状态。
 * 只报告配置是否存在，永不泄漏凭据本身或长度。
 */
export const readinessStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  provider: z
    .object({
      name: z.literal("bailian"),
      ready: z.boolean(),
    })
    .strict()
    .optional(),
});

export type ServiceStatus = z.infer<typeof serviceStatusSchema>;
export type ReadinessStatus = z.infer<typeof readinessStatusSchema>;
