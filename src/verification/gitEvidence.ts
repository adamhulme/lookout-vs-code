import * as path from 'node:path';
import {
  GitCommandError,
  defaultGitRunner,
  type GitNullResult,
  type GitRunner
} from '../gitProcess';
import type { GitBaseline } from '../types';
import type {
  BaselineRelation,
  GitCommitEvidence,
  GitConflictEvidence,
  GitDiffEvidence,
  GitEvidenceState,
  GitFileStatEvidence,
  GitReviewEvidence,
  GitUpstreamEvidence,
  GitWorkingTreeEvidence
} from './gitEvidenceTypes';

const MAX_STATUS_FIELDS = 100_000;
const MAX_NUMSTAT_FIELDS = 100_000;
const MAX_RETAINED_FILES = 100;
const MAX_RETAINED_CONFLICTS = 100;
const MAX_RETAINED_COMMITS = 20;

export interface CollectGitEvidenceOptions {
  readonly signal?: AbortSignal;
  readonly runner?: GitRunner;
  readonly now?: () => number;
}

interface WorktreeIdentity {
  readonly repoRoot: string;
  readonly repositoryName: string;
  readonly repositoryId: string;
  readonly commit: string;
  readonly branch: string;
}

interface StatusEvidence {
  readonly workingTree: GitWorkingTreeEvidence;
  readonly upstream: GitUpstreamEvidence;
  readonly conflicts: GitConflictEvidence;
  readonly untrackedPaths: readonly string[];
  readonly truncated: boolean;
}

export async function collectGitEvidence(
  baseline: GitBaseline,
  options: CollectGitEvidenceOptions = {}
): Promise<GitReviewEvidence> {
  const runner = options.runner ?? defaultGitRunner;
  const first = await collectAttempt(baseline, runner, options);
  if (first.startCommit === first.endCommit) {
    return first.evidence;
  }
  const second = await collectAttempt(baseline, runner, options);
  if (second.startCommit === second.endCommit) {
    return second.evidence;
  }
  return {
    ...second.evidence,
    state: 'unstable',
    reasons: uniqueReasons([
      ...second.evidence.reasons,
      'HEAD changed while Git evidence was being collected twice'
    ])
  };
}

async function collectAttempt(
  baseline: GitBaseline,
  runner: GitRunner,
  options: CollectGitEvidenceOptions
): Promise<{
  readonly startCommit: string;
  readonly endCommit: string;
  readonly evidence: GitReviewEvidence;
}> {
  const identity = await readIdentity(baseline.repoRoot, runner, options.signal);
  const reasons: string[] = [];
  const [status, relation, diff, commits] = await Promise.all([
    readStatus(identity, runner, options.signal).catch(() => {
      reasons.push('Working-tree status could not be read');
      return unavailableStatus(identity.branch);
    }),
    readBaselineRelation(
      identity.repoRoot,
      baseline.commit,
      identity.commit,
      runner,
      options.signal
    ).catch(() => {
      reasons.push('Baseline relationship could not be determined');
      return 'unknown' as const;
    }),
    readDiff(identity.repoRoot, baseline.commit, runner, options.signal).catch(
      () => {
        reasons.push('Diff statistics could not be read');
        return emptyDiff(true);
      }
    ),
    readCommits(
      identity.repoRoot,
      baseline.commit,
      runner,
      options.signal
    ).catch(() => {
      reasons.push('Commit evidence could not be read');
      return { count: 0, entries: [], truncated: true, incomplete: true };
    })
  ]);
  if (status.truncated) {
    reasons.push('Working-tree status exceeded its safety limit');
  }
  if (diff.incomplete) {
    reasons.push('Diff statistics exceeded their safety limit');
  }
  if (commits.incomplete) {
    reasons.push('Commit details exceeded their safety limit');
  }
  if (relation === 'missing') {
    reasons.push('The captured baseline commit is no longer available');
  }
  const endCommit = (
    await runner.text(identity.repoRoot, ['rev-parse', 'HEAD'], {
      signal: options.signal,
      maxOutputBytes: 1024
    })
  ).trim();
  const state: GitEvidenceState = reasons.length === 0 ? 'complete' : 'incomplete';
  return {
    startCommit: identity.commit,
    endCommit,
    evidence: {
      state,
      reasons: uniqueReasons(reasons),
      collectedAt: (options.now ?? Date.now)(),
      ...identity,
      baseline: {
        commit: baseline.commit,
        branch: baseline.branch,
        relation,
        stale:
          relation === 'diverged' ||
          relation === 'missing' ||
          identity.branch !== baseline.branch ||
          (identity.branch === 'HEAD' && identity.commit !== baseline.commit)
      },
      workingTree: status.workingTree,
      diff: {
        ...diff,
        untrackedFiles: status.untrackedPaths.length
      },
      commits,
      upstream: status.upstream,
      conflicts: status.conflicts
    }
  };
}

