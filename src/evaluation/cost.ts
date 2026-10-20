import { scenes, type EvaluationBundle, type Fee } from './format.js';
import { duplicate, sameSet } from './review.js';
import { describe } from './time.js';

function fees(items: Fee[], issues: string[]) {
  const sum = (values: number[]) => {
    const value = values.reduce((total, item) => total + BigInt(item), 0n);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) issues.push('cost_overflow');
    return Number(value);
  };
  for (const item of items) if ((item.actualMicrousd === null) !== (item.actualSourceRef === null)) issues.push('actual_fee_source_mismatch');
  const knownActualMicrousd = sum(items.flatMap(item => item.actualMicrousd === null ? [] : [item.actualMicrousd]));
  const unknownFees = items.filter(item => item.actualMicrousd === null).length;
  return { knownActualMicrousd, unknownFees, completeActualMicrousd: unknownFees ? null : knownActualMicrousd, estimatedMicrousd: sum(items.flatMap(item => item.estimatedMicrousd === null ? [] : [item.estimatedMicrousd])), estimates: items.filter(item => item.estimatedMicrousd !== null).length, reservedMicrousd: sum(items.map(item => item.reservedMicrousd)) };
}

export function measureCosts({ round, results }: EvaluationBundle) {
  const issues: string[] = [];
  if (duplicate(results.indexing.map(item => item.costId)) || duplicate(results.indexing.filter(item => item.kind === 'initial').map(item => item.scopeRef))) issues.push('duplicate_index_charge');
  for (const index of results.indexing) if (Date.parse(index.endedAt) < Date.parse(index.startedAt)) issues.push('invalid_index_interval');
  const cases = round.cases.map(item => {
    const run = results.runs.find(candidate => candidate.caseId === item.caseId);
    if (!run) return { caseId: item.caseId, model: null, human: null, attempts: null, usage: null, indexCostRefs: [] };
    if (!sameSet(run.attemptIds, run.attempts.map(attempt => attempt.attemptId))) issues.push('attempt_inventory_mismatch');
    if (duplicate(run.indexCostRefs) || run.indexCostRefs.some(ref => !results.indexing.some(index => index.costId === ref))) issues.push('index_reference_mismatch');
    for (const [position, attempt] of run.attempts.entries()) {
      const began = Date.parse(attempt.startedAt);
      const ended = attempt.endedAt === null ? null : Date.parse(attempt.endedAt);
      if (run.timeline.acceptedAt === null || began < Date.parse(run.timeline.acceptedAt) || (ended !== null && ended < began) || (run.timeline.finishedAt !== null && Math.max(began, ended ?? began) > Date.parse(run.timeline.finishedAt)) || (attempt.status !== 'unknown' && ended === null)) issues.push('invalid_attempt_interval');
      if (attempt.retryOf !== null) {
        const previous = run.attempts.slice(0, position).find(candidate => candidate.attemptId === attempt.retryOf);
        if (!previous || previous.endedAt === null || began < Date.parse(previous.endedAt)) issues.push('invalid_retry_lineage');
      }
    }
    const inputTokens = run.attempts.reduce((total, attempt) => total + BigInt(attempt.usage?.inputTokens ?? 0), 0n);
    const outputTokens = run.attempts.reduce((total, attempt) => total + BigInt(attempt.usage?.outputTokens ?? 0), 0n);
    if (inputTokens > BigInt(Number.MAX_SAFE_INTEGER) || outputTokens > BigInt(Number.MAX_SAFE_INTEGER)) issues.push('usage_overflow');
    return {
      caseId: item.caseId, model: fees(run.attempts.map(attempt => attempt.fee), issues),
      human: { manual: fees([run.humanFees.manual], issues), scoring: fees([run.humanFees.scoring], issues), secondReview: fees([run.humanFees.secondReview], issues) },
      attempts: { total: run.attempts.length, succeeded: run.attempts.filter(attempt => attempt.status === 'succeeded').length, failed: run.attempts.filter(attempt => attempt.status === 'failed').length, cancelled: run.attempts.filter(attempt => attempt.status === 'cancelled').length, unknown: run.attempts.filter(attempt => attempt.status === 'unknown').length },
      usage: { knownAttempts: run.attempts.filter(attempt => attempt.usage !== null).length, unknownAttempts: run.attempts.filter(attempt => attempt.usage === null).length, inputTokens: Number(inputTokens), outputTokens: Number(outputTokens) },
      indexCostRefs: run.indexCostRefs,
    };
  });
  const model = fees(results.runs.flatMap(run => run.attempts.map(attempt => attempt.fee)), issues);
  // A missing case ledger is unknown, not a zero-charge case.
  const missingLedgers = 24 - results.runs.length;
  if (missingLedgers) model.completeActualMicrousd = null;
  const labor = (kind: 'manual' | 'scoring' | 'secondReview') => {
    const result = fees(results.runs.map(run => run.humanFees[kind]), issues);
    if (missingLedgers) result.completeActualMicrousd = null;
    return { ...result, missingLedgers };
  };
  const human = { manual: labor('manual'), scoring: labor('scoring'), secondReview: labor('secondReview') };
  const indexSummary = (kind: 'initial' | 'update') => {
    const selected = results.indexing.filter(item => item.kind === kind);
    return { entries: selected.length, scopeRefs: [...new Set(selected.map(item => item.scopeRef))], jobMs: selected.reduce((total, item) => total + Date.parse(item.endedAt) - Date.parse(item.startedAt), 0), ...fees(selected.map(item => item.fee), issues) };
  };
  const indexing = { initial: indexSummary('initial'), update: indexSummary('update') };
  return { issues, cases, model: { ...model, missingLedgers }, human, indexing, scenes: scenes.map(scene => {
    const selected = cases.filter(item => round.cases.some(candidate => candidate.caseId === item.caseId && candidate.scene === scene));
    return { scene, actualModelMicrousd: describe(selected.map(item => item.model?.completeActualMicrousd ?? null), 12), actualManualMicrousd: describe(selected.map(item => item.human?.manual.completeActualMicrousd ?? null), 12), actualScoringMicrousd: describe(selected.map(item => item.human?.scoring.completeActualMicrousd ?? null), 12), actualSecondReviewMicrousd: describe(selected.map(item => item.human?.secondReview.completeActualMicrousd ?? null), 12) };
  }) };
}
