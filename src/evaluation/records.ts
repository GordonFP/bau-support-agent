import { gates, type EvaluationBundle } from './format.js';
import { duplicate, reviewerQualified } from './review.js';

export function checkRecords({ round, references, results }: EvaluationBundle) {
  const issues: string[] = [];
  const pending: string[] = [];
  if (round.roundId !== references.roundId || round.roundId !== results.roundId) issues.push('round_mismatch');
  if (duplicate(round.cases.map(item => item.caseId)) || duplicate(round.cases.map(item => item.runId)) || duplicate(round.cases.map(item => item.referenceId)) || duplicate(results.runs.map(run => run.caseId)) || duplicate(results.runs.map(run => run.runId)) || duplicate(references.answers.map(answer => answer.caseId)) || duplicate(references.answers.map(answer => answer.referenceId)) || duplicate(round.reviewers.map(reviewer => reviewer.id))) issues.push('duplicate_identity');
  if ((round.previousRoundRef === null) !== (round.archiveRef === null) || round.previousRoundRef === round.roundId) issues.push('invalid_retest_lineage');
  if (Date.parse(round.sampling.committedAt) > Date.parse(round.frozenAt)) issues.push('seed_not_precommitted');
  for (const scene of ['simulator', 'psp'] as const) {
    const count = round.cases.filter(item => item.scene === scene).length;
    if (count < 12) pending.push('missing_frozen_cases');
    if (count > 12) issues.push('case_distribution');
    if (['common', 'abnormal', 'evidence_gap'].some(category => !round.cases.some(item => item.scene === scene && item.category === category))) pending.push('missing_category_coverage');
    if (!reviewerQualified(round, round.businessReviewers[scene], scene)) pending.push('missing_business_reviewer');
  }
  for (const item of round.cases) {
    if (round.kind !== 'formal') pending.push('synthetic_only');
    if (item.source !== 'actual') pending.push('missing_actual_samples');
    if (!item.sampleApprovalRef) pending.push('missing_sample_approval');
    if (item.materials !== 'ready') pending.push('missing_materials');
    if (duplicate(item.input.resourceRefs) || (item.input.logWindow && Date.parse(item.input.logWindow.start) > Date.parse(item.input.logWindow.end))) issues.push('invalid_case_scope');
    const answer = references.answers.find(candidate => candidate.caseId === item.caseId);
    if (!answer) pending.push('missing_reference_material');
    else if (answer.referenceId !== item.referenceId || duplicate(answer.keyChecks.map(check => check.checkId))) issues.push('reference_mismatch');
    const run = results.runs.find(candidate => candidate.caseId === item.caseId);
    if (!run) { pending.push('missing_run_record'); continue; }
    if (run.runId !== item.runId) issues.push('run_replacement');
    if (Object.entries(round.versions).some(([key, value]) => run.versions[key as keyof typeof run.versions] !== value)) issues.push('version_mismatch');
    if ((round.previousRoundRef === null) !== (run.priorRunRef === null) || run.priorRunRef === run.runId) issues.push('invalid_retest_lineage');
    if (Date.parse(run.timeline.receivedAt) < Date.parse(round.frozenAt)) issues.push('run_before_freeze');
    if (run.status === 'pending') pending.push('unfinished_run');
    if (['timeout', 'error', 'cancelled', 'not_accepted'].includes(run.status) && !run.failureRef) pending.push('missing_failure_record');
  }
  if (results.runs.some(run => !round.cases.some(item => item.caseId === run.caseId)) || references.answers.some(answer => !round.cases.some(item => item.caseId === answer.caseId))) issues.push('foreign_case_record');
  if (duplicate(results.gates.map(gate => gate.gate))) issues.push('duplicate_gate');
  for (const required of gates) {
    const gate = results.gates.find(candidate => candidate.gate === required);
    if (!gate || gate.status === 'pending' || gate.basis !== 'actual' || !gate.evidenceRef) pending.push('missing_required_validation');
  }
  return { issues, pending };
}