async function readIdentity(
  cwd: string,
  runner: GitRunner,
  signal?: AbortSignal
): Promise<WorktreeIdentity> {
  const repoRoot = path.normalize(
    (
      await runner.text(cwd, ['rev-parse', '--show-toplevel'], {
        signal,
        maxOutputBytes: 64 * 1024
      })
    ).trim()
  );
  const [commit, branch, commonValue] = await Promise.all([
    runner.text(repoRoot, ['rev-parse', 'HEAD'], {
      signal,
      maxOutputBytes: 1024
    }),
    runner.text(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], {
      signal,
      maxOutputBytes: 64 * 1024
    }),
    runner.text(repoRoot, ['rev-parse', '--git-common-dir'], {
      signal,
      maxOutputBytes: 64 * 1024
    })
  ]);
  const commonDirectory = path.normalize(commonValue.trim());
  const repositoryId = path.normalize(
    path.isAbsolute(commonDirectory)
      ? commonDirectory
      : path.resolve(repoRoot, commonDirectory)
  );
  return {
    repoRoot,
    repositoryName: path.basename(path.dirname(repositoryId)),
    repositoryId,
    commit: commit.trim(),
    branch: branch.trim()
  };
}

async function readStatus(
  identity: WorktreeIdentity,
  runner: GitRunner,
  signal?: AbortSignal
): Promise<StatusEvidence> {
  const output = await runner.null(
    identity.repoRoot,
    ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'],
    { signal, maxFields: MAX_STATUS_FIELDS }
  );
  return parsePorcelainV2(output, identity.branch);
}

export function parsePorcelainV2(
  output: GitNullResult,
  branch: string
): StatusEvidence {
  let trackedChanges = 0;
  let untrackedChanges = 0;
  const untrackedPaths: string[] = [];
  const conflictPaths: string[] = [];
  let conflictCount = 0;
  let upstreamName: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  for (let index = 0; index < output.fields.length; index += 1) {
    const record = output.fields[index];
    if (record.startsWith('# branch.upstream ')) {
      upstreamName = record.slice('# branch.upstream '.length);
      continue;
    }
    if (record.startsWith('# branch.ab ')) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (record.startsWith('? ')) {
      untrackedChanges += 1;
      untrackedPaths.push(record.slice(2));
      continue;
    }
    if (record.startsWith('1 ')) {
      trackedChanges += 1;
      continue;
    }
    if (record.startsWith('2 ')) {
      trackedChanges += 1;
      // Rename/copy records have a second NUL-delimited original path.
      index += 1;
      continue;
    }
    if (record.startsWith('u ')) {
      trackedChanges += 1;
      conflictCount += 1;
      const filePath = fieldAfterSpaces(record, 10);
      if (conflictPaths.length < MAX_RETAINED_CONFLICTS) {
        conflictPaths.push(filePath);
      }
    }
  }
  const upstream: GitUpstreamEvidence =
    branch === 'HEAD'
      ? { state: 'detached' }
      : upstreamName && ahead !== undefined && behind !== undefined
        ? {
            state: 'available',
            name: upstreamName,
            ahead,
            behind,
            source: 'local-tracking-ref'
          }
        : { state: 'none' };
  return {
    workingTree: {
      clean: trackedChanges === 0 && untrackedChanges === 0,
      trackedChanges,
      untrackedChanges,
      conflictedChanges: conflictCount
    },
    upstream,
    conflicts: {
      paths: conflictPaths,
      count: conflictCount,
      truncated: conflictCount > conflictPaths.length || output.truncated
    },
    untrackedPaths,
    truncated: output.truncated
  };
}

async function readBaselineRelation(
  repoRoot: string,
  baseline: string,
  head: string,
  runner: GitRunner,
  signal?: AbortSignal
): Promise<BaselineRelation> {
  if (baseline === head) {
    return 'same';
  }
  try {
    await runner.text(repoRoot, ['cat-file', '-e', `${baseline}^{commit}`], {
      signal,
      maxOutputBytes: 1024
    });
  } catch (error) {
    if (error instanceof GitCommandError) {
      return 'missing';
    }
    throw error;
  }
  try {
    await runner.text(
      repoRoot,
      ['merge-base', '--is-ancestor', baseline, head],
      { signal, maxOutputBytes: 1024, allowedExitCodes: [0] }
    );
    return 'ancestor';
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return 'diverged';
    }
    throw error;
  }
}

