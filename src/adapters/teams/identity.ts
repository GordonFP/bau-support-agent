import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { TeamsConfiguration, TeamsMapping } from "./host.js";

const id = z.string().min(1).max(256);
export const activitySchema = z.strictObject({
  type: z.literal("message"), id, text: z.string().max(65_536), channelId: z.literal("msteams"), serviceUrl: z.string().max(512),
  from: z.strictObject({ id, aadObjectId: id, name: z.string().max(256).optional() }), recipient: z.strictObject({ id }),
  conversation: z.strictObject({ id, conversationType: z.literal("personal"), tenantId: id }),
  channelData: z.strictObject({ tenant: z.strictObject({ id }) }).optional(), timestamp: z.string().max(64).optional(), replyToId: id.optional(),
});
export type TeamsActivity = z.infer<typeof activitySchema>;
export const informationCommand = z.strictObject({ action: z.literal("provide_information"), caseRef: id, questionId: id,
  content: z.union([z.strictObject({ submittedAt: z.string().max(64), candidateRef: id.optional() }), z.strictObject({ candidateRef: id })]) });
export const cancelCommand = z.strictObject({ action: z.literal("cancel"), caseRef: id });
export const getCommand = z.strictObject({ action: z.literal("get"), caseRef: id });
export const investigateCommand = z.strictObject({ action: z.literal("investigate"), scenario: z.enum(["simulator", "psp"]).optional(), shopId: id.optional(), bindingId: id.optional(), applicationId: id.optional(), customerId: id.optional(), question: z.string().min(1).max(16_384) });
export function mappingFor(activity: TeamsActivity, configuration: TeamsConfiguration): TeamsMapping {
  if (activity.serviceUrl !== configuration.serviceUrl || activity.recipient.id !== configuration.botId ||
    activity.conversation.tenantId !== configuration.tenantId || activity.channelData && activity.channelData.tenant.id !== configuration.tenantId) throw new Error("denied");
  const mapping = configuration.mappings.filter((entry) => entry.tenantId === activity.conversation.tenantId && entry.oid === activity.from.aadObjectId &&
    entry.userId === activity.from.id && entry.conversationId === activity.conversation.id);
  if (mapping.length !== 1) throw new Error("denied");
  return mapping[0]!;
}
export function serviceClaims(headers: Record<string, string | string[]>, issuer: string, audience: string, serviceUrl: string): void {
  // Called only inside the native SDK's authenticated message handler; decoding alone never grants access.
  const token = headers.authorization;
  if (typeof token !== "string" || !token.startsWith("Bearer ")) throw new Error("denied");
  const payload: unknown = JSON.parse(Buffer.from(token.slice(7).split(".")[1] ?? "", "base64url").toString("utf8"));
  if (!payload || typeof payload !== "object") throw new Error("denied");
  const claims = payload as Record<string, unknown>;
  if (claims.iss !== issuer || claims.aud !== audience || claims.serviceurl !== serviceUrl || typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new Error("denied");
}
export function userClaims(payload: unknown, configuration: TeamsConfiguration, mapping: TeamsMapping): void {
  if (!payload || typeof payload !== "object") throw new Error("denied");
  const claims = payload as Record<string, unknown>;
  if (claims.aud !== configuration.user.audience || claims.iss !== configuration.user.issuer || claims.tid !== mapping.tenantId || claims.oid !== mapping.oid ||
    typeof claims.scp !== "string" || !claims.scp.split(" ").includes("access_as_user") || typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000) throw new Error("denied");
}

export const teamsReceiptRef = (mapping: TeamsMapping, id: string) => createHash("sha256").update(JSON.stringify([mapping.actor.destinationRef, id])).digest("hex");
