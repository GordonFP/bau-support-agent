import { createHash } from 'node:crypto';
import type { EvaluationBundle, Rating, Round, Run } from './format.js';

export function ratingUseful(rating: Rating | null): boolean {
  return rating !== null && rating.score >= 4 && !rating.criticalError && !rating.misleading && !rating.missingEvidence && !rating.missingNecessaryContent;
}
const sameRating = (a: Rating, b: Rating) => a.score === b.score && a.criticalError === b.criticalError && a.misleading === b.misleading && a.missingEvidence === b.missingEvidence && a.missingNecessaryContent === b.missingNecessaryContent;
export const duplicate = (values: readonly string[]) => new Set(values).size !== values.length;
export const sameSet = (a: readonly string[], b: readonly string[]) => !duplicate(a) && !duplicate(b) && a.length === b.length && a.every(value => b.includes(value));

export function reviewerQualified(round: Round, reviewerId: string, scene: Round['cases'][number]['scene']): boolean {
  return round.reviewers.some(reviewer => reviewer.id === reviewerId && reviewer.qualified && reviewer.scenes.includes(scene));
}

function ratingIssues(round: Round, run: Run, rating: Rating, scene: Round['cases'][number]['scene'], keys: string[] | undefined, second: boolean): string[] {
  const issues: string[] = [];
  if (!reviewerQualified(round, rating.reviewerId, scene) || (second && rating.reviewerId === run.primary?.reviewerId)) issues.push('reviewer_not_qualified');
  if (!second && rating.reviewerId !== round.businessReviewers[scene]) issues.push('unexpected_primary_reviewer');
  if (duplicate(rating.checkedKeys) || (keys && rating.checkedKeys.some(key => !keys.includes(key)))) issues.push('reference_check_mismatch');
  if (Date.parse(rating.reviewedAt) < Date.parse(run.report?.deliveredAt ?? rating.reviewedAt)) issues.push('review_before_delivery');
  return issues;
}

