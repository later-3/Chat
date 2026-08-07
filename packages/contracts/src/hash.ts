import { z } from "zod";

/** 共享SHA-256值合同；不携带任何Trace或Runtime语义。 */
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export type Sha256 = z.infer<typeof sha256Schema>;
