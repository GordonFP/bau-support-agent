import { z } from "zod/v4";
// Reviewed owned synthetic contract only. No production PSP/G3 mapping is implied.
const id = z.string().min(1).max(1024);
const time = z.iso.datetime().regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
const stage = z.enum(["first", "transaction", "tail_three"]);
const outcome = z.enum(["waiting", "missing", "failed", "timeout", "fallback"]);
export const pspRuleSchema = z.strictObject({ ruleRef: id, stage, outcome, prerequisite: z.enum(["one_passed_shop", "all_shops_passed"]) });
const point = z.strictObject({ status: z.enum(["passed", "failed", "waiting", "missing", "timeout", "unknown"]), eventRef: id.nullable(), observedAt: time.nullable() });
export const pspObservationSchema = z.strictObject({ kind: z.literal("psp_observation"), applicationRef: id, customerRef: id,
  target: z.strictObject({ shopRef: id, bindingRef: id, platformRef: id, pspRef: id, recordRef: id, boundAt: time }),
  first: point, support: z.strictObject({ status: z.enum(["supported", "unsupported", "unknown"]), basis: id.nullable(), version: id.nullable(),
    effectiveAt: time.nullable(), eventRef: id.nullable(), observedAt: time.nullable() }),
  second: z.strictObject({ transaction: point, tailThree: point }),
  final: z.strictObject({ status: z.enum(["controlled", "uncontrolled", "unknown"]), eventRef: id.nullable(), observedAt: time.nullable() }),
  linkedShops: z.array(z.strictObject({ applicationRef: id, customerRef: id, shopRef: id, bindingRef: id,
    status: z.enum(["passed", "not_passed", "unknown"]), eventRef: id.nullable(), observedAt: time.nullable() })).max(100),
  executions: z.array(z.strictObject({ ruleRef: id, stage, outcome, codeCommit: z.string().regex(/^[a-f0-9]{40}$/), eventRef: id, observedAt: time })).max(20).default([]),
});
export const pspTargetsSchema = z.strictObject({ kind: z.literal("psp_target_candidates"), candidates: z.array(z.strictObject({ applicationId: id,
  customerId: id, shopId: id, bindingId: id, boundAt: time })).min(1).max(100) });
