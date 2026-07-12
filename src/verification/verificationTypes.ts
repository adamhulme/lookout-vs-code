export type VerificationState =
  | 'ready'
  | 'failed'
  | 'incomplete'
  | 'running';

export interface ReviewContextBaseline {
  readonly sessionId: string;
  readonly commit: string;
  readonly branch: string;
  readonly capturedAt: number;
}

/**
 * The review attribution boundary. `repoRootKey` is a normalized physical
 * worktree path; linked worktrees intentionally receive different contexts.
 */
export interface ReviewContext {
  readonly id: string;
  readonly repoRoot: string;
  readonly repoRootKey: string;
  readonly repositoryId?: string;
  readonly baseline: ReviewContextBaseline;
  readonly createdAt: number;
  updatedAt: number;
  status: 'active' | 'closed';
  attachedSessionIds: string[];
  diagnosticBaselineId?: string;
  closedAt?: number;
}

export interface ReviewContextAttachment {
  readonly sessionId: string;
  readonly repoRoot: string;
  readonly repositoryId?: string;
  readonly baseline: {
    readonly commit: string;
    readonly branch: string;
    readonly capturedAt: number;
  };
}

interface VerificationStepBase {
  readonly id: string;
  readonly label: string;
  readonly required?: boolean;
}

export interface VerificationTaskStep extends VerificationStepBase {
  readonly type: 'task';
  readonly task: {
    readonly name: string;
    readonly source?: string;
    readonly folder?: string;
    readonly definitionType?: string;
  };
}

export interface VerificationCommandStep extends VerificationStepBase {
  readonly type: 'command';
  /** Runtime-only configuration. It is never projected into persisted runs. */
  readonly command: string;
}

export interface VerificationGitStep extends VerificationStepBase {
  readonly type: 'git';
  readonly checks: {
    readonly noConflicts?: boolean;
    readonly branchUnchanged?: boolean;
    readonly requireChanges?: boolean;
    readonly workingTree?: 'clean' | 'allow-dirty';
    readonly locallyUpToDate?: boolean;
  };
}

export interface VerificationDiagnosticsStep extends VerificationStepBase {
  readonly type: 'diagnostics';
  readonly threshold: 'errors' | 'errors-and-warnings' | 'ignore';
}

export interface VerificationManualStep extends VerificationStepBase {
  readonly type: 'manual';
  readonly instructions?: string;
}

export type VerificationStep =
  | VerificationTaskStep
  | VerificationCommandStep
  | VerificationGitStep
  | VerificationDiagnosticsStep
  | VerificationManualStep;

export interface VerificationPolicy {
  readonly id: string;
  /** Bump when a policy keeps its ID but changes its required checks. */
  readonly revision: number;
  readonly label: string;
  readonly steps: readonly VerificationStep[];
  readonly continueOnFailure?: boolean;
}

export type VerificationCheckOutcome =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'unavailable'
  | 'unknown'
  | 'skipped';

export type VerificationCheckReason =
  | 'non-zero-exit'
  | 'cancelled'
  | 'unavailable'
  | 'unknown-exit'
  | 'policy-gate-failed'
  | 'manual-pending'
  | 'dependency-failed';

/** Deliberately metadata-only: there is no stdout/stderr/output field. */
export interface VerificationCheckResult {
  readonly id: string;
  readonly stepId: string;
  readonly stepType: VerificationStep['type'];
  readonly label: string;
  readonly required: boolean;
  readonly outcome: VerificationCheckOutcome;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly durationMs?: number;
  readonly exitCode?: number;
  readonly reason?: VerificationCheckReason;
}

export interface VerificationFreshnessSignature {
  readonly gitHead: string;
  /** Hash of index/worktree state, including untracked path metadata. */
  readonly gitWorktree: string;
  readonly diagnosticBaselineId?: string;
  readonly diagnosticGeneration?: number;
}

/** Deliberately metadata-only: runtime command/task output lives elsewhere. */
export interface VerificationRun {
  readonly id: string;
  readonly contextId: string;
  readonly policyId: string;
  readonly policyRevision: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly signature?: VerificationFreshnessSignature;
  readonly checks: readonly VerificationCheckResult[];
}

export type VerificationAssessmentReason =
  | 'no-run'
  | 'policy-changed'
  | 'run-active'
  | 'evidence-missing'
  | 'evidence-stale'
  | 'no-required-checks'
  | 'required-check-failed'
  | 'required-check-incomplete';

export interface VerificationAssessment {
  readonly state: VerificationState;
  readonly stale: boolean;
  readonly reasons: readonly VerificationAssessmentReason[];
}

export type DiagnosticBaselineState =
  | 'complete'
  | 'partial'
  | 'unavailable';

export type DiagnosticBaselineIssue =
  | 'restored-without-baseline'
  | 'collection-failed'
  | 'hashes-truncated'
  | 'invalid-hashes-removed';

/**
 * Persistence-safe diagnostic baseline. Fingerprints are one-way SHA-256
 * hashes; diagnostic messages, paths, source, and ranges are never stored.
 */
export interface DiagnosticBaselineMetadata {
  readonly id: string;
  readonly contextId: string;
  readonly createdAt: number;
  readonly hashAlgorithm: 'sha256';
  readonly state: DiagnosticBaselineState;
  readonly diagnosticCount: number;
  readonly fingerprints: readonly string[];
  readonly issues: readonly DiagnosticBaselineIssue[];
}
