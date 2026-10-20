import assert from 'node:assert/strict';
import test from 'node:test';
import { agentInputs, evaluate } from '../../src/evaluation/index.js';
import { evaluationExample } from '../fixtures/evaluation.js';

test('offline evaluation keeps independent 12-case denominators: combined 18 cannot hide 8 + 10', () => {
  const failed = evaluate(evaluationExample(8, 10));
  assert.equal(failed.valid, true);
  if (!failed.valid) return;
  assert.deepEqual(failed.scenes.map(scene => [scene.scene, scene.useful, scene.denominator, scene.thresholdMet]), [
    ['simulator', 8, 12, false], ['psp', 10, 12, true],
  ]);
  const passed = evaluate(evaluationExample(9, 9));
  assert.equal(passed.valid, true);
  if (!passed.valid) return;
  assert.deepEqual(passed.scenes.map(scene => [scene.useful, scene.thresholdMet]), [[9, true], [9, true]]);
  assert.equal(passed.decision, 'cannot_determine');
  assert.ok(passed.pending.includes('synthetic_only'));
});

test('review obligations use the original qualified pool; unresolved disagreement cannot improve the pool or count', () => {
  const input = evaluationExample(9, 9);
  const first = input.results.runs[0]!;
  first.secondary.score = 2;
  first.disputed = true;
  const result = evaluate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.review.initialQualified, 18);
  assert.equal(result.review.randomMinimum, 5);
  assert.equal(result.scenes[0]!.useful, 8);
  assert.ok(result.pending.includes('unresolved_review'));
  assert.equal(result.cases[0]!.reviewStatus, 'unresolved');

  first.resolution = { reviewerId: 'owner-1', chosen: 'secondary', basisRef: 'resolution-1', at: '2026-10-02T00:13:00.000Z' };
  const resolved = evaluate(input);
  assert.equal(resolved.valid, true);
  if (!resolved.valid) return;
  assert.equal(resolved.review.initialQualified, 18);
  assert.equal(resolved.scenes[0]!.useful, 8);
  assert.ok(!resolved.pending.includes('unresolved_review'));
});

function declaredFormal(simulator = 9, psp = 9) {
  // These declarations exercise the formal branch synthetically; they do not establish actual evidence.
  const input = evaluationExample(simulator, psp);
  input.round.kind = 'formal';
  for (const item of input.round.cases) { item.source = 'actual'; item.sampleApprovalRef = 'sample-approval-1'; }
  for (const gate of input.results.gates) gate.basis = 'actual';
  return input;
}

test('complete formal arithmetic yields only owner eligibility or No-Go; missing evidence stays undecidable and actual safety failure always stops', () => {
  assert.equal(evaluate(declaredFormal()).decision, 'eligible_for_owner_decision');
  assert.equal(evaluate(declaredFormal(8, 10)).decision, 'no_go');
  const missing = declaredFormal(8, 10);
  missing.results.runs.pop();
  missing.results.sampling.poolCaseIds = missing.results.sampling.poolCaseIds.filter(id => id !== 'psp-12');
  assert.equal(evaluate(missing).decision, 'cannot_determine');
  const stopped = declaredFormal();
  stopped.round.cases[0]!.sampleApprovalRef = null;
  stopped.results.gates[1]!.status = 'failed';
  const result = evaluate(stopped);
  assert.equal(result.decision, 'cannot_determine');
  assert.deepEqual(result.stopPaths, ['authorization']);
  const invalid: unknown = { ...stopped, references: { secret: 'CONTROLLED reference must never appear' } };
  const malformed = evaluate(invalid);
  assert.equal(malformed.valid, false);
  assert.deepEqual(malformed.stopPaths, ['authorization']);
  assert.ok(!JSON.stringify(malformed).includes('CONTROLLED'));
  const malformedGate = { ...stopped, results: { ...stopped.results, gates: stopped.results.gates.map(gate => gate.gate === 'authorization' ? { gate: 'authorization', status: 'failed', basis: 'actual', extra: 'CONTROLLED secret' } : gate) } };
  const incompleteFailure = evaluate(malformedGate);
  assert.equal(incompleteFailure.valid, false);
  assert.deepEqual(incompleteFailure.stopPaths, ['authorization']);
});

for (const [pool, minimum] of [[1, 1], [9, 3], [12, 3]] as const) {
  test(`random second-review minimum for an initial pool of ${pool} is ${minimum}`, () => {
    const result = evaluate(evaluationExample(pool, 0));
    assert.equal(result.valid, true);
    if (!result.valid) return;
    assert.equal(result.review.initialQualified, pool);
    assert.equal(result.review.randomMinimum, minimum);
  });
}

