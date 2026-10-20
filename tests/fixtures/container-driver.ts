import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { ManualClock } from "./clock.js";
import type { CallContext } from "../../src/troubleshooting/application/ports.js";

// Mounted read-only by the host contract, never copied into the application image.
const modulePath: string = "/app/dist/src/bootstrap/runtime.js";
const { openMockRuntime }: typeof import("../../src/bootstrap/runtime.js") = await import(pathToFileURL(modulePath).href);
const mode = process.argv[2];
const allowed = ["simulator", "psp", "duplicate-simulator", "interrupt", "duplicate-interrupt", "graceful", "unknown", "timeout", "reserve", "ledger", "settle", "audit-fault", "startup-fault"];
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  assert.ok(mode && allowed.includes(mode));
  const clock = mode === "timeout" ? new ManualClock() : undefined;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const runtime = await openMockRuntime({ schemaVersion: 1, profile: "mock", recordsDirectory: "/var/lib/bau/records" }, {
    ...(mode === "audit-fault" || mode === "startup-fault" ? { storeFault: (point: string) => {
      if (point === (mode === "startup-fault" ? "audit:runtime.start:intent" : "audit:logs.read:intent")) throw new Error("synthetic-storage-fault");
    } } : {}),
    mocks: { ...(clock ? { clock } : {}),
      ...(["interrupt", "unknown", "timeout"].includes(mode!) ? { model: async (_context, draft) => { entered.resolve(); await release.promise; return { candidate: draft, actualMicrousd: 1000 }; } } : {}),
      ...(mode === "graceful" ? { agent: async (context, request) => {
        entered.resolve(); await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => resolve(), { once: true }));
        return request.generate(request.diagnose());
      } } : {}) },
  });
  const context: CallContext = { ...runtime.inbound, caseRef: "synthetic-ledger", phaseId: 1, callId: "synthetic-ledger:call-1",
    resourceRefs: ["simulator-source", "psp-log-source", "psp-code"], policyVersion: "mock-policy-1", approvalRef: "mock-approval-1",
    snapshotRef: "simulator-snapshot-1", budgetRef: "synthetic-ledger", deadline: runtime.ports.clock.now() + 30000, signal: new AbortController().signal };
  if (["reserve", "ledger", "settle"].includes(mode!)) {
    if (mode === "reserve") { assert.equal(await runtime.ports.budget.reserve(context, 700000), true); await runtime.ports.budget.settle(context, null, { execution: "unknown", source: "unknown" }); }
    if (mode === "settle") for (let duplicate = 0; duplicate < 2; duplicate++) await runtime.ports.budget.settle(context, 4000, { execution: "ended", source: "mock_usage" });
    emit({ event: "ledger", budget: await runtime.ports.budget.status(context.caseRef) });
  } else {
    const eventRef = mode!.includes("simulator") ? "container-simulator" : ["interrupt", "duplicate-interrupt"].includes(mode!) ? "container-interrupt" : `container-${mode}`;
    const accepted = await runtime.receive({ eventRef, ...(mode === "psp" ? { input: { scenario: "psp", applicationId: "SYNTHETIC-SECRET-APPLICATION",
      shopId: "SYNTHETIC-SECRET-SHOP", bindingId: "SYNTHETIC-SECRET-BINDING", question: "Explain the synthetic PSP outcome." } } : {}) });
    assert.ok("view" in accepted);
    const caseRef = accepted.view.caseRef;
    if (["interrupt", "graceful", "unknown"].includes(mode!)) {
      await entered.promise;
      const lifetime = setInterval(() => {}, 3600000);
      process.once("SIGTERM", () => { void (async () => {
        const state = await runtime.close();
        process.stdout.write(`${JSON.stringify({ event: "shutdown", state })}\n`, () => {
          clearInterval(lifetime); process.exit(state === "closed" ? 0 : 1);
        });
      })(); });
      emit({ event: "held", caseRef, budget: await runtime.ports.budget.status(caseRef) });
      await new Promise(() => {});
    }
    if (mode === "timeout") { await entered.promise; clock!.advance(60000); }
    if (!mode!.startsWith("duplicate-")) await runtime.closed;
    const view = await runtime.application.get(runtime.inbound, caseRef);
    const retained = await runtime.ports.records.export(runtime.inbound, caseRef);
    assert.ok(retained?.scope === "full");
    const report = retained.records.findLast((record) => record.kind === "report")?.payload;
    emit({ event: "case", status: accepted.status, caseRef, view, report, retained, budget: await runtime.ports.budget.status(caseRef),
      businessActions: runtime.events.filter((event) => ["logs.read", "code.search", "model.generate", "delivery.send", "delivery.fault"].includes(event.action)).map((event) => event.action) });
    release.resolve();
    if (mode === "timeout") await new Promise(setImmediate);
  }
  assert.equal(await runtime.close(), "closed");
} catch { process.stderr.write("container_contract_failed\n"); process.exitCode = 1; }
