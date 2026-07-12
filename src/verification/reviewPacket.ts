import { createHash } from 'node:crypto';
import type { GitReviewEvidence } from './gitEvidenceTypes';
import type { DiagnosticDeltaEvidence } from './diagnosticEvidence';
import {
  assessVerification
} from './verificationModel';
import type {
  ReviewContext,
  VerificationAssessment,
  VerificationFreshnessSignature,
  VerificationPolicy,
  VerificationRun,
  VerificationState
} from './verificationTypes';

export interface ReviewPacketReadiness {
  readonly state: VerificationState;
  readonly reasons: readonly string[];
}

export interface ReviewPacket {
  readonly context: ReviewContext;
  readonly collectedAt: number;
  readonly attribution: 'isolated' | 'shared';
  readonly git: GitReviewEvidence;
  readonly diagnostics: DiagnosticDeltaEvidence;
  readonly latestRun?: VerificationRun;
  readonly assessment?: VerificationAssessment;
  readonly signature: VerificationFreshnessSignature;
  readonly readiness: ReviewPacketReadiness;
}

export interface BuildReviewPacketInput {
  readonly context: ReviewContext;
  readonly git: GitReviewEvidence;
  readonly diagnostics: DiagnosticDeltaEvidence;
  readonly gitWorktreeFingerprint?: string;
  readonly policy?: VerificationPolicy;
  readonly latestRun?: VerificationRun;
  readonly now?: number;
}

export function buildReviewPacket(input: BuildReviewPacketInput): ReviewPacket {
  const signature: VerificationFreshnessSignature = {
    gitHead: input.git.commit,
    gitWorktree:
      input.gitWorktreeFingerprint ?? fingerprintGitEvidence(input.git),
    diagnosticBaselineId: input.diagnostics.baselineId,
    diagnosticGeneration: input.diagnostics.generation
  };
  const assessment = input.policy
    ? assessVerification(input.policy, input.latestRun, signature)
    : undefined;
  return {
    context: input.context,
    collectedAt: input.now ?? Date.now(),
    attribution:
      input.context.attachedSessionIds.length === 1 ? 'isolated' : 'shared',
    git: input.git,
    diagnostics: input.diagnostics,
    ...(input.latestRun ? { latestRun: input.latestRun } : {}),
    ...(assessment ? { assessment } : {}),
    signature,
    readiness: packetReadiness(assessment, input.git, input.diagnostics)
  };
}

/**
 * Fallback freshness key from available Git metadata. Integrations may inject
 * a stronger worktree fingerprint when available without changing the packet.
 */
export function fingerprintGitEvidence(git: GitReviewEvidence): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        commit: git.commit,
        branch: git.branch,
        workingTree: git.workingTree,
        diff: {
          files: git.diff.files,
          additions: git.diff.additions,
          deletions: git.diff.deletions,
          binaryFiles: git.diff.binaryFiles,
          untrackedFiles: git.diff.untrackedFiles,
          entries: git.diff.entries
        },
        conflicts: git.conflicts
      })
    )
    .digest('hex');
}

function packetReadiness(
  assessment: VerificationAssessment | undefined,
  git: GitReviewEvidence,
  diagnostics: DiagnosticDeltaEvidence
): ReviewPacketReadiness {
  if (!assessment) {
    return { state: 'incomplete', reasons: ['verification policy unavailable'] };
  }
  if (assessment.state === 'running' || assessment.state === 'failed') {
    return { state: assessment.state, reasons: assessment.reasons };
  }
  const evidenceReasons = [
    ...(git.state === 'complete'
      ? []
      : [`Git evidence is ${git.state}`, ...git.reasons]),
    ...(diagnostics.state === 'complete'
      ? []
      : [`Diagnostic evidence is ${diagnostics.state}`])
  ];
  if (evidenceReasons.length > 0) {
    return { state: 'incomplete', reasons: evidenceReasons };
  }
  return { state: assessment.state, reasons: assessment.reasons };
}