async function readDiff(
  repoRoot: string,
  baseline: string,
  runner: GitRunner,
  signal?: AbortSignal
): Promise<GitDiffEvidence> {
  const output = await runner.null(
    repoRoot,
    [
      'diff',
      '--numstat',
      '-z',
      '--find-renames',
      '--no-ext-diff',
      '--no-textconv',
      baseline,
      '--'
    ],
    { signal, maxFields: MAX_NUMSTAT_FIELDS }
  );
  return parseNumstat(output);
}

export function parseNumstat(output: GitNullResult): GitDiffEvidence {
  let files = 0;
  let additions = 0;
  let deletions = 0;
  let binaryFiles = 0;
  const entries: GitFileStatEvidence[] = [];
  for (let index = 0; index < output.fields.length; index += 1) {
    const field = output.fields[index];
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(field);
    if (!match) {
      continue;
    }
    let filePath = match[3];
    let previousPath: string | undefined;
    if (!filePath) {
      previousPath = output.fields[++index];
      filePath = output.fields[++index] ?? '';
    }
    const binary = match[1] === '-' || match[2] === '-';
    const added = binary ? undefined : Number(match[1]);
    const deleted = binary ? undefined : Number(match[2]);
    files += 1;
    if (binary) {
      binaryFiles += 1;
    } else {
      additions += added ?? 0;
      deletions += deleted ?? 0;
    }
    if (entries.length < MAX_RETAINED_FILES) {
      entries.push({
        path: filePath,
        ...(previousPath ? { previousPath } : {}),
        additions: added,
        deletions: deleted,
        binary
      });
    }
  }
  return {
    files,
    additions,
    deletions,
    binaryFiles,
    untrackedFiles: 0,
    entries,
    truncated: output.truncated || files > entries.length,
    incomplete: output.truncated
  };
}

async function readCommits(
  repoRoot: string,
  baseline: string,
  runner: GitRunner,
  signal?: AbortSignal
): Promise<{
  readonly count: number;
  readonly entries: readonly GitCommitEvidence[];
  readonly truncated: boolean;
  readonly incomplete: boolean;
}> {
  const [countText, log] = await Promise.all([
    runner.text(repoRoot, ['rev-list', '--count', `${baseline}..HEAD`], {
      signal,
      maxOutputBytes: 1024
    }),
    runner.null(
      repoRoot,
      [
        'log',
        '-z',
        `--max-count=${MAX_RETAINED_COMMITS}`,
        '--format=%H%x00%aI%x00%an%x00%s',
        `${baseline}..HEAD`
      ],
      { signal, maxFields: MAX_RETAINED_COMMITS * 4 }
    )
  ]);
  const count = Number(countText.trim());
  const entries: GitCommitEvidence[] = [];
  for (let index = 0; index + 3 < log.fields.length; index += 4) {
    entries.push({
      hash: log.fields[index],
      authoredAt: log.fields[index + 1],
      author: log.fields[index + 2],
      subject: log.fields[index + 3]
    });
  }
  return {
    count: Number.isFinite(count) ? count : 0,
    entries,
    truncated: log.truncated || count > entries.length,
    incomplete: log.truncated
  };
}

function unavailableStatus(branch: string): StatusEvidence {
  return {
    workingTree: {
      clean: false,
      trackedChanges: 0,
      untrackedChanges: 0,
      conflictedChanges: 0
    },
    upstream: branch === 'HEAD' ? { state: 'detached' } : { state: 'unavailable' },
    conflicts: { paths: [], count: 0, truncated: true },
    untrackedPaths: [],
    truncated: true
  };
}

function emptyDiff(truncated: boolean): GitDiffEvidence {
  return {
    files: 0,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    untrackedFiles: 0,
    entries: [],
    truncated,
    incomplete: truncated
  };
}

function fieldAfterSpaces(value: string, spaces: number): string {
  let index = -1;
  for (let count = 0; count < spaces; count += 1) {
    index = value.indexOf(' ', index + 1);
    if (index < 0) {
      return '';
    }
  }
  return value.slice(index + 1);
}

function uniqueReasons(reasons: readonly string[]): string[] {
  return [...new Set(reasons)];
}
