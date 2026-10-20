import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallContext, Ports, SafeReason } from "../../troubleshooting/application/ports.js";
import { beforeDeadline } from "../../troubleshooting/application/deadline.js";
import { MAX_ACTIVE_CASES } from "../../troubleshooting/application/limits.js";
import { BoundedStdio, type StdioEndpoint } from "./stdio.js";
import { CASE_EVIDENCE_BYTES, FRAGMENT_BYTES } from "./manifest.js";
import { McpFailure } from "./failure.js";

export interface OwnedMcpEndpoint extends StdioEndpoint {
  // Host-owned process/container cleanup, never serialized or supplied by a tool.
  // It must include any already pending creation, then confirm the whole resource ended.
  readonly close?: () => Promise<void>;
}
export interface McpOperation {
  readonly context: CallContext;
  connect(): Promise<{ serverInfo: ReturnType<Client["getServerVersion"]>; capabilities: ReturnType<Client["getServerCapabilities"]>;
    protocolVersion: string | undefined; instructions: string | undefined }>;
  listTools(): ReturnType<Client["listTools"]>;
  callTool(name: string, args: Readonly<Record<string, unknown>>): ReturnType<Client["callTool"]>;
  current(): void;
  sanitize<T>(value: T): T;
}
interface CaseScope { bytes: number; phaseId: number; closed: boolean; readonly authority: string }
interface OwnedOperation {
  readonly context: CallContext;
  readonly scope: CaseScope;
  readonly controller: AbortController;
  readonly transport: BoundedStdio;
  readonly settled: Promise<void>;
  close(): Promise<void>;
}
const CONNECTIONS_PER_CASE = 2;
const safeReason = (error: unknown): SafeReason => error instanceof McpFailure ? error.reason : "unavailable";
const authority = (context: CallContext) => JSON.stringify([context.principalRef, context.tenantRef, context.destinationRef,
  context.policyVersion, context.approvalRef, context.snapshotRef, context.budgetRef, [...context.resourceRefs].sort()]);

// One host-owned instance is shared by every real log/code adapter in an application.
// Profiles retain their own exact manifest, arguments, result parser and reliable audits.
export class McpBoundary {
  readonly sanitization: Ports["sanitization"];
  private readonly original: Ports["sanitization"];
  private readonly cases = new Map<string, CaseScope>();
  private readonly sanitizedCases = new Set<string>();
  private readonly operations = new Map<string, Set<OwnedOperation>>();
  private readonly contexts = new WeakMap<CallContext, OwnedOperation>();
  private readonly flights = new Set<string>();
  private readonly clearHandlers = new Set<(caseRef: string) => void>();
  private readonly failedClears = new Map<string, { handlers: Set<(caseRef: string) => void>; original: boolean }>();

  constructor(private readonly ports: Pick<Ports, "clock" | "retention" | "sanitization">) {
    this.original = ports.sanitization;
    this.sanitization = { sanitize: (value, caseRef) => {
      if (!this.ownsCase(caseRef) && this.caseCount() >= MAX_ACTIVE_CASES) throw new McpFailure("unavailable");
      this.sanitizedCases.add(caseRef);
      return this.original.sanitize(value, caseRef);
    }, safe: (value) => this.original.safe(value), clear: (caseRef) => this.clear(caseRef) };
    ports.retention?.onClose(async () => {
      for (const key of new Set([...this.cases.keys(), ...this.sanitizedCases, ...this.operations.keys(), ...this.failedClears.keys()])) {
        try { this.clear(key); } catch { /* attempt every owned case and cleanup */ }
      }
      const results = await Promise.allSettled([...this.operations.values()].flatMap((owned) => [...owned].map(async (operation) => {
        await operation.close(); await operation.settled;
      })));
      if (this.failedClears.size || results.some((result) => result.status === "rejected")) throw new McpFailure("unavailable");
    });
  }

  onClear(handler: (caseRef: string) => void): void { this.clearHandlers.add(handler); }

