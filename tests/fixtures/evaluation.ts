import { createHash } from 'node:crypto';
// Synthetic arithmetic examples only. These are not actual pilot observations or ratings.
export function evaluationExample(simulatorUseful = 9, pspUseful = 9) {
  const versions = { application: 'app-1', artifact: 'artifact-1', skill: 'skill-1', prompt: 'prompt-1', manifest: 'manifest-1', policy: 'policy-1', modelRoute: 'model-1', dependencies: 'deps-1' };
  const cases = (['simulator', 'psp'] as const).flatMap(scene => Array.from({ length: 12 }, (_, i) => ({
    caseId: `${scene}-${i + 1}`, runId: `run-${scene}-${i + 1}`, scene, category: 'common' as const,
    referenceId: `reference-${scene}-${i + 1}`, source: 'synthetic' as 'synthetic' | 'actual', sampleApprovalRef: null as string | null,
    materials: 'ready' as const,
    input: { question: 'Synthetic troubleshooting question', supplements: ['Synthetic supplement'], resourceRefs: ['synthetic-source'], logWindow: null, snapshotRef: 'snapshot-1', indexRef: 'index-1' },
  })));
  const rating = (score: number, reviewerId: string) => ({ reviewerId, score, reason: 'Synthetic rating rationale', criticalError: false, misleading: false, missingEvidence: false, missingNecessaryContent: score < 4, checkedKeys: ['check-1'], reviewedAt: '2026-10-02T00:10:00.000Z' });
  const runs = cases.map((item, i) => {
    const qualified = i < 12 ? i < simulatorUseful : i - 12 < pspUseful;
    return {
      caseId: item.caseId, runId: item.runId, versions: { ...versions }, priorRunRef: null as string | null,
      status: 'completed' as string, failureRef: null as string | null,
      report: { originalRef: `report-${item.caseId}`, digest: 'a'.repeat(64), editedRef: null as string | null, deliveredAt: '2026-10-02T00:05:00.000Z' as string | null, diagnostic: qualified ? 'lead' : 'insufficient_evidence', criticalFactIds: ['fact-1'] },
      factChecks: [{ factId: 'fact-1', evidenceRefs: ['evidence-1'], support: 'supported', reviewerId: 'reviewer-1', checkedAt: '2026-10-02T00:09:00.000Z' }],
      primary: rating(qualified ? 4 : 3, 'reviewer-1'), secondary: { ...rating(qualified ? 4 : 3, 'reviewer-2'), reviewedAt: '2026-10-02T00:12:00.000Z' }, disputed: false,
      resolution: null as null | { reviewerId: string; chosen: string; basisRef: string; at: string },
      timeline: { receivedAt: '2026-10-02T00:00:00.000Z', acceptedAt: '2026-10-02T00:01:00.000Z' as string | null, finishedAt: '2026-10-02T00:05:00.000Z' as string | null, clue: null as null | { deliveredAt: string; deliveryRef: string; safe: boolean; supported: boolean; evidenceRefs: string[]; reviewerId: string; checkedAt: string }, phases: [{ id: 'phase-1', startedAt: '2026-10-02T00:01:00.000Z', endedAt: '2026-10-02T00:05:00.000Z' }], waits: [] as { id: string; kind: string; startedAt: string; endedAt: string }[], humanWork: [] as { id: string; actorId: string; kind: string; startedAt: string; endedAt: string }[] },
      attemptIds: ['attempt-1'], attempts: [{ attemptId: 'attempt-1', retryOf: null as string | null, status: 'succeeded', startedAt: '2026-10-02T00:01:00.000Z', endedAt: '2026-10-02T00:04:00.000Z' as string | null, usage: { sourceRef: 'usage-1', inputTokens: 100, outputTokens: 20 } as { sourceRef: string; inputTokens: number; outputTokens: number } | null, fee: { actualMicrousd: 100 as number | null, actualSourceRef: 'invoice-1' as string | null, estimatedMicrousd: 120 as number | null, reservedMicrousd: 0 } }], indexCostRefs: ['index-cost-1'],
      humanFees: { manual: { actualMicrousd: null as number | null, actualSourceRef: null as string | null, estimatedMicrousd: null as number | null, reservedMicrousd: 0 }, scoring: { actualMicrousd: null as number | null, actualSourceRef: null as string | null, estimatedMicrousd: null as number | null, reservedMicrousd: 0 }, secondReview: { actualMicrousd: null as number | null, actualSourceRef: null as string | null, estimatedMicrousd: null as number | null, reservedMicrousd: 0 } }, limitations: [] as string[],
    };
  });
  return {
    round: { schemaVersion: 'evaluation-round-1', roundId: 'synthetic-round-1', kind: 'synthetic' as 'synthetic' | 'formal', frozenAt: '2026-10-01T00:00:00.000Z', previousRoundRef: null as string | null, archiveRef: null as string | null, ownerId: 'owner-1', versions, reviewers: [{ id: 'reviewer-1', qualified: true, scenes: ['simulator', 'psp'] }, { id: 'reviewer-2', qualified: true, scenes: ['simulator', 'psp'] }, { id: 'owner-1', qualified: true, scenes: ['simulator', 'psp'] }], businessReviewers: { simulator: 'reviewer-1', psp: 'reviewer-1' }, sampling: { seed: 'precommitted-synthetic-seed', basisRef: 'seed-receipt-1', committedAt: '2026-10-01T00:00:00.000Z' }, cases },
    references: { schemaVersion: 'evaluation-references-1', roundId: 'synthetic-round-1', answers: cases.map(item => ({ caseId: item.caseId, referenceId: item.referenceId, conclusion: 'CONTROLLED SYNTHETIC ANSWER — never Agent input', keyChecks: [{ checkId: 'check-1', description: 'CONTROLLED required synthetic check' }] })) },
    results: { schemaVersion: 'evaluation-results-1', roundId: 'synthetic-round-1', runs, sampling: { poolCaseIds: runs.filter(run => run.primary.score >= 4).map(run => run.caseId), selectedCaseIds: runs.filter(run => run.primary.score >= 4).map(run => run.caseId).sort((a, b) => createHash('sha256').update(`precommitted-synthetic-seed\n${a}`).digest('hex').localeCompare(createHash('sha256').update(`precommitted-synthetic-seed\n${b}`).digest('hex'))), drawnAt: '2026-10-02T00:11:00.000Z', basisRef: 'draw-receipt-1' }, gates: ['identity', 'authorization', 'read_only', 'sanitization', 'isolation', 'audience', 'audit', 'versions', 'budget', 'dependencies', 'deployment'].map(gate => ({ gate, status: 'passed', basis: 'synthetic', evidenceRef: 'validation-1' as string | null })), indexing: [{ costId: 'index-cost-1', kind: 'initial', scopeRef: 'shared-index-1', startedAt: '2026-10-01T01:00:00.000Z', endedAt: '2026-10-01T01:10:00.000Z', fee: { actualMicrousd: 500 as number | null, actualSourceRef: 'index-invoice-1' as string | null, estimatedMicrousd: null as number | null, reservedMicrousd: 0 } }], limitations: [] as string[] },
  };
}
