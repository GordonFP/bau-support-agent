import { createHash } from "node:crypto";
import type { DiagnosticReport } from "../domain/simulator.js";
import type { CallContext, InformationQuestion, Ports } from "./ports.js";
import { recordDenial } from "./authorization-audit.js";

export const MAX_MESSAGE_BYTES = 24_576;
export type DeliveryStatus = "delivered" | "unknown" | "failed";
export type DeliveryResult = DeliveryStatus | { readonly status: DeliveryStatus; readonly receiptRef?: string };
export type DeliveryNotice = { readonly kind: "status"; readonly state: "accepted" | "investigating" | "stopped"; readonly caseRef: string } |
  { readonly kind: "question"; readonly caseRef: string; readonly question: InformationQuestion };
export interface DeliveryAttempt {
  readonly caseRef: string;
  readonly phaseId: number;
  readonly segment: number;
  readonly total: number;
  readonly text: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
  readonly current?: () => void;
  readonly beforeWrite: (text?: string) => Promise<void>;
}

function segments(text: string, cap: number): string[] {
  if (!Number.isSafeInteger(cap) || cap < 128 || cap > MAX_MESSAGE_BYTES || Buffer.byteLength(text) > MAX_MESSAGE_BYTES) throw new Error("invalid_request");
  if (Buffer.byteLength(text) <= cap) return [text];
  const chunks: string[] = [];
  let chunk = "", bytes = 0;
  for (const { segment } of new Intl.Segmenter("en", { granularity: "grapheme" }).segment(text)) {
    const size = Buffer.byteLength(segment);
    if (size > cap - 32) throw new Error("invalid_request");
    if (bytes + size > cap - 32) { chunks.push(chunk); chunk = ""; bytes = 0; }
    chunk += segment; bytes += size;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((value, index) => `[${index + 1}/${chunks.length}]\n${value}`);
}

async function dispatch(ports: Ports, context: CallContext, content: DiagnosticReport | DeliveryNotice, deliveryKey: string,
  kind: "report" | "notice", check: () => void): Promise<DeliveryStatus> {
  const safe = ports.sanitization.sanitize(structuredClone(content), context.caseRef);
  if (!ports.sanitization.safe(safe)) throw new Error("unsafe_content");
  const parts = segments(JSON.stringify(safe), ports.delivery.maxTextBytes ?? MAX_MESSAGE_BYTES);
  const action = kind === "report" ? "delivery.send" : "delivery.notice";
  for (const [index, text] of parts.entries()) {
    const current = Object.freeze({ ...context, callId: `${context.callId}:${kind}:${index + 1}` });
    const authorized = async () => {
      if (!await ports.authorization.allows(action, current)) { await recordDenial(ports.audit, current); throw new Error("denied"); }
      check();
      if (context.signal.aborted) throw new Error("cancelled");
      if (ports.clock.now() >= context.deadline) throw new Error("timeout");
    };
    await authorized();
    const delivery = { deliveryKey, segment: index + 1, bindingRef: createHash("sha256").update(JSON.stringify([context.destinationRef, context.caseRef, context.phaseId, text])).digest("hex") };
    await ports.audit.intent(current, action, { delivery });
    const attempt: DeliveryAttempt = Object.freeze({
      caseRef: context.caseRef, phaseId: context.phaseId, segment: index + 1, total: parts.length,
      text, deadline: context.deadline, signal: context.signal,
      current: () => { check(); if (ports.authorization.current?.(action, current) !== true || context.signal.aborted || ports.clock.now() >= context.deadline) throw new Error("denied"); },
      beforeWrite: async (actual = text) => {
        if (actual !== text || !ports.sanitization.safe(text)) throw new Error("unsafe_content");
        await authorized();
      },
    });
    let status: DeliveryStatus;
    let receiptRef: string | undefined;
    let invoked = false;
    try {
      await authorized();
      invoked = true;
      const result = kind === "report" ? await ports.delivery.send(context.destinationRef, safe as DiagnosticReport, deliveryKey, attempt)
        : await ports.delivery.notice!(context.destinationRef, safe as DeliveryNotice, deliveryKey, attempt);
      if (typeof result !== "string" && (!result || typeof result !== "object" || Array.isArray(result) ||
        Object.keys(result).some((key) => !["status", "receiptRef"].includes(key)))) throw new Error("schema_mismatch");
      status = typeof result === "string" ? result : result.status;
      receiptRef = typeof result === "object" ? result.receiptRef : undefined;
      if (!["delivered", "unknown", "failed"].includes(status) || receiptRef !== undefined && (typeof receiptRef !== "string" || !/^[a-f0-9]{64}$/.test(receiptRef))) throw new Error("schema_mismatch");
    } catch (error) {
      const status = invoked ? "unknown" : "failed";
      await ports.audit.complete(current, action, status, { delivery: { ...delivery, status } });
      throw error;
    }
    await ports.audit.complete(current, action, "ok", { delivery: { ...delivery, status, ...(receiptRef ? { receiptRef } : {}) } });
    check();
    if (status !== "delivered") return status;
  }
  return "delivered";
}

export async function sendNotice(ports: Ports, context: CallContext, notice: DeliveryNotice, check: () => void): Promise<DeliveryStatus> {
  if (!ports.delivery.notice) return "delivered";
  const key = notice.kind === "status" ? `${context.caseRef}:status:${context.phaseId}${notice.state === "accepted" ? "" : `:${notice.state}`}` : notice.question.questionId;
  return dispatch(ports, { ...context, callId: `${context.callId}:${key}` }, notice, key, "notice", check);
}
export function sendReport(ports: Ports, context: CallContext, report: DiagnosticReport, check: () => void): Promise<DeliveryStatus> {
  return dispatch(ports, context, report, `${context.caseRef}:report:1`, "report", check);
}