  private ownsCase(caseRef: string): boolean {
    return this.cases.has(caseRef) || this.sanitizedCases.has(caseRef) || this.operations.has(caseRef) || this.failedClears.has(caseRef);
  }
  private caseCount(): number { return new Set([...this.cases.keys(), ...this.sanitizedCases, ...this.operations.keys(), ...this.failedClears.keys()]).size; }

  clear(caseRef: string): void {
    if (!this.ownsCase(caseRef)) return;
    const scope = this.cases.get(caseRef);
    if (scope) scope.closed = true;
    for (const operation of this.operations.get(caseRef) ?? []) {
      operation.controller.abort();
      void operation.close().catch(() => {});
    }
    const pending = this.failedClears.get(caseRef) ?? { handlers: new Set(this.clearHandlers), original: true };
    for (const handler of [...pending.handlers]) {
      try { handler(caseRef); pending.handlers.delete(handler); } catch { /* keep failed ownership visible */ }
    }
    if (pending.original) {
      try { this.original.clear(caseRef); pending.original = false; } catch { /* keep the original map's failed cleanup visible */ }
    }
    if (pending.handlers.size || pending.original) {
      this.failedClears.set(caseRef, pending);
      throw new McpFailure("unavailable");
    }
    this.failedClears.delete(caseRef);
    this.sanitizedCases.delete(caseRef);
    this.cases.delete(caseRef);
  }

  chargeEvidence(context: CallContext, sanitizedValue: unknown): void {
    const operation = this.contexts.get(context);
    if (!operation) throw new McpFailure("cancelled");
    this.current(operation);
    this.validateSafe(sanitizedValue);
    const bytes = Buffer.byteLength(JSON.stringify(sanitizedValue));
    if (operation.scope.bytes + bytes > CASE_EVIDENCE_BYTES) throw new McpFailure("unsafe_content");
    operation.scope.bytes += bytes;
  }

