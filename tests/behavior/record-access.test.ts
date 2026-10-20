import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockTroubleshooting } from "../../src/adapters/mock/troubleshooting.js";
import { SqliteRecords } from "../../src/adapters/records/sqlite.js";

const reviewer = { principalRef: "business-reviewer", tenantRef: "tenant-1", destinationRef: "review-conversation" };

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} C assigned business review exports only sanitized report and evidence`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-record-access-"));
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ ...{ recordGrants: [{ actor: reviewer, role: "business_reviewer", caseRefs: ["case-1"], resourceRefs: ["simulator-source"] }] },
    controlPorts: (ports) => {
      if (!durable) return {};
      store = new SqliteRecords(directory, ports);
      return { admission: store.admission, audit: store.audit, records: store.records, budget: store.budget };
    } });
  try {
    await mock.receive();
    await mock.closed;
    const review = await mock.ports.records.export(reviewer, "case-1");
    assert.ok(review);
    assert.deepEqual([...new Set(review.records.map((record) => record.kind))].sort(), ["evidence", "report"]);
    assert.equal("view" in review, false);
    assert.equal(review.audits.length, 0);
    assert.equal(review.deliveries.length, 0);
    assert.equal(JSON.stringify(review).includes("SYNTHETIC-SECRET-APPLICATION"), false);
    assert.equal(await mock.ports.records.read(reviewer, "case-2"), null);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const durable of [false, true]) test(`${durable ? "SQLite" : "Mock"} C technical access requires current exact case and resource scope`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-technical-access-"));
  const technician = { ...reviewer, principalRef: "technical-reviewer" };
  const grants = [{ actor: technician, role: "technical" as const, caseRefs: ["case-1"], resourceRefs: ["simulator-source"] }];
  const denyActions: string[] = [];
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ recordGrants: grants, denyActions, controlPorts: (ports) => {
    if (!durable) return {};
    store = new SqliteRecords(directory, ports);
    return { admission: store.admission, audit: store.audit, records: store.records, budget: store.budget };
  } });
  try {
    await mock.receive(); await mock.closed;
    const full = await mock.ports.records.read(technician, "case-1");
    assert.ok(full?.scope === "full");
    assert.ok(full.records.some((record) => record.kind === "model_input"));
    assert.ok(full.audits.some((audit) => audit.principalRef === technician.principalRef && audit.role === "technical"));
    assert.equal(await mock.ports.records.export(technician, "case-2"), null);
    grants[0]!.resourceRefs.length = 0;
    assert.equal(await mock.ports.records.export(technician, "case-1"), null);
    grants[0]!.resourceRefs.push("simulator-source");
    denyActions.push("records.read", "records.export");
    assert.equal(await mock.ports.records.read(technician, "case-1"), null);
    assert.equal(await mock.ports.records.export(technician, "case-1"), null);
    denyActions.length = 0;
    grants[0]!.caseRefs.length = 0;
    assert.equal(await mock.ports.records.read(technician, "case-1"), null);
    assert.equal(await mock.ports.records.read({ ...technician, role: "technical" } as typeof technician, "case-1"), null);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C record-grant control failures expose only a bounded failure code", async () => {
  let fail = false;
  const mock = createMockTroubleshooting({ controlPorts: (ports) => {
    const grant = ports.authorization.recordGrant!;
    ports.authorization.recordGrant = (actor, owner) => { if (fail) throw new Error("SYNTHETIC-SECRET /private/grant/path"); return grant(actor, owner); };
    return {};
  } });
  await mock.receive(); await mock.closed;
  fail = true;
  await assert.rejects(mock.ports.records.read(mock.inbound, "case-1"), { message: "unavailable" });
  await assert.rejects(mock.ports.records.export(mock.inbound, "case-1"), { message: "unavailable" });
});

for (const durable of [false, true]) for (const operation of ["read", "export"] as const) test(`${durable ? "SQLite" : "Mock"} C ${operation} rechecks assignment after its awaited audit`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "bau-record-revoke-"));
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const grants = [{ actor: reviewer, role: "business_reviewer" as const, caseRefs: ["case-1"], resourceRefs: ["simulator-source"] }];
  let store: SqliteRecords | undefined;
  const mock = createMockTroubleshooting({ recordGrants: grants, controlPorts: (ports) => {
    if (durable) store = new SqliteRecords(directory, ports);
    const audit = store?.audit ?? ports.audit;
    return { ...(store ? { admission: store.admission, records: store.records, budget: store.budget, retention: store.retention } : {}),
      audit: { ...audit, complete: async (context, action, outcome, details) => {
        await audit.complete(context, action, outcome, details);
        if (action === `records.${operation}`) { ready.resolve(); await release.promise; }
      } } };
  } });
  // SQLite owns its native audit port; delay its external current-authorization seam instead.
  if (store) {
    const grant = mock.ports.authorization.recordGrant!;
    let checks = 0;
    mock.ports.authorization.recordGrant = async (actor, owner) => {
      if (actor.principalRef === reviewer.principalRef && ++checks === 2) { ready.resolve(); await release.promise; }
      return grant(actor, owner);
    };
  }
  try {
    await mock.receive(); await mock.closed;
    const reading = mock.ports.records[operation](reviewer, "case-1");
    await ready.promise;
    grants[0]!.caseRefs.length = 0;
    release.resolve();
    assert.equal((await reading) === null, true);
  } finally { release.resolve(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("C actor fields cannot overwrite the saved case or resource authorization scope", async () => {
  let revoked = false;
  const mock = createMockTroubleshooting({ controlPorts: (ports) => {
    const allows = ports.authorization.allows;
    ports.authorization.allows = (action, context) => revoked && action.startsWith("records.") && context.resourceRefs.includes("simulator-source")
      ? Promise.resolve(false) : allows(action, context);
    return {};
  } });
  await mock.receive(); await mock.closed;
  revoked = true;
  const claimed = { ...mock.inbound, resourceRefs: [], caseRef: "other-case", approvalRef: "forged" };
  assert.equal((await mock.ports.records.export(claimed, "case-1")) === null, true);
});
