import { z } from "zod";

/**
 * Query分页与修订合同。
 *
 * 不变量：
 * - 列表必须使用服务端Cursor分页；cursor不透明，客户端不得解析或构造。
 * - 单资源响应携带`revision`与`updatedAt`，供命令的乐观并发与缓存失效使用。
 */
export const cursorPageRequestSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const cursorPageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().min(1).optional(),
  });

export const revisionedSchema = <T extends z.ZodType>(resource: T) =>
  z.object({
    resource,
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().min(1),
  });

export type CursorPageRequest = z.infer<typeof cursorPageRequestSchema>;
export type CursorPage<T> = { items: T[]; nextCursor?: string };
export type Revisioned<T> = { resource: T; revision: number; updatedAt: string };
