import { pspObservationSchema } from "../mcp/psp-schema.js";
import { pspEvents } from "../../troubleshooting/domain/psp.js";
import { z } from "zod/v4";
import { McpFailure } from "../mcp/failure.js";
const text = z.string().min(1).max(1024);
const date = z.iso.date();
// This reviewed synthetic mapping supports UTC seconds/milliseconds. Reject
// finer source precision rather than truncate instants during ordering/scope checks.
const time = z.iso.datetime().regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);
export const validLogTimestamp = (value: unknown): value is string => time.safeParse(value).success;
const source = z.strictObject({ event_id: text, event_time: time, application_id: text, customer_id: text,
  submitted_at: time, business_timezone: z.string().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }),
  submitted_shops: z.array(z.strictObject({ shop_id: text, authorization: z.enum(["active", "cancelled", "unknown"]),
    coverage_start: date.nullable(), coverage_through: date.nullable(), continuous_coverage: z.boolean() })).max(100),
});
const page = z.strictObject({ took: z.number().finite().nonnegative(), total: z.union([z.number().int().nonnegative(),
  z.strictObject({ value: z.number().int().nonnegative(), relation: z.enum(["eq", "gte"]) })]),
  hits: z.array(z.strictObject({ _id: text, _index: text, _score: z.number().finite().nullable(), _source: source })).max(100) });
export type NativePage = z.infer<typeof page>;
export function parseNative(value: unknown): NativePage {
  const result = page.safeParse(value);
  if (!result.success) throw new McpFailure("schema_mismatch");
  if (result.data.hits.some(({ _source: row }) => new Set(row.submitted_shops.map((shop) => shop.shop_id)).size !== row.submitted_shops.length ||
    row.submitted_shops.some((shop) => shop.coverage_start && shop.coverage_through && shop.coverage_start > shop.coverage_through))) throw new McpFailure("schema_mismatch");
  return result.data;
}
export function businessDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  return [parts.find((part) => part.type === "year")!.value, parts.find((part) => part.type === "month")!.value, parts.find((part) => part.type === "day")!.value].join("-");
}

// Separate owned PSP snapshot rows. Native completeness is still unknown.
const pspSource = z.strictObject({ event_id: text, event_time: time, application_id: text, customer_id: text,
  shop_id: text, binding_id: text, verification: pspObservationSchema });
const pspPage = page.extend({ hits: z.array(z.strictObject({ _id: text, _index: text, _score: z.number().finite().nullable(), _source: pspSource })).max(100) });
export function parsePspNative(value: unknown) {
  const result = pspPage.safeParse(value);
  if (!result.success || result.data.hits.some(({ _source: row }) => row.application_id !== row.verification.applicationRef || row.customer_id !== row.verification.customerRef ||
    row.shop_id !== row.verification.target.shopRef || row.binding_id !== row.verification.target.bindingRef ||
    !pspEvents(row.verification).some((event) => event.eventRef === row.event_id && event.observedAt === row.event_time))) throw new McpFailure("schema_mismatch");
  return result.data;
}