export function reviewReports(bundle: EvaluationBundle) {
  const { round, references, results } = bundle;
  const issues: string[] = [];
  const pending: string[] = [];
  const initialPool = results.runs.filter(run => run.report?.deliveredAt && ratingUseful(run.primary)).map(run => run.caseId);
  const randomMinimum = Math.ceil(initialPool.length / 4);
  const selection = results.sampling;
  if (!selection) pending.push('missing_sampling');
  else {
    if (!sameSet(initialPool, selection.poolCaseIds)) issues.push('sampling_pool_mismatch');
    const ranked = initialPool.map(caseId => ({ caseId, rank: createHash('sha256').update(`${round.sampling.seed}\n${caseId}`).digest('hex') })).sort((a, b) => a.rank.localeCompare(b.rank) || a.caseId.localeCompare(b.caseId)).map(item => item.caseId);
    if (duplicate(selection.selectedCaseIds) || !sameSet(selection.selectedCaseIds, ranked.slice(0, selection.selectedCaseIds.length))) issues.push('sampling_selection_mismatch');
    if (selection.selectedCaseIds.length < randomMinimum) pending.push('insufficient_random_sample');
    if (Date.parse(selection.drawnAt) < Date.parse(round.sampling.committedAt) || results.runs.some(run => run.primary && Date.parse(selection.drawnAt) < Date.parse(run.primary.reviewedAt))) issues.push('sampling_before_primary_pool');
  }
  const cases = round.cases.map(item => {
    const run = results.runs.find(candidate => candidate.caseId === item.caseId);
    const delivered = Boolean(run?.report?.deliveredAt);
    const initialQualified = delivered && ratingUseful(run?.primary ?? null);
    const selected = Boolean(selection?.selectedCaseIds.includes(item.caseId));
    const secondRequired = delivered && (!initialQualified || Boolean(run?.disputed) || selected || Boolean(run?.factChecks.some(check => check.support === 'unsupported')));
    const answer = references.answers.find(candidate => candidate.caseId === item.caseId);
    const keys = answer?.keyChecks.map(check => check.checkId) ?? [];
    const facts = run?.report?.criticalFactIds ?? [];
    const checked = run?.factChecks ?? [];
    if (duplicate(facts) || duplicate(checked.map(check => check.factId)) || checked.some(check => !facts.includes(check.factId))) issues.push('fact_inventory_mismatch');
    if (checked.some(check => !reviewerQualified(round, check.reviewerId, item.scene) || (check.support === 'supported' && check.evidenceRefs.length === 0))) issues.push('fact_review_invalid');
    const acceptedAt = run?.timeline.acceptedAt;
    const reviewFrom = acceptedAt ? Math.max(Date.parse(round.frozenAt), Date.parse(acceptedAt)) : Infinity;
    if (checked.some(check => Date.parse(check.checkedAt) < reviewFrom)) issues.push('fact_review_before_run');
    const supported = facts.filter(fact => checked.some(check => check.factId === fact && check.support === 'supported')).length;
    const factsPending = delivered && facts.some(fact => !checked.some(check => check.factId === fact && check.support !== 'pending'));
    if (factsPending) pending.push('missing_fact_review');
    const factsSupported = supported === facts.length;
    let reviewStatus: 'not_delivered' | 'missing' | 'pending_second' | 'unresolved' | 'resolved' | 'primary' = delivered ? 'missing' : 'not_delivered';
    let rating: Rating | null = run?.primary ?? null;
    if (run?.primary) issues.push(...ratingIssues(round, run, run.primary, item.scene, answer ? keys : undefined, false));
    if (run?.secondary) issues.push(...ratingIssues(round, run, run.secondary, item.scene, answer ? keys : undefined, true));
    if (!delivered && (run?.primary || run?.secondary || run?.resolution || run?.disputed)) issues.push('rating_without_delivery');
    if (delivered && !run?.primary) pending.push('missing_primary_review');
    if (delivered && run?.primary) {
      reviewStatus = 'primary';
      if (!keys.every(key => run.primary!.checkedKeys.includes(key))) pending.push('missing_reference_checks');
      if (secondRequired && !run.secondary) {
        reviewStatus = 'pending_second';
        pending.push('missing_second_review');
      }
      if (run.secondary) {
        if (!keys.every(key => run.secondary!.checkedKeys.includes(key))) pending.push('missing_reference_checks');
        if (Date.parse(run.secondary.reviewedAt) < Date.parse(run.primary.reviewedAt) || (selected && selection && Date.parse(run.secondary.reviewedAt) < Date.parse(selection.drawnAt))) issues.push('second_review_order');
        const disagreement = run.disputed || !sameRating(run.primary, run.secondary);
        if (disagreement && !run.resolution) {
          reviewStatus = 'unresolved';
          pending.push('unresolved_review');
        } else if (run.resolution) {
          if (!reviewerQualified(round, run.resolution.reviewerId, item.scene) || Date.parse(run.resolution.at) < Math.max(Date.parse(run.primary.reviewedAt), Date.parse(run.secondary.reviewedAt))) issues.push('invalid_resolution');
          rating = run.resolution.chosen === 'primary' ? run.primary : run.secondary;
          reviewStatus = 'resolved';
        } else reviewStatus = 'resolved';
      } else if (run.resolution) issues.push('resolution_without_second_review');
    }
    const reviewsComplete = Boolean(run?.primary) && keys.every(key => run?.primary?.checkedKeys.includes(key)) && (!secondRequired || Boolean(run?.secondary)) && (!run?.secondary || keys.every(key => run.secondary?.checkedKeys.includes(key)));
    const useful = delivered && ratingUseful(rating) && factsSupported && !factsPending && reviewsComplete && (reviewStatus === 'resolved' || reviewStatus === 'primary') && Boolean(answer);
    return { caseId: item.caseId, scene: item.scene, delivered, diagnostic: run?.report?.diagnostic ?? null, status: run?.status ?? 'missing', initialQualified, selected, secondRequired, reviewStatus, reviewsComplete, useful, facts: { total: delivered ? facts.length : 0, supported: delivered ? supported : 0, coverage: delivered && facts.length > 0 ? supported / facts.length : null } };
  });
  return { cases, review: { initialQualified: initialPool.length, randomMinimum, selected: selection?.selectedCaseIds.length ?? 0, requiredSecond: cases.filter(item => item.secondRequired).length, completedSecond: cases.filter(item => item.secondRequired && item.reviewsComplete && item.reviewStatus === 'resolved').length }, issues, pending };
}
