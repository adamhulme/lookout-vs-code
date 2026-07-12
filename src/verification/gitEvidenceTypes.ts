export type GitEvidenceState = 'complete' | 'incomplete' | 'unstable';

export type BaselineRelation =
  | 'same'
  | 'ancestor'
  | 'diverged'
  | 'missing'
  | 'unknown';

export interface GitEvidenceBaseline {
  readonly commit: string;
  readonly branch: string;
  readonly relation: BaselineRelation;
  readonly stale: boolean;
}

export interface GitFileStatEvidence {
  readonly path: string;
  readonly previousPath?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary: boolean;
}

export interface GitDiffEvidence {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
  readonly untrackedFiles: number;
  readonly entries: readonly GitFileStatEvidence[];
  /** The bounded detail list omits one or more otherwise-counted files. */
  readonly truncated: boolean;
  /** Git output itself was cut off, so even aggregate counts are partial. */
  readonly incomplete: boolean;
}

export interface GitCommitEvidence {
  readonly hash: string;
  readonly authoredAt: string;
  readonly author: string;
  readonly subject: string;
}

export interface GitCommitSummary {
  readonly count: number;
  readonly entries: readonly GitCommitEvidence[];
  /** The bounded detail list omits one or more otherwise-counted commits. */
  readonly truncated: boolean;
  /** Git output itself was cut off, so retained commit details are partial. */
  readonly incomplete: boolean;
}

export type GitUpstreamEvidence =
  | {
      readonly state: 'available';
      readonly name: string;
      readonly ahead: number;
      readonly behind: number;
      readonly source: 'local-tracking-ref';
    }
  | { readonly state: 'none' | 'detached' | 'unavailable' };

export interface GitConflictEvidence {
  readonly paths: readonly string[];
  readonly count: number;
  readonly truncated: boolean;
}

export interface GitWorkingTreeEvidence {
  readonly clean: boolean;
  readonly trackedChanges: number;
  readonly untrackedChanges: number;
  readonly conflictedChanges: number;
}

export interface GitReviewEvidence {
  readonly state: GitEvidenceState;
  readonly reasons: readonly string[];
  readonly collectedAt: number;
  readonly repoRoot: string;
  readonly repositoryName: string;
  readonly repositoryId: string;
  readonly commit: string;
  readonly branch: string;
  readonly baseline: GitEvidenceBaseline;
  readonly workingTree: GitWorkingTreeEvidence;
  readonly diff: GitDiffEvidence;
  readonly commits: GitCommitSummary;
  readonly upstream: GitUpstreamEvidence;
  readonly conflicts: GitConflictEvidence;
}