test('every initially unqualified or disputed delivered report needs an independent qualified second review', () => {
  const input = evaluationExample(9, 9);
  const runs = input.results.runs.map((run, i) => i === 9 ? { ...run, secondary: null } : run);
  const result = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.review.requiredSecond, 24);
  assert.equal(result.review.completedSecond, 23);
  assert.ok(result.pending.includes('missing_second_review'));
  assert.equal(result.cases[9]!.useful, false);
  input.results.runs[9]!.secondary.reviewerId = 'reviewer-1';
  const selfReviewed = evaluate(input);
  assert.equal(selfReviewed.valid, false);
  assert.ok(selfReviewed.issues?.includes('reviewer_not_qualified'));
});

test('fact support requires semantic review, missing checks stay pending, and zero facts never becomes 100%', () => {
  const unsupported = declaredFormal();
  unsupported.results.runs[0]!.factChecks[0]!.support = 'unsupported';
  const bad = evaluate(unsupported);
  assert.equal(bad.valid, true);
  if (!bad.valid) return;
  assert.deepEqual(bad.facts, { total: 24, supported: 23, coverage: 23 / 24 });
  assert.equal(bad.decision, 'no_go');
  assert.equal(bad.cases[0]!.useful, false);
  const missing = declaredFormal();
  missing.results.runs[0]!.factChecks = [];
  const unchecked = evaluate(missing);
  assert.equal(unchecked.decision, 'cannot_determine');
  assert.ok(unchecked.pending.includes('missing_fact_review'));
  const zero = declaredFormal();
  for (const run of zero.results.runs) { run.report.criticalFactIds = []; run.factChecks = []; run.report.diagnostic = 'insufficient_evidence'; }
  const empty = evaluate(zero);
  assert.equal(empty.valid, true);
  if (!empty.valid) return;
  assert.equal(empty.facts.coverage, null);
  assert.equal(empty.cases[0]!.useful, true);
  assert.ok(empty.pending.includes('zero_fact_denominator'));
  assert.equal(empty.decision, 'cannot_determine');
});

test('failed and undelivered cases stay in 12, have no invented rating, and cannot be replaced by a best rerun', () => {
  const input = evaluationExample(9, 9);
  const runs = input.results.runs.map((run, i) => i === 9 ? { ...run, status: 'timeout', failureRef: 'failure-1', report: null, factChecks: [], primary: null, secondary: null } : run);
  const retained = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(retained.valid, true);
  if (!retained.valid) return;
  assert.equal(retained.scenes[0]!.denominator, 12);
  assert.equal(retained.scenes[0]!.useful, 9);
  assert.equal(retained.cases[9]!.reviewStatus, 'not_delivered');
  assert.equal(retained.review.requiredSecond, 23);
  input.results.runs[0]!.runId = 'better-rerun';
  assert.equal(evaluate(input).valid, false);
  input.results.runs[0]!.runId = 'run-simulator-1';
  input.results.runs[0]!.versions.policy = 'different-policy';
  const mixed = evaluate(input);
  assert.equal(mixed.valid, false);
  assert.ok(mixed.issues?.includes('version_mismatch'));
});

test('elapsed time starts at acceptance, includes clarification, and keeps phase/wait/manual/review streams separate', () => {
  const input = evaluationExample();
  const run = input.results.runs[0]!;
  run.timeline.clue = { deliveredAt: '2026-10-02T00:04:30.000Z', deliveryRef: 'clue-delivery-1', safe: true, supported: true, evidenceRefs: ['evidence-1'], reviewerId: 'reviewer-1', checkedAt: '2026-10-02T00:09:00.000Z' };
  run.timeline.phases = [
    { id: 'phase-1', startedAt: '2026-10-02T00:01:00.000Z', endedAt: '2026-10-02T00:01:30.000Z' },
    { id: 'phase-2', startedAt: '2026-10-02T00:03:30.000Z', endedAt: '2026-10-02T00:05:00.000Z' },
  ];
  run.timeline.waits = [
    { id: 'wait-1', kind: 'queue', startedAt: '2026-10-02T00:01:00.000Z', endedAt: '2026-10-02T00:01:15.000Z' },
    { id: 'wait-2', kind: 'clarification', startedAt: '2026-10-02T00:01:30.000Z', endedAt: '2026-10-02T00:03:30.000Z' },
    { id: 'wait-3', kind: 'tool', startedAt: '2026-10-02T00:03:30.000Z', endedAt: '2026-10-02T00:04:00.000Z' },
    { id: 'wait-4', kind: 'model', startedAt: '2026-10-02T00:04:00.000Z', endedAt: '2026-10-02T00:04:30.000Z' },
  ];
  run.timeline.humanWork = [
    { id: 'work-1', actorId: 'operator-1', kind: 'read', startedAt: '2026-10-02T00:04:30.000Z', endedAt: '2026-10-02T00:04:45.000Z' },
    { id: 'work-2', actorId: 'reviewer-1', kind: 'score', startedAt: '2026-10-02T00:05:00.000Z', endedAt: '2026-10-02T00:06:00.000Z' },
    { id: 'work-3', actorId: 'reviewer-2', kind: 'second_review', startedAt: '2026-10-02T00:06:00.000Z', endedAt: '2026-10-02T00:07:00.000Z' },
  ];
  const result = evaluate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.times.cases[0], { caseId: 'simulator-1', clueMs: 210000, reportMs: 240000, phaseMs: 120000, waitMs: { queue: 15000, tool: 30000, model: 30000, clarification: 120000 }, manualMs: 15000, scoringMs: 60000, secondReviewMs: 60000 });
  assert.deepEqual(result.times.scenes[0]!.reportMs, { valid: 12, missing: 0, min: 240000, median: 240000, max: 240000 });
  assert.deepEqual(result.times.scenes[0]!.clueMs, { valid: 1, missing: 11, min: 210000, median: 210000, max: 210000 });
});

