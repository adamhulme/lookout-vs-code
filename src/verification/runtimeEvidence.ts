import type { GitBaseline } from '../types';
import type { GitReviewEvidence } from './gitEvidenceTypes';
import type {
  DiagnosticBaselineMetadata,
  ReviewContext
} from './verificationTypes';

export interface RuntimeDiagnosticRange {
  readonly startLine: number;
  readonly startCharacter: number;
  readonly endLine: number;
  readonly endCharacter: number;
}

/** Raw diagnostic data is runtime-only and must never enter workspaceState. */
export interface RuntimeDiagnostic {
  readonly path: string;
  readonly range: RuntimeDiagnosticRange;
  readonly severity: 'error' | 'warning' | 'information' | 'hint';
  readonly message: string;
  readonly source?: string;
  readonly code?: string | number;
}

export interface DiagnosticEvidenceSource {
  snapshot(repoRoot: string): readonly RuntimeDiagnostic[];
  generation(repoRoot: string): number;
}

export interface ReviewSessionSnapshot {
  readonly id: string;
  readonly isOpen: boolean;
  readonly baseline?: GitBaseline;
  readonly repositoryId?: string;
}

export type GitEvidenceCollector = (
  baseline: GitBaseline,
  options?: { readonly signal?: AbortSignal }
) => Promise<GitReviewEvidence>;

export type WorktreeEvidenceFingerprinter = (
  context: ReviewContext,
  git: GitReviewEvidence,
  signal: AbortSignal
) => Promise<string>;

export interface VerificationManagerSnapshot {
  readonly contexts: readonly ReviewContext[];
  readonly runs: import('./verificationTypes').VerificationRun[];
  readonly diagnosticBaselines: readonly DiagnosticBaselineMetadata[];
}
