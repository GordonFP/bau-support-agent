import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { activitySchema, cancelCommand, getCommand, informationCommand, investigateCommand, mappingFor, serviceClaims, teamsReceiptRef, type TeamsActivity } from "./identity.js";
import { beforeDeadline } from "../../troubleshooting/application/deadline.js";
import { deniedContext, recordDenial } from "../../troubleshooting/application/authorization-audit.js";
import { CLEANUP_MS } from "../../troubleshooting/application/limits.js";
import type { Ports, TrustedActor } from "../../troubleshooting/application/ports.js";
import type { Troubleshooting } from "../../troubleshooting/application/troubleshooting.js";
import { teamsWire } from "./wire.js";
import { TeamsHttp } from "./http.js";
import { dropLogger, isolatedTelemetry } from "./telemetry.js";

export interface TeamsMapping {
  readonly tenantId: string; readonly oid: string; readonly userId: string; readonly conversationId: string; readonly actor: TrustedActor;
}
export interface TeamsConfiguration {
  readonly profile: "local_protocol";
  readonly clientId: string; readonly tenantId: string; readonly botId: string;
  readonly maxActivityBytes?: number;
  readonly serviceUrl: string; readonly tokenUrl: string; readonly serviceMetadataUrl: string;
  readonly user: { readonly audience: string; readonly issuer: string; readonly jwksUrl: string; readonly connectionName: string };
  readonly mappings: readonly TeamsMapping[];
  readonly token: () => Promise<string>;
}
interface InboundLease { activity: TeamsActivity; headers: Record<string, string | string[]>; signal: AbortSignal; receivedAt: string; response?: unknown; mapping?: TeamsMapping; responseGate?: () => void }