test('costs retain failed/retry/unknown attempts, separate actual from estimates/reserves, and count shared indexing once', () => {
  const input = evaluationExample();
  const run = input.results.runs[0]!;
  run.attempts[0]!.status = 'failed';
  run.attempts.push({ ...structuredClone(run.attempts[0]!), attemptId: 'attempt-2', retryOf: 'attempt-1', status: 'unknown', startedAt: '2026-10-02T00:04:00.000Z', endedAt: null, usage: null, fee: { actualMicrousd: null, actualSourceRef: null, estimatedMicrousd: 300, reservedMicrousd: 400 } });
  run.attemptIds.push('attempt-2');
  const result = evaluate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.deepEqual(result.costs.cases[0]!.model, { knownActualMicrousd: 100, unknownFees: 1, completeActualMicrousd: null, estimatedMicrousd: 420, estimates: 2, reservedMicrousd: 400 });
  assert.deepEqual(result.costs.cases[0]!.attempts, { total: 2, succeeded: 0, failed: 1, cancelled: 0, unknown: 1 });
  assert.deepEqual(result.costs.cases[0]!.usage, { knownAttempts: 1, unknownAttempts: 1, inputTokens: 100, outputTokens: 20 });
  assert.equal(result.costs.model.knownActualMicrousd, 2400);
  assert.equal(result.costs.model.completeActualMicrousd, null);
  assert.equal(result.costs.indexing.initial.knownActualMicrousd, 500);
  assert.equal(result.costs.indexing.initial.entries, 1);
  assert.deepEqual(result.costs.scenes[0]!.actualModelMicrousd, { valid: 11, missing: 1, min: 100, median: 100, max: 100 });
});

test('Agent input projection excludes controlled answers, review material, approvals and scoring', () => {
  const input = evaluationExample();
  const projected = agentInputs(input.round);
  assert.equal(projected.valid, true);
  if (!projected.valid) return;
  assert.deepEqual(Object.keys(projected.inputs.cases[0]!), ['caseId', 'runId', 'scene', 'input']);
  assert.equal(projected.inputs.cases[0]!.input.question, 'Synthetic troubleshooting question');
  const text = JSON.stringify(projected);
  for (const forbidden of ['CONTROLLED', 'referenceId', 'reviewer', 'sampleApproval', 'score', 'conclusion']) assert.ok(!text.includes(forbidden));
  const extra = agentInputs({ ...input.round, referenceAnswers: input.references.answers });
  assert.equal(extra.valid, false);
  assert.ok(!JSON.stringify(extra).includes('CONTROLLED'));
});

test('evaluation can record the existing PSP log plus three-repository authorized scope without granting it', () => {
  const input = evaluationExample();
  input.round.cases[12]!.input.resourceRefs = ['psp-log-source', 'synthetic-repo-1', 'synthetic-repo-2', 'synthetic-repo-3'];
  assert.equal(evaluate(input).valid, true);
  const projected = agentInputs(input.round);
  assert.equal(projected.valid, true);
  if (!projected.valid) return;
  assert.equal(projected.inputs.cases[12]!.input.resourceRefs.length, 4);
});

