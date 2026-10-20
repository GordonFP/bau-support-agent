import { scenes, type EvaluationBundle } from './format.js';
import { duplicate, reviewerQualified } from './review.js';

type Interval = { startedAt: string; endedAt: string };
const start = (item: Interval) => Date.parse(item.startedAt);
const end = (item: Interval) => Date.parse(item.endedAt);
const overlaps = (a: Interval, b: Interval) => start(a) < end(b) && start(b) < end(a);
const inside = (item: Interval, from: number, to: number) => start(item) >= from && end(item) <= to && end(item) >= start(item);

function unionMs(items: Interval[]): number {
  let total = 0;
  let through = -Infinity;
  for (const item of [...items].sort((a, b) => start(a) - start(b))) {
    total += Math.max(0, end(item) - Math.max(through, start(item)));
    through = Math.max(through, end(item));
  }
  return total;
}

export function describe(values: (number | null)[], denominator = values.length) {
  const valid = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  const middle = Math.floor(valid.length / 2);
  const median = valid.length ? valid.length % 2 ? valid[middle]! : valid[middle - 1]! / 2 + valid[middle]! / 2 : null;
  return { valid: valid.length, missing: denominator - valid.length, min: valid[0] ?? null, median, max: valid.at(-1) ?? null };
}

export function measureTimes({ round, results }: EvaluationBundle) {
  const issues: string[] = [];
  const work = results.runs.flatMap(run => run.timeline.humanWork);
  for (const [index, item] of work.entries()) {
    if (work.slice(index + 1).some(other => item.actorId === other.actorId && overlaps(item, other))) issues.push('human_work_overlap');
  }
  const cases = round.cases.map(item => {
    const run = results.runs.find(candidate => candidate.caseId === item.caseId);
    if (!run) return { caseId: item.caseId, clueMs: null, reportMs: null, phaseMs: null, waitMs: { queue: null, tool: null, model: null, clarification: null }, manualMs: null, scoringMs: null, secondReviewMs: null };
    const time = run.timeline;
    const received = Date.parse(time.receivedAt);
    const accepted = time.acceptedAt === null ? null : Date.parse(time.acceptedAt);
    const finished = time.finishedAt === null ? null : Date.parse(time.finishedAt);
    const delivered = run.report?.deliveredAt ? Date.parse(run.report.deliveredAt) : null;
    if ((accepted !== null && accepted < received) || (finished !== null && finished < (accepted ?? received)) || (run.status !== 'pending' && finished === null) || (run.status === 'pending' && finished !== null)) issues.push('invalid_lifecycle_order');
    if (accepted === null && (delivered !== null || time.clue || time.phases.length || time.waits.length || run.attempts.length)) issues.push('work_without_acceptance');
    if (run.status === 'not_accepted' && accepted !== null) issues.push('invalid_lifecycle_order');
    if (run.status === 'completed' && delivered === null) issues.push('completed_without_delivery');
    if (delivered !== null && (accepted === null || finished === null || delivered < accepted || delivered > finished)) issues.push('invalid_delivery_order');
    if (duplicate([...time.phases, ...time.waits, ...time.humanWork].map(interval => interval.id))) issues.push('duplicate_time_interval');
    if (time.phases.some((phase, index) => !inside(phase, accepted ?? Infinity, finished ?? Infinity) || (index > 0 && start(phase) < end(time.phases[index - 1]!)))) issues.push('phase_overlap_or_order');
    if (time.waits.some(wait => !inside(wait, accepted ?? Infinity, finished ?? Infinity) || (['tool', 'model'].includes(wait.kind) && !time.phases.some(phase => inside(wait, start(phase), end(phase)))) || (wait.kind === 'clarification' && time.phases.some(phase => overlaps(wait, phase))))) issues.push('invalid_wait_interval');
    for (const human of time.humanWork) {
      if (!inside(human, received, Infinity)) issues.push('invalid_human_interval');
      if (human.kind === 'score' || human.kind === 'second_review') {
        const rating = human.kind === 'score' ? run.primary : run.secondary;
        if (delivered === null || !rating || human.actorId !== rating.reviewerId || !inside(human, delivered, Date.parse(rating.reviewedAt))) issues.push('invalid_review_interval');
      }
    }
    const clue = time.clue;
    if (clue && (accepted === null || finished === null || Date.parse(clue.deliveredAt) < accepted || Date.parse(clue.deliveredAt) > finished || (delivered !== null && Date.parse(clue.deliveredAt) > delivered))) issues.push('invalid_clue_order');
    if (clue && (!reviewerQualified(round, clue.reviewerId, item.scene) || Date.parse(clue.checkedAt) < Date.parse(clue.deliveredAt))) issues.push('invalid_clue_review');
    return {
      caseId: item.caseId,
      clueMs: clue?.safe && clue.supported && accepted !== null ? Date.parse(clue.deliveredAt) - accepted : null,
      reportMs: delivered !== null && accepted !== null ? delivered - accepted : null,
      phaseMs: unionMs(time.phases),
      waitMs: { queue: unionMs(time.waits.filter(wait => wait.kind === 'queue')), tool: unionMs(time.waits.filter(wait => wait.kind === 'tool')), model: unionMs(time.waits.filter(wait => wait.kind === 'model')), clarification: unionMs(time.waits.filter(wait => wait.kind === 'clarification')) },
      manualMs: time.humanWork.filter(human => !['score', 'second_review'].includes(human.kind)).reduce((total, human) => total + end(human) - start(human), 0),
      scoringMs: time.humanWork.filter(human => human.kind === 'score').reduce((total, human) => total + end(human) - start(human), 0),
      secondReviewMs: time.humanWork.filter(human => human.kind === 'second_review').reduce((total, human) => total + end(human) - start(human), 0),
    };
  });
  if (cases.some(item => [item.phaseMs, item.manualMs, item.scoringMs, item.secondReviewMs, ...Object.values(item.waitMs)].some(value => value !== null && !Number.isSafeInteger(value)))) issues.push('time_overflow');
  return { issues, cases, scenes: scenes.map(scene => {
    const selected = cases.filter(item => round.cases.some(candidate => candidate.caseId === item.caseId && candidate.scene === scene));
    return { scene, clueMs: describe(selected.map(item => item.clueMs), 12), reportMs: describe(selected.map(item => item.reportMs), 12), phaseMs: describe(selected.map(item => item.phaseMs), 12), manualMs: describe(selected.map(item => item.manualMs), 12), scoringMs: describe(selected.map(item => item.scoringMs), 12), secondReviewMs: describe(selected.map(item => item.secondReviewMs), 12), waitMs: { queue: describe(selected.map(item => item.waitMs.queue), 12), tool: describe(selected.map(item => item.waitMs.tool), 12), model: describe(selected.map(item => item.waitMs.model), 12), clarification: describe(selected.map(item => item.waitMs.clarification), 12) } };
  }) };
}
