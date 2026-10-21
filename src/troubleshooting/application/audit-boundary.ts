import type { CallContext, Ports } from "./ports.js";

export class AuditBoundary {
  private readonly lost = new Set<string>();
  readonly port: Ports["audit"];

  constructor(raw: Ports["audit"], private readonly onFailure: (context: CallContext, action: string, stage: "intent" | "complete") => void) {
    this.port = {
      intent: async (context, action, details) => {
        this.check(context, action);
        try { return await raw.intent(context, action, details); }
        catch { this.fail(context, action, "intent"); throw new Error("audit_unavailable"); }
      },
      complete: async (context, action, outcome, details) => {
        this.check(context, action);
        try { await raw.complete(context, action, outcome, details); }
        catch { this.fail(context, action, "complete"); throw new Error("audit_unavailable"); }
      },
    };
  }

  deliveryLedger(raw: Ports["deliveryLedger"]): Ports["deliveryLedger"] {
    return {
      begin: async (context, input) => {
        const action = input.kind === "report" ? "delivery.send" : "delivery.notice";
        this.check(context, action);
        try { return await raw.begin(context, input); }
        catch (error) { if (error instanceof Error && error.message === "audit_unavailable") this.fail(context, action, "intent"); throw error; }
      },
      complete: async (context, ticket, result) => {
        const action = ticket.kind === "report" ? "delivery.send" : "delivery.notice";
        this.check(context, action);
        try { await raw.complete(context, ticket, result); }
        catch (error) { if (error instanceof Error && error.message === "audit_unavailable") this.fail(context, action, "complete"); throw error; }
      },
      read: (actor, query) => raw.read(actor, query),
    };
  }

  hasLost(caseRef: string): boolean { return this.lost.has(caseRef); }

  private check(context: CallContext, action: string): void {
    if (this.hasLost(context.caseRef) && action !== "get" && action !== "authorization.denied") throw new Error("audit_unavailable");
  }

  fail(context: CallContext, action: string, stage: "intent" | "complete"): void {
    if (this.lost.has(context.caseRef)) return;
    this.lost.add(context.caseRef);
    this.onFailure(context, action, stage);
  }
}
