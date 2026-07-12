import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type {
  ReviewContext,
  ReviewContextAttachment,
  VerificationAssessment,
  VerificationFreshnessSignature,
  VerificationPolicy,
  VerificationRun
} from './verificationTypes';

export function normalizeRepoRoot(
  repoRoot: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized = path.normalize(path.resolve(repoRoot));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function createReviewContext(
  attachments: readonly ReviewContextAttachment[],
  now = Date.now()
): ReviewContext {
  if (attachments.length === 0) {
    throw new Error('A review context requires at least one attached session');
  }
  const sorted = [...attachments].sort(
    (left, right) =>
      left.baseline.capturedAt - right.baseline.capturedAt ||
      left.sessionId.localeCompare(right.sessionId)
  );
  const earliest = sorted[0];
  const repoRootKey = normalizeRepoRoot(earliest.repoRoot);
  assertSameRoot(sorted, repoRootKey);
  const createdAt = earliest.baseline.capturedAt;
  return {
    id: reviewContextId(repoRootKey, earliest.sessionId, createdAt),
    repoRoot: path.normalize(earliest.repoRoot),
    repoRootKey,
    ...(earliest.repositoryId
      ? { repositoryId: path.normalize(earliest.repositoryId) }
      : {}),
    baseline: {
      sessionId: earliest.sessionId,
      commit: earliest.baseline.commit,
      branch: earliest.baseline.branch,
      capturedAt: earliest.baseline.capturedAt
    },
    createdAt,
    updatedAt: now,
    status: 'active',
    attachedSessionIds: uniqueSessionIds(sorted)
  };
}

/**
 * Reconciles one active worktree campaign. Its baseline never moves after
 * creation, even when the earliest session is later removed. A new attachment
 * after closure starts a new context instead of reviving stale evidence.
 */
export function reconcileReviewContext(
  existing: ReviewContext | undefined,
  attachments: readonly ReviewContextAttachment[],
  now = Date.now()
): ReviewContext | undefined {
  if (!existing) {
    return attachments.length > 0
      ? createReviewContext(attachments, now)
      : undefined;
  }
  if (attachments.length === 0) {
    return existing.status === 'closed'
      ? existing
      : {
          ...existing,
          status: 'closed',
          attachedSessionIds: [],
          updatedAt: now,
          closedAt: now
        };
  }
  if (existing.status === 'closed') {
    return createReviewContext(attachments, now);
  }
  assertSameRoot(attachments, existing.repoRootKey);
  return {
    ...existing,
    attachedSessionIds: uniqueSessionIds(attachments),
    updatedAt: now
  };
}

export function assessVerification(
  policy: VerificationPolicy,
  run: VerificationRun | undefined,
  currentSignature: VerificationFreshnessSignature | undefined
): VerificationAssessment {
  if (!run) {
    return assessment('incomplete', false, ['no-run']);
  }
  if (run.policyId !== policy.id || run.policyRevision !== policy.revision) {
    return assessment('incomplete', false, ['policy-changed']);
  }
  const active =
    run.completedAt === undefined ||
    run.checks.some(
      (check) => check.outcome === 'pending' || check.outcome === 'running'
    );
  if (active) {
    return assessment('running', false, ['run-active']);
  }
  if (!run.signature || !currentSignature) {
    return assessment('incomplete', false, ['evidence-missing']);
  }
  if (!sameVerificationSignature(run.signature, currentSignature)) {
    return assessment('incomplete', true, ['evidence-stale']);
  }
  const requiredSteps = policy.steps.filter((step) => step.required !== false);
  if (requiredSteps.length === 0) {
    return assessment('incomplete', false, ['no-required-checks']);
  }
  const required = requiredSteps.map((step) =>
    run.checks.find((check) => check.stepId === step.id)
  );
  if (required.some((check) => check?.outcome === 'failed')) {
    return assessment('failed', false, ['required-check-failed']);
  }
  if (required.some((check) => check?.outcome !== 'passed')) {
    return assessment('incomplete', false, ['required-check-incomplete']);
  }
  return assessment('ready', false, []);
}

export function sameVerificationSignature(
  left: VerificationFreshnessSignature,
  right: VerificationFreshnessSignature
): boolean {
  return (
    left.gitHead === right.gitHead &&
    left.gitWorktree === right.gitWorktree &&
    left.diagnosticBaselineId === right.diagnosticBaselineId &&
    left.diagnosticGeneration === right.diagnosticGeneration
  );
}

function reviewContextId(
  repoRootKey: string,
  sessionId: string,
  createdAt: number
): string {
  const digest = createHash('sha256')
    .update(repoRootKey)
    .update('\0')
    .update(sessionId)
    .update('\0')
    .update(String(createdAt))
    .digest('hex')
    .slice(0, 16);
  return `review-${createdAt.toString(36)}-${digest}`;
}

function uniqueSessionIds(
  attachments: readonly ReviewContextAttachment[]
): string[] {
  return [...new Set(attachments.map((attachment) => attachment.sessionId))];
}

function assertSameRoot(
  attachments: readonly ReviewContextAttachment[],
  expectedRootKey: string
): void {
  if (
    attachments.some(
      (attachment) => normalizeRepoRoot(attachment.repoRoot) !== expectedRootKey
    )
  ) {
    throw new Error('A review context cannot span physical worktree roots');
  }
}

function assessment(
  state: VerificationAssessment['state'],
  stale: boolean,
  reasons: VerificationAssessment['reasons']
): VerificationAssessment {
  return { state, stale, reasons };
}
