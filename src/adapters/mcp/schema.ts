import { McpFailure } from "./failure.js";
import { z } from "zod/v4";
import { EVIDENCE_SCHEMA } from "./manifest.js";
const string = z.string().min(1);
const date = z.iso.date();
const time = z.iso.datetime();
export function validTimestamp(value: unknown): value is string { return time.safeParse(value).success; }
const complete = z.enum(["complete", "partial", "unknown"]);
const observation = z.strictObject({ applicationRef: string, submittedOn: date,
  shops: z.array(z.strictObject({ shopRef: string, authorization: z.enum(["active", "cancelled", "unknown"]),
    completeThrough: date.nullable(), coverageComplete: z.boolean() })).max(100),
  calculation: z.strictObject({ started: z.boolean().nullable(), succeeded: z.boolean().nullable(), estimate: string.nullable() }),
  causes: z.array(z.strictObject({ statement: string, kind: z.enum(["rate_limited", "authorization_cancelled", "program_error"]) })).max(20),
});
const candidates = z.strictObject({ kind: z.literal("application_candidates"), customerRef: string,
  candidates: z.array(z.strictObject({ applicationId: string, submittedAt: time })).max(100) });
const evidence = z.strictObject({ sourceRef: string, kind: z.enum(["log", "code"]), locator: string,
  observedAt: time.nullable(), acquiredAt: time, completeness: complete, truncated: z.boolean(),
  targetRef: string, text: string,
  log: z.strictObject({ from: time, to: time, queryRef: string }).optional(),
  code: z.strictObject({ repositoryRef: string, branch: z.enum(["main", "master"]), commit: z.string().regex(/^[a-f0-9]{40}$/),
    snapshotRef: string, indexedAt: time, receiptRef: string }).optional(),
}).transform(({ log, code, ...item }) => ({ ...item, ...(log ? { log } : {}), ...(code ? { code } : {}) }));
const schema = z.strictObject({ schemaVersion: z.literal(EVIDENCE_SCHEMA), value: z.union([observation, candidates, z.null()]),
  evidence: z.array(evidence).max(100), completeness: complete, truncated: z.boolean(), warnings: z.array(string).max(32),
  nextCursor: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
});
export type Payload = z.infer<typeof schema>;
export function parsePayload(value: unknown): Payload {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new McpFailure("schema_mismatch");
  return parsed.data;
}