  private validateSafe(value: unknown): void {
    if (!this.original.safe(value) || /bearer\s|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=]/i.test(JSON.stringify(value))) throw new McpFailure("unsafe_content");
    const bounded = (item: unknown): boolean => typeof item === "string" ? Buffer.byteLength(item) <= FRAGMENT_BYTES
      : item !== null && typeof item === "object" ? Object.values(item).every(bounded) : true;
    if (!bounded(value)) throw new McpFailure("unsafe_content");
  }

  private current(operation: OwnedOperation): void {
    const { context, scope, controller, transport } = operation;
    if (controller.signal.aborted || context.signal.aborted || scope.closed || this.cases.get(context.caseRef) !== scope || this.ports.retention?.closed() || scope.phaseId > context.phaseId) throw new McpFailure("cancelled");
    if (this.ports.clock.now() >= context.deadline) throw new McpFailure("timeout");
    if (transport.failure) throw new McpFailure(transport.failure);
  }

  async run<T>(caller: CallContext, leaseKey: string, supplied: OwnedMcpEndpoint,
    authorize: (context: CallContext) => Promise<void>, work: (operation: McpOperation) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const context = Object.freeze({ ...caller, signal: AbortSignal.any([caller.signal, controller.signal]), resourceRefs: Object.freeze([...caller.resourceRefs]) });
    let scope = this.cases.get(context.caseRef);
    if (scope && (scope.closed || scope.authority !== authority(context))) throw new McpFailure("denied");
    if (!scope) {
      if (!this.ownsCase(context.caseRef) && this.caseCount() >= MAX_ACTIVE_CASES) throw new McpFailure("unavailable");
      scope = { bytes: 0, phaseId: context.phaseId, closed: false, authority: authority(context) };
      this.cases.set(context.caseRef, scope);
    }
    const flight = `${context.caseRef}:${leaseKey}`;
    const owned = this.operations.get(context.caseRef) ?? new Set<OwnedOperation>();
    const count = [...this.operations.values()].reduce((sum, items) => sum + items.size, 0);
    if (this.flights.has(flight) || owned.size >= CONNECTIONS_PER_CASE || count >= MAX_ACTIVE_CASES * CONNECTIONS_PER_CASE) throw new McpFailure("unavailable");
    this.flights.add(flight);
    scope.phaseId = Math.max(scope.phaseId, context.phaseId);
    const externalClose = supplied.close;
    const transport = new BoundedStdio({ command: supplied.command, args: [...supplied.args], artifact: { ...supplied.artifact } });
    const client = new Client({ name: "bau-independent-evidence-client", version: "1.0.0" }, { capabilities: {},
      jsonSchemaValidator: { getValidator: () => { throw new McpFailure("schema_mismatch"); } } });
    client.onerror = () => {};
    const settled = Promise.withResolvers<void>();
    void settled.promise.catch(() => {});
    let closing: Promise<void> | undefined;
    const operation: OwnedOperation = { context, scope, controller, transport, settled: settled.promise, close: () => {
      closing ??= Promise.allSettled([transport.close(), client.close(), Promise.resolve().then(() => externalClose?.())]).then((results) => {
        if (results.some((result) => result.status === "rejected")) throw new McpFailure("unavailable");
      });
      void closing.catch(() => {});
      return closing;
    } };
    owned.add(operation); this.operations.set(context.caseRef, owned); this.contexts.set(context, operation);
    const check = () => this.current(operation);
    const allowed = async () => { check(); await authorize(context); check(); };
    const options = () => ({ signal: context.signal, timeout: Math.max(1, context.deadline - this.ports.clock.now()),
      maxTotalTimeout: Math.max(1, context.deadline - this.ports.clock.now()), resetTimeoutOnProgress: false });
    const complete = () => { check(); transport.assertComplete(); };
    const sanitize = <V>(value: V): V => {
      check();
      let result: V;
      try { result = this.original.sanitize(value, context.caseRef); } catch { throw new McpFailure("unsafe_content"); }
      this.validateSafe(result); check(); return result;
    };
    const publicOperation: McpOperation = { context, current: check, sanitize,
      connect: async () => { await allowed(); await client.connect(transport, options()); complete(); return { serverInfo: client.getServerVersion(),
        capabilities: client.getServerCapabilities(), protocolVersion: transport.protocolVersion, instructions: client.getInstructions() }; },
      listTools: async () => { await allowed(); const result = await client.listTools({}, options()); complete(); return result; },
      callTool: async (name, args) => {
        await allowed();
        const result = await client.callTool({ name, arguments: { ...args } }, undefined, { ...options(), onprogress: (progress) => {
          try { if (Buffer.byteLength(JSON.stringify(sanitize(progress))) > FRAGMENT_BYTES) transport.fail("unsafe_content"); }
          catch (error) { transport.fail(safeReason(error)); }
        } });
        complete(); return result;
      },
    };
    const abort = () => { transport.fail("cancelled"); void operation.close().catch(() => {}); };
    context.signal.addEventListener("abort", abort, { once: true });
    let original: Promise<T> | undefined;
    let succeeded = false;
    try {
      const result = await beforeDeadline(this.ports.clock, context.deadline, () => {
        original = (async () => { await allowed(); const result = await work(publicOperation); await allowed(); complete(); return result; })();
        return original;
      }, context.signal, () => { transport.fail("timeout"); void operation.close().catch(() => {}); });
      succeeded = true;
      return result;
    } catch (error) {
      throw new McpFailure(transport.failure ?? (context.signal.aborted ? "cancelled" : this.ports.clock.now() >= context.deadline ? "timeout" : safeReason(error)));
    } finally {
      context.signal.removeEventListener("abort", abort);
      const finished = Promise.all([original?.then(() => {}, () => {}), operation.close()]);
      void finished.then(() => {
        owned.delete(operation); if (!owned.size) this.operations.delete(context.caseRef);
        this.flights.delete(flight); this.contexts.delete(context); settled.resolve();
      }, () => settled.reject(new McpFailure("unavailable")));
      await operation.close();
      if (succeeded) check();
    }
  }
}
