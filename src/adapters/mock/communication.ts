import type { Troubleshooting } from "../../troubleshooting/application/troubleshooting.js";
import type { Acceptance, VerifiedInbound } from "../../troubleshooting/application/ports.js";
import { MAX_INBOUND_BYTES } from "../../troubleshooting/application/limits.js";

// The synthetic host supplies verified identity; body fields never grant identity or scope.
export class MockPrivateConversation {
  private readonly host: Omit<VerifiedInbound, "input">;

  constructor(private readonly application: Troubleshooting, host: Omit<VerifiedInbound, "input">) {
    this.host = Object.freeze({ eventRef: host.eventRef, principalRef: host.principalRef, tenantRef: host.tenantRef,
      destinationRef: host.destinationRef, conversationKind: host.conversationKind, receivedAt: host.receivedAt });
  }

  async receive(body: Uint8Array): Promise<Acceptance> {
    if (body.byteLength > MAX_INBOUND_BYTES) return { status: "denied", reason: "invalid_request" };
    try {
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["applicationId", "customerId", "question"].includes(key))) {
        return { status: "denied", reason: "invalid_request" };
      }
      return this.application.accept({ ...this.host, input: input as VerifiedInbound["input"] });
    } catch { return { status: "denied", reason: "invalid_request" }; }
  }
}
