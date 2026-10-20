import { bundleSchema, gates, roundSchema, scenes } from './format.js';
import { reviewReports } from './review.js';
import { checkRecords } from './records.js';
import { measureTimes } from './time.js';
import { measureCosts } from './cost.js';

function actualStops(input: unknown): string[] {
  // Recognize only the finite failure signal; other missing/extra fields cannot erase a stop.
  if (!input || typeof input !== 'object' || !('results' in input)) return [];
  const results = input.results;
  if (!results || typeof results !== 'object' || !('gates' in results) || !Array.isArray(results.gates)) return [];
  return [...new Set(results.gates.flatMap(value => {
    if (!value || typeof value !== 'object' || !('gate' in value) || !('status' in value) || !('basis' in value)) return [];
    const gate = gates.find(candidate => candidate === value.gate);
    return gate && value.status === 'failed' && value.basis === 'actual' ? [gate] : [];
  }))];
}

export function evaluate(input: unknown) {
  const stopPaths = actualStops(input);
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) return { valid: false as const, decision: 'cannot_determine' as const, issues: ['invalid_format'], pending: ['invalid_format'], stopPaths };
  const { round, results } = parsed.data;
  const review = reviewReports(parsed.data);
  const records = checkRecords(parsed.data);
  const times = measureTimes(parsed.data);
  const costs = measureCosts(parsed.data);
  const issues = [...new Set([...records.issues, ...review.issues, ...times.issues, ...costs.issues])];
  if (issues.length) return { valid: false as const, decision: 'cannot_determine' as const, issues, pending: ['invalid_format'], stopPaths };
  const pending = [...new Set([...records.pending, ...review.pending, ...times.pending])];
  const sceneSummaries = scenes.map(scene => {
      const caseIds = new Set(round.cases.filter(item => item.scene === scene).map(item => item.caseId));
      const count = review.cases.filter(item => caseIds.has(item.caseId) && item.useful).length;
      const selected = review.cases.filter(item => caseIds.has(item.caseId));
      return { scene, frozen: caseIds.size, recorded: selected.filter(item => item.status !== 'missing').length, delivered: selected.filter(item => item.delivered).length, useful: count, denominator: 12 as const, thresholdMet: count >= 9,
        categories: { common: round.cases.filter(item => item.scene === scene && item.category === 'common').length, abnormal: round.cases.filter(item => item.scene === scene && item.category === 'abnormal').length, evidence_gap: round.cases.filter(item => item.scene === scene && item.category === 'evidence_gap').length },
        outcomes: { completed: selected.filter(item => item.status === 'completed').length, timeout: selected.filter(item => item.status === 'timeout').length, error: selected.filter(item => item.status === 'error').length, cancelled: selected.filter(item => item.status === 'cancelled').length, pending: selected.filter(item => item.status === 'pending').length, not_accepted: selected.filter(item => item.status === 'not_accepted').length, missing: 12 - selected.filter(item => item.status !== 'missing').length } };
  });
  const factTotal = review.cases.reduce((total, item) => total + item.facts.total, 0);
  const factSupported = review.cases.reduce((total, item) => total + item.facts.supported, 0);
  if (!factTotal) pending.push('zero_fact_denominator');
  const decision: 'cannot_determine' | 'no_go' | 'eligible_for_owner_decision' = pending.length ? 'cannot_determine' : stopPaths.length || sceneSummaries.some(scene => !scene.thresholdMet) || factSupported !== factTotal ? 'no_go' : 'eligible_for_owner_decision';
  return {
    schemaVersion: 'evaluation-summary-1' as const, roundId: round.roundId, kind: round.kind, versions: round.versions,
    valid: true as const, decision, pending, stopPaths, cases: review.cases, review: review.review, scenes: sceneSummaries,
    facts: { total: factTotal, supported: factSupported, coverage: factTotal ? factSupported / factTotal : null },
    times: { cases: times.cases, scenes: times.scenes },
    costs: { cases: costs.cases, model: costs.model, human: costs.human, indexing: costs.indexing, scenes: costs.scenes },
  };
}

/** Explicit allowlist: controlled references, review/approval records and expected answers are never projected. */
export function agentInputs(input: unknown) {
  const parsed = roundSchema.safeParse(input);
  if (!parsed.success || new Set(parsed.data.cases.map(item => item.caseId)).size !== parsed.data.cases.length) return { valid: false as const, issues: ['invalid_round'] };
  return { valid: true as const, inputs: { schemaVersion: 'evaluation-agent-inputs-1' as const, roundId: parsed.data.roundId, cases: parsed.data.cases.map(({ caseId, runId, scene, input }) => ({ caseId, runId, scene, input })) } };
}
