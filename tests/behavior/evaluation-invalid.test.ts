import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate } from '../../src/evaluation/index.js';
import { evaluationExample } from '../fixtures/evaluation.js';

test('a partial frozen round retains each original denominator and names missing record classes', () => {
  const input = evaluationExample();
  input.round.cases.pop(); input.references.answers.pop(); input.results.runs.pop();
  const result = evaluate(input);
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.scenes[1]!.denominator, 12);
  assert.ok(result.pending.includes('missing_frozen_cases'));
  assert.equal(result.decision, 'cannot_determine');
  input.references.answers.pop();
  assert.ok(evaluate(input).pending.includes('missing_reference_material'));
});

test('rounds cannot mix duplicate identities, foreign references, or overwritten run lineage', () => {
  const duplicate = evaluationExample(); duplicate.results.runs[1]!.runId = duplicate.results.runs[0]!.runId;
  assert.equal(evaluate(duplicate).valid, false);
  const foreign = evaluationExample(); foreign.references.answers[0]!.caseId = 'foreign-case';
  assert.equal(evaluate(foreign).valid, false);
  const retest = evaluationExample(); retest.round.previousRoundRef = 'original-round';
  assert.equal(evaluate(retest).valid, false);
  retest.round.archiveRef = 'original-immutable-records';
  for (const run of retest.results.runs) run.priorRunRef = `prior-${run.runId}`;
  assert.equal(evaluate(retest).valid, true);
});

test('random review selection cannot shrink the original pool or cherry-pick a favorable subset', () => {
  const input = evaluationExample();
  input.results.sampling.selectedCaseIds = [];
  const missing = evaluate(input);
  assert.equal(missing.valid, true);
  assert.ok(missing.pending.includes('insufficient_random_sample'));
  input.results.sampling.poolCaseIds.pop();
  assert.equal(evaluate(input).valid, false);
  const cherryPicked = evaluationExample();
  cherryPicked.results.sampling.selectedCaseIds = ['simulator-1'];
  assert.equal(evaluate(cherryPicked).valid, false);
  const lateSeed = evaluationExample(); lateSeed.round.sampling.committedAt = '2026-10-02T00:11:00.000Z';
  assert.equal(evaluate(lateSeed).valid, false);
});

test('calendar validation accepts a real leap date, rejects impossible months/days and requires explicit UTC', () => {
  const json = JSON.stringify(evaluationExample());
  const leap: unknown = JSON.parse(json.replaceAll('2026-10-01', '2028-02-28').replaceAll('2026-10-02', '2028-02-29'));
  assert.equal(evaluate(leap).valid, true);
  const nonLeap: unknown = JSON.parse(json.replaceAll('2026-10-01', '2027-02-28').replaceAll('2026-10-02', '2027-02-29'));
  assert.equal(evaluate(nonLeap).valid, false);
  for (const timestamp of ['2026-99-99T00:00:00Z', '2026-04-31T00:00:00Z', '2026-10-02T24:00:00Z', '2026-10-02T00:00:00', '2026-10-02T00:00:00+08:00']) {
    const input = evaluationExample(); input.results.runs[0]!.timeline.receivedAt = timestamp;
    assert.equal(evaluate(input).valid, false, timestamp);
  }
});

test('out-of-order acceptance, overlapping phases or duplicated human work are rejected', () => {
  const order = evaluationExample(); order.results.runs[0]!.timeline.acceptedAt = '2026-10-01T23:59:00Z';
  assert.equal(evaluate(order).valid, false);
  const phases = evaluationExample(); phases.results.runs[0]!.timeline.phases.push({ id: 'overlap', startedAt: '2026-10-02T00:04:00Z', endedAt: '2026-10-02T00:05:00Z' });
  assert.equal(evaluate(phases).valid, false);
  const work = evaluationExample();
  work.results.runs[0]!.timeline.humanWork = [{ id: 'work-1', actorId: 'operator-1', kind: 'read', startedAt: '2026-10-02T00:01:00Z', endedAt: '2026-10-02T00:02:00Z' }];
  work.results.runs[1]!.timeline.humanWork = [{ id: 'work-2', actorId: 'operator-1', kind: 'verify', startedAt: '2026-10-02T00:01:30Z', endedAt: '2026-10-02T00:02:30Z' }];
  assert.equal(evaluate(work).valid, false);
});

test('no report or supported clue produces null duration, never zero or a fabricated score', () => {
  const input = evaluationExample();
  const runs = input.results.runs.map((run, i) => i === 9 ? { ...run, status: 'cancelled', failureRef: 'cancellation-1', report: null, factChecks: [], primary: null, secondary: null } : run);
  const result = evaluate({ ...input, results: { ...input.results, runs } });
  assert.equal(result.valid, true);
  if (!result.valid) return;
  assert.equal(result.times.cases[9]!.reportMs, null);
  assert.equal(result.times.cases[9]!.clueMs, null);
  assert.deepEqual(result.times.scenes[1]!.clueMs, { valid: 0, missing: 12, min: null, median: null, max: null });
  input.results.runs[9]!.report.deliveredAt = null;
  assert.equal(evaluate(input).valid, false);
});

test('attempt ledgers, actual billing sources and integer money cannot be silently normalized', () => {
  const omitted = evaluationExample(); omitted.results.runs[0]!.attemptIds.push('missing-attempt');
  assert.equal(evaluate(omitted).valid, false);
  const source = evaluationExample(); source.results.runs[0]!.attempts[0]!.fee.actualSourceRef = null;
  assert.equal(evaluate(source).valid, false);
  const money = evaluationExample(); money.results.runs[0]!.attempts[0]!.fee.actualMicrousd = 0.5;
  assert.equal(evaluate(money).valid, false);
  const overflow = evaluationExample();
  for (const run of overflow.results.runs) run.attempts[0]!.fee.actualMicrousd = Number.MAX_SAFE_INTEGER;
  assert.equal(evaluate(overflow).valid, false);
  const index = evaluationExample(); index.results.indexing.push({ ...index.results.indexing[0]!, costId: 'duplicate-initial-charge' });
  assert.equal(evaluate(index).valid, false);
});

test('strict versioned unknown input rejects extra properties and non-integer scores without echoing their contents', () => {
  const input = evaluationExample(); input.results.runs[0]!.primary.score = 4.5;
  assert.equal(evaluate(input).valid, false);
  const extra = evaluationExample();
  const result = evaluate({ ...extra, controlledAnswer: 'CONTROLLED secret' });
  assert.equal(result.valid, false);
  assert.ok(!JSON.stringify(result).includes('CONTROLLED'));
  assert.equal(evaluate({ ...extra, round: { ...extra.round, schemaVersion: 'evaluation-round-2' } }).valid, false);
});