export async function createLocalTeamsHost(configuration: TeamsConfiguration, services: { application: Troubleshooting; ports: Ports }) {
  const { token, ...data } = configuration;
  configuration = { ...structuredClone(data), token };
  isolatedTelemetry();
  if (configuration.profile !== "local_protocol" || typeof services.ports.authorization.current !== "function") throw new Error("contract_unverified");
  for (const value of [configuration.serviceUrl, configuration.tokenUrl, configuration.serviceMetadataUrl, configuration.user.jwksUrl]) {
    const url = new URL(value); if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.hash) throw new Error("contract_unverified");
  }
  const { App } = await import("@microsoft/teams.apps");
  const { PUBLIC, withOverrides } = await import("@microsoft/teams.api");
  const current = new AsyncLocalStorage<InboundLease>();
  const http = new TeamsHttp(async (body, headers, signal, route) => {
    const parsed = activitySchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { status: "denied" } };
    const lease: InboundLease = { activity: parsed.data, headers, signal, receivedAt: services.ports.clock.utc() };
    const result = await current.run(lease, () => route({ body: parsed.data, headers })); // Never supply request.token.
    if (lease.response && typeof lease.response === "object" && "caseRef" in lease.response && lease.mapping) {
      try {
        if (!lease.responseGate) {
          if (typeof lease.response.caseRef !== "string") throw new Error("denied");
          const view = await services.application.get(lease.mapping.actor, lease.response.caseRef, async (resourceCurrent) => {
            const identityCurrent = await wire.prove(lease.mapping!, services.ports.clock.now() + 5_000, lease.signal);
            lease.responseGate = () => { identityCurrent(); resourceCurrent(); };
          }, lease.signal);
          if (!("state" in view) || !lease.responseGate) throw new Error("denied");
        }
        lease.responseGate();
      } catch { await deny(lease); }
    }
    return { status: result.status, body: lease.response ?? { status: "denied" } };
  }, services.ports.clock);
  const wire = teamsWire(configuration, services.ports);
  const app = new App({ clientId: configuration.clientId, tenantId: configuration.tenantId, token: configuration.token,
    serviceUrl: configuration.serviceUrl, apiClientSettings: { oauthUrl: configuration.tokenUrl }, logger: dropLogger, httpServerAdapter: http,
    cloud: withOverrides(PUBLIC, { openIdMetadataUrl: configuration.serviceMetadataUrl }),
    client: { logger: dropLogger, timeout: 5_000, middlewares: [wire.middleware], interceptors: [wire.interceptor] }, dangerouslyAllowUnauthenticatedRequests: false,
    telemetry: { agent365: false }, state: false, plugins: [], oauth: { fetchUserToken: false } });
  const { JwtValidator } = await import("@microsoft/teams.apps/dist/middleware/index.js");
  const validator = new JwtValidator({ clientId: configuration.user.audience, tenantId: configuration.tenantId, clockTolerance: 0,
    jwksUriOptions: { type: "uri", uri: configuration.user.jwksUrl }, validateIssuer: { allowedIssuer: configuration.user.issuer }, validateScope: { requiredScope: "access_as_user" } }, dropLogger);
  wire.bind(app, validator);
  Object.assign(services.ports.delivery, wire.delivery);
  const flow = app.addOAuthFlow(configuration.user.connectionName);
  app.on("message", async (context) => {
    const lease = current.getStore();
    if (!lease) throw new Error("denied");
    try {
      serviceClaims(lease.headers, PUBLIC.tokenIssuer, configuration.clientId, configuration.serviceUrl);
      const mapping = mappingFor(lease.activity, configuration); lease.mapping = mapping;
      await wire.prove(mapping, services.ports.clock.now() + 5_000, lease.signal, () => flow.getToken(context));
      if (lease.signal.aborted) throw new Error("denied");
      const raw: unknown = JSON.parse(lease.activity.text);
      const information = informationCommand.safeParse(raw);
      if (information.success) {
        const receiptRef = teamsReceiptRef(mapping, lease.activity.replyToId ?? "");
        const question = wire.questions.get(receiptRef);
        if (!question || question.destinationRef !== mapping.actor.destinationRef || question.caseRef !== information.data.caseRef || question.questionId !== information.data.questionId) throw new Error("denied");
        const result = await services.application.provideInformation({ ...mapping.actor, eventRef: createHash("sha256").update(lease.activity.id).digest("hex"),
          receivedAt: lease.receivedAt, reply: { caseRef: question.caseRef, questionId: question.questionId }, content: information.data.content }, lease.signal);
        lease.response = "view" in result ? { status: result.status, caseRef: result.view.caseRef, phaseId: result.view.phaseId } : { status: "denied" };
        return;
      }
      const cancel = cancelCommand.safeParse(raw);
      if (cancel.success) {
        const view = await services.application.cancel(mapping.actor, cancel.data.caseRef, lease.signal);
        lease.response = "state" in view ? { status: "case", caseRef: view.caseRef, phaseId: view.phaseId, state: view.state, deliveryStatus: view.deliveryStatus } : { status: "denied" };
        return;
      }
      const query = getCommand.safeParse(raw);
      if (query.success) {
        const view = await services.application.get(mapping.actor, query.data.caseRef, async (resourceCurrent) => { const identityCurrent = await wire.prove(mapping, services.ports.clock.now() + 5_000, lease.signal); lease.responseGate = () => { identityCurrent(); resourceCurrent(); }; }, lease.signal);
        lease.response = "state" in view ? { status: "case", caseRef: view.caseRef, phaseId: view.phaseId, state: view.state, deliveryStatus: view.deliveryStatus } : { status: "denied" };
        return;
      }
      const command = investigateCommand.parse(raw);
      const result = await services.application.accept({ ...mapping.actor, conversationKind: "private", receivedAt: lease.receivedAt,
        eventRef: createHash("sha256").update(lease.activity.id).digest("hex"), input: { question: command.question, ...(command.scenario ? { scenario: command.scenario } : {}),
          ...(command.shopId ? { shopId: command.shopId } : {}), ...(command.bindingId ? { bindingId: command.bindingId } : {}),
          ...(command.applicationId ? { applicationId: command.applicationId } : {}), ...(command.customerId ? { customerId: command.customerId } : {}) } });
      lease.response = "view" in result ? { status: result.status, caseRef: result.view.caseRef, phaseId: result.view.phaseId } : { status: "denied" };
    } catch { await deny(lease); }
  });
  let closing: Promise<void> | undefined;
  let closeDeadline = 0;
  let closed = false;
  const closeRaw = () => {
    if (closing) return closing;
    closeDeadline = services.ports.clock.now() + CLEANUP_MS;
    closing = (async () => {
      const results = await Promise.allSettled([wire.close(), http.stop(), app.stop(), services.application.close()]);
      if (results.some((result) => result.status === "rejected")) throw new Error("unavailable");
      closed = true;
    })();
    void closing.catch(() => {});
    return closing;
  };
  const deny = async (lease: InboundLease) => {
    lease.response = { status: "denied" };
    try { await recordDenial(services.ports.audit, deniedContext(lease.mapping?.actor, "unresolved", services.ports)); }
    catch { void closeRaw(); } // Never await the host close from a request that its raw close must drain.
  };
  services.ports.retention?.onClose(closeRaw);
  return { get url() { return http.url; }, async start() { await app.start(0); void http.url; },
    async stop(): Promise<"closed" | "unknown"> {
      const operation = closeRaw();
      if (closed) return "closed";
      try { await beforeDeadline(services.ports.clock, closeDeadline, () => operation); return "closed"; } catch { return "unknown"; }
    },
  };
}