test('missing second-review key checks cannot be counted useful, even when the scores agree', () => {
  const input = evaluationExample();
  input.results.runs[0]!.secondary.checkedKeys = [];
  const result = evaluate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.cases[0]!.useful, false);
  assert.equal(result.review.completedSecond, 23);
  assert.equal(result.decision, 'cannot_determine');
  assert.ok(result.pending.includes('missing_reference_checks'));
});

test('an effective clue must have a safe delivery receipt and later qualified semantic support', () => {
  const input = evaluationExample();
  const runs = input.results.runs.map((run, i) => i === 0 ? { ...run, timeline: { ...run.timeline, clue: { deliveredAt: '2026-10-02T00:04:30.000Z', deliveryRef: 'clue-delivery-1', safe: false, supported: true, evidenceRefs: ['evidence-1'], reviewerId: 'reviewer-1', checkedAt: '2026-10-02T00:09:00.000Z' } } } : run);
  const unsafe = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(unsafe.valid, true);
  if (!unsafe.valid) return;
  assert.equal(unsafe.times.cases[0]!.clueMs, null);
  runs[0]!.timeline.clue!.safe = true;
  const supported = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(supported.valid, true);
  if (!supported.valid) return;
  assert.equal(supported.times.cases[0]!.clueMs, 210000);
});

test('controlled reference checks retain their meaning separately from the Agent-facing case input', () => {
  const input = evaluationExample();
  const answers = input.references.answers.map(answer => ({ ...answer, keyChecks: answer.keyChecks.map(({ checkId }) => ({ checkId, description: 'CONTROLLED required check description' })) }));
  const result = evaluate({ ...input, references: { ...input.references, answers } });
  assert.equal(result.valid, true);
  assert.ok(!JSON.stringify(result).includes('CONTROLLED'));
});

test('manual, scoring and second-review costs are separate records; missing actual labor fees remain unknown', () => {
  const input = evaluationExample();
  const unknown = { actualMicrousd: null, actualSourceRef: null, estimatedMicrousd: null, reservedMicrousd: 0 };
  const runs = input.results.runs.map((run, i) => ({ ...run, humanFees: { manual: unknown, scoring: i === 0 ? { ...unknown, actualMicrousd: 1000, actualSourceRef: 'scoring-charge-1' } : unknown, secondReview: unknown }, limitations: ['Synthetic limits remain'] }));
  const result = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.costs.cases[0]!.human!.manual.completeActualMicrousd, null);
  assert.equal(result.costs.human.scoring.knownActualMicrousd, 1000);
  assert.equal(result.costs.human.scoring.unknownFees, 23);
  assert.equal(result.costs.human.scoring.completeActualMicrousd, null);
  assert.equal(result.costs.model.knownActualMicrousd, 2400);
});

test('an unsampled report with unsupported critical facts still needs second review without rewriting the initial business pool', () => {
  const input = declaredFormal();
  input.results.sampling.selectedCaseIds = ['simulator-6', 'psp-7', 'simulator-1', 'simulator-3', 'psp-8'];
  input.results.runs[1]!.factChecks[0]!.support = 'unsupported';
  const runs = input.results.runs.map((run, i) => i === 1 ? { ...run, secondary: null } : run);
  const result = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.review.initialQualified, 18);
  assert.equal(result.review.randomMinimum, 5);
  assert.equal(result.cases[1]!.secondRequired, true);
  assert.equal(result.cases[1]!.useful, false);
  assert.equal(result.decision, 'cannot_determine');
  assert.ok(result.pending.includes('missing_second_review'));
});

test('a cancelled case retains its original late physical completion and fee, without allowing a new post-terminal call', () => {
  const input = evaluationExample();
  const runs = input.results.runs.map((run, i) => i === 9 ? {
    ...run, status: 'cancelled', failureRef: 'cancel-receipt-1', report: null, primary: null, secondary: null, factChecks: [],
    timeline: { ...run.timeline, finishedAt: '2026-10-02T00:02:00Z', phases: [{ id: 'phase-1', startedAt: '2026-10-02T00:01:00Z', endedAt: '2026-10-02T00:02:00Z' }] },
    attempts: [{ ...run.attempts[0]!, startedAt: '2026-10-02T00:01:30Z', endedAt: '2026-10-02T00:03:00Z' }],
  } : run);
  const result = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.times.cases[9]!.reportMs, null);
  assert.equal(result.times.cases[9]!.phaseMs, 60000);
  assert.equal(result.costs.cases[9]!.model!.completeActualMicrousd, 100);
  assert.equal(result.costs.cases[9]!.attempts!.succeeded, 1);
  runs[9]!.attempts[0]!.startedAt = '2026-10-02T00:02:01Z';
  assert.equal(evaluate({ ...input, results: { ...input.results, runs } }).valid, false);
});
