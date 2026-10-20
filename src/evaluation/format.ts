import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/);
const text = z.string().min(1).max(16_384);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const scenes = ['simulator', 'psp'] as const;
const scene = z.enum(scenes);

// The offline interchange format uses UTC explicitly; parsing must not normalize impossible dates.
function utc(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || year < 2000 || month === undefined || month < 1 || month > 12 || day === undefined || day < 1 || hour === undefined || hour > 23 || minute === undefined || minute > 59 || second === undefined || second > 59) return false;
  return new Date(Date.UTC(year, month - 1, day)).getUTCMonth() === month - 1;
}
const timestamp = z.string().max(24).refine(utc);
export const versionsSchema = z.strictObject({ application: id, artifact: id, skill: id, prompt: id, manifest: id, policy: id, modelRoute: id, dependencies: id });
const interval = { id, startedAt: timestamp, endedAt: timestamp };
const feeSchema = z.strictObject({ actualMicrousd: count.nullable(), actualSourceRef: id.nullable(), estimatedMicrousd: count.nullable(), reservedMicrousd: count });
const ratingSchema = z.strictObject({ reviewerId: id, score: z.number().int().min(1).max(5), reason: text, criticalError: z.boolean(), misleading: z.boolean(), missingEvidence: z.boolean(), missingNecessaryContent: z.boolean(), checkedKeys: z.array(id).max(128), reviewedAt: timestamp });

export const roundSchema = z.strictObject({
  schemaVersion: z.literal('evaluation-round-1'), roundId: id, kind: z.enum(['synthetic', 'formal']), frozenAt: timestamp,
  previousRoundRef: id.nullable(), archiveRef: id.nullable(), ownerId: id, versions: versionsSchema,
  reviewers: z.array(z.strictObject({ id, qualified: z.boolean(), scenes: z.array(scene).min(1).max(2) })).max(32),
  businessReviewers: z.strictObject({ simulator: id, psp: id }),
  sampling: z.strictObject({ seed: id, basisRef: id, committedAt: timestamp }),
  cases: z.array(z.strictObject({
    caseId: id, runId: id, scene, category: z.enum(['common', 'abnormal', 'evidence_gap']), referenceId: id,
    source: z.enum(['synthetic', 'actual']), sampleApprovalRef: id.nullable(), materials: z.enum(['ready', 'missing']),
    input: z.strictObject({ question: text, supplements: z.array(text).max(32), resourceRefs: z.array(id).min(1).max(3), logWindow: z.strictObject({ start: timestamp, end: timestamp }).nullable(), snapshotRef: id, indexRef: id }),
  })).max(24),
});
export const referencesSchema = z.strictObject({
  schemaVersion: z.literal('evaluation-references-1'), roundId: id,
  answers: z.array(z.strictObject({ caseId: id, referenceId: id, conclusion: text, keyChecks: z.array(z.strictObject({ checkId: id, description: text })).min(1).max(128) })).max(24),
});
export const gates = ['identity', 'authorization', 'read_only', 'sanitization', 'isolation', 'audience', 'audit', 'versions', 'budget', 'dependencies', 'deployment'] as const;
export const gateSchema = z.strictObject({ gate: z.enum(gates), status: z.enum(['passed', 'failed', 'pending']), basis: z.enum(['actual', 'synthetic']), evidenceRef: id.nullable() });
export const resultsSchema = z.strictObject({
  schemaVersion: z.literal('evaluation-results-1'), roundId: id,
  runs: z.array(z.strictObject({
    caseId: id, runId: id, versions: versionsSchema, priorRunRef: id.nullable(), status: z.enum(['completed', 'timeout', 'error', 'cancelled', 'pending', 'not_accepted']), failureRef: id.nullable(),
    report: z.strictObject({ originalRef: id, digest: z.string().regex(/^[a-f0-9]{64}$/), editedRef: id.nullable(), deliveredAt: timestamp.nullable(), diagnostic: z.enum(['located', 'lead', 'insufficient_evidence']), criticalFactIds: z.array(id).max(128) }).nullable(),
    factChecks: z.array(z.strictObject({ factId: id, evidenceRefs: z.array(id).max(128), support: z.enum(['supported', 'unsupported', 'pending']), reviewerId: id, checkedAt: timestamp })).max(128),
    primary: ratingSchema.nullable(), secondary: ratingSchema.nullable(), disputed: z.boolean(),
    resolution: z.strictObject({ reviewerId: id, chosen: z.enum(['primary', 'secondary']), basisRef: id, at: timestamp }).nullable(),
    timeline: z.strictObject({ receivedAt: timestamp, acceptedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), clue: z.strictObject({ deliveredAt: timestamp, deliveryRef: id, safe: z.boolean(), supported: z.boolean(), evidenceRefs: z.array(id).min(1).max(128), reviewerId: id, checkedAt: timestamp }).nullable(), phases: z.array(z.strictObject(interval)).max(32), waits: z.array(z.strictObject({ ...interval, kind: z.enum(['queue', 'tool', 'model', 'clarification']) })).max(256), humanWork: z.array(z.strictObject({ ...interval, actorId: id, kind: z.enum(['operation', 'read', 'verify', 'edit', 'score', 'second_review']) })).max(256) }),
    attemptIds: z.array(id).max(256),
    attempts: z.array(z.strictObject({ attemptId: id, retryOf: id.nullable(), status: z.enum(['succeeded', 'failed', 'cancelled', 'unknown']), startedAt: timestamp, endedAt: timestamp.nullable(), usage: z.strictObject({ sourceRef: id, inputTokens: count, outputTokens: count }).nullable(), fee: feeSchema })).max(256),
    indexCostRefs: z.array(id).max(32),
    humanFees: z.strictObject({ manual: feeSchema, scoring: feeSchema, secondReview: feeSchema }), limitations: z.array(text).max(32),
  })).max(24),
  sampling: z.strictObject({ poolCaseIds: z.array(id).max(24), selectedCaseIds: z.array(id).max(24), drawnAt: timestamp, basisRef: id }).nullable(),
  gates: z.array(gateSchema).max(gates.length),
  indexing: z.array(z.strictObject({ costId: id, kind: z.enum(['initial', 'update']), scopeRef: id, startedAt: timestamp, endedAt: timestamp, fee: feeSchema })).max(32),
  limitations: z.array(text).max(32),
});
export const bundleSchema = z.strictObject({ round: roundSchema, references: referencesSchema, results: resultsSchema });
export type EvaluationBundle = z.infer<typeof bundleSchema>;
export type Round = EvaluationBundle['round'];
export type Run = EvaluationBundle['results']['runs'][number];
export type Rating = NonNullable<Run['primary']>;
export type Fee = z.infer<typeof feeSchema>;
