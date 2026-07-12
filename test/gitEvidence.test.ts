import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultGitRunner,
  type GitNullResult,
  type GitRunner
} from '../src/gitProcess';
import {
  collectGitEvidence,
  parseNumstat,
  parsePorcelainV2
} from '../src/verification/gitEvidence';
import type { GitBaseline } from '../src/types';

test('parses porcelain-v2 upstream, rename, untracked, and conflict evidence', () => {
  const parsed = parsePorcelainV2(
    nullResult([
      '# branch.oid abc',
      '# branch.head feature',
      '# branch.upstream origin/feature',
      '# branch.ab +2 -3',
      '1 M. N... 100644 100644 100644 aaa bbb src/changed file.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new name.ts',
      'src/old name.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicted file.ts',
      '? src/untracked file.ts'
    ]),
    'feature'
  );
  assert.deepEqual(parsed.upstream, {
    state: 'available',
    name: 'origin/feature',
    ahead: 2,
    behind: 3,
    source: 'local-tracking-ref'
  });
  assert.deepEqual(parsed.workingTree, {
    clean: false,
    trackedChanges: 3,
    untrackedChanges: 1,
    conflictedChanges: 1
  });
  assert.deepEqual(parsed.conflicts.paths, ['src/conflicted file.ts']);
});

test('parses text, binary, and rename numstat without inflating totals', () => {
  const parsed = parseNumstat(
    nullResult([
      '10\t2\tsrc/main.ts',
      '-\t-\timage.png',
      '3\t1\t',
      'old name.ts',
      'new name.ts'
    ])
  );
  assert.deepEqual(
    {
      files: parsed.files,
      additions: parsed.additions,
      deletions: parsed.deletions,
      binaryFiles: parsed.binaryFiles
    },
    { files: 3, additions: 13, deletions: 3, binaryFiles: 1 }
  );
  assert.deepEqual(parsed.entries[2], {
    path: 'new name.ts',
    previousPath: 'old name.ts',
    additions: 3,
    deletions: 1,
    binary: false
  });
});

test('collects committed and working-tree Git summary evidence', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'tracked.txt'), 'baseline\n');
    writeFileSync(path.join(directory, 'binary.dat'), Buffer.from([0, 1, 2]));
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'baseline']);
    const baseline = captureBaseline(directory);

    writeFileSync(path.join(directory, 'tracked.txt'), 'committed change\n');
    git(directory, ['add', 'tracked.txt']);
    git(directory, ['commit', '-qm', 'agent commit']);
    writeFileSync(path.join(directory, 'tracked.txt'), 'working change\n');
    writeFileSync(path.join(directory, 'binary.dat'), Buffer.from([0, 9, 8, 7]));
    writeFileSync(path.join(directory, 'untracked file.txt'), 'new\n');

    const evidence = await collectGitEvidence(baseline, {
      now: () => 1234
    });
    assert.equal(evidence.state, 'complete');
    assert.equal(evidence.collectedAt, 1234);
    assert.equal(evidence.baseline.relation, 'ancestor');
    assert.equal(evidence.baseline.stale, false);
    assert.equal(evidence.commits.count, 1);
    assert.equal(evidence.commits.entries[0]?.subject, 'agent commit');
    assert.equal(evidence.workingTree.clean, false);
    assert.equal(evidence.workingTree.untrackedChanges, 1);
    assert.equal(evidence.diff.untrackedFiles, 1);
    assert.equal(evidence.diff.files, 2);
    assert.equal(evidence.diff.binaryFiles, 1);
    assert.equal(evidence.diff.incomplete, false);
    assert.equal(evidence.upstream.state, 'none');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('reports local tracking-ref ahead and behind counts without fetching', async () => {
  const root = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'lookout-upstream-'))
  );
  const remote = path.join(root, 'remote.git');
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  try {
    git(root, ['init', '--bare', '-q', remote]);
    git(root, ['clone', '-q', remote, first]);
    configureUser(first);
    writeFileSync(path.join(first, 'file.txt'), 'base\n');
    git(first, ['add', '.']);
    git(first, ['commit', '-qm', 'base']);
    git(first, ['push', '-q', '-u', 'origin', 'HEAD']);
    const baseline = captureBaseline(first);

    git(root, ['clone', '-q', remote, second]);
    configureUser(second);
    writeFileSync(path.join(second, 'remote.txt'), 'remote\n');
    git(second, ['add', '.']);
    git(second, ['commit', '-qm', 'remote']);
    git(second, ['push', '-q']);
    writeFileSync(path.join(first, 'local.txt'), 'local\n');
    git(first, ['add', '.']);
    git(first, ['commit', '-qm', 'local']);
    git(first, ['fetch', '-q']);

    const evidence = await collectGitEvidence(baseline);
    assert.deepEqual(evidence.upstream, {
      state: 'available',
      name: `origin/${baseline.branch}`,
      ahead: 1,
      behind: 1,
      source: 'local-tracking-ref'
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports real unmerged paths and a stale diverged baseline', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'conflict.txt'), 'base\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'base']);
    const baseBranch = currentBranch(directory);
    git(directory, ['checkout', '-qb', 'agent-side']);
    writeFileSync(path.join(directory, 'conflict.txt'), 'agent\n');
    git(directory, ['commit', '-qam', 'agent']);
    const baseline = captureBaseline(directory);
    git(directory, ['checkout', '-q', baseBranch]);
    writeFileSync(path.join(directory, 'conflict.txt'), 'other\n');
    git(directory, ['commit', '-qam', 'other']);
    try {
      git(directory, ['merge', '--no-edit', 'agent-side']);
    } catch {
      // The unresolved merge is the evidence under test.
    }

    const evidence = await collectGitEvidence(baseline);
    assert.equal(evidence.baseline.relation, 'diverged');
    assert.equal(evidence.baseline.stale, true);
    assert.equal(evidence.conflicts.count, 1);
    assert.deepEqual(evidence.conflicts.paths, ['conflict.txt']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marks a same-named branch stale after its baseline is rewritten', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'file.txt'), 'base\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'base']);
    const base = gitOutput(directory, ['rev-parse', 'HEAD']);
    writeFileSync(path.join(directory, 'file.txt'), 'old branch tip\n');
    git(directory, ['commit', '-qam', 'old tip']);
    const baseline = captureBaseline(directory);
    git(directory, ['reset', '--hard', '-q', base]);
    writeFileSync(path.join(directory, 'file.txt'), 'rewritten tip\n');
    git(directory, ['commit', '-qam', 'rewritten tip']);

    const evidence = await collectGitEvidence(baseline);
    assert.equal(evidence.branch, baseline.branch);
    assert.equal(evidence.baseline.relation, 'diverged');
    assert.equal(evidence.baseline.stale, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('marks missing baseline evidence incomplete instead of presenting zeros as facts', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'file.txt'), 'base\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'base']);
    const current = captureBaseline(directory);
    const missing = { ...current, commit: '0'.repeat(40) };
    const evidence = await collectGitEvidence(missing);
    assert.equal(evidence.state, 'incomplete');
    assert.equal(evidence.baseline.relation, 'missing');
    assert.ok(evidence.reasons.length > 0);
    assert.equal(evidence.diff.truncated, true);
    assert.equal(evidence.diff.incomplete, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('retries a moving HEAD and reports repeated movement as unstable', async () => {
  const directory = createRepository();
  try {
    writeFileSync(path.join(directory, 'file.txt'), 'base\n');
    git(directory, ['add', '.']);
    git(directory, ['commit', '-qm', 'base']);
    const baseline = captureBaseline(directory);
    let headReads = 0;
    const movingRunner: GitRunner = {
      text: async (cwd, args, options) => {
        const value = await defaultGitRunner.text(cwd, args, options);
        if (args.length === 2 && args[0] === 'rev-parse' && args[1] === 'HEAD') {
          headReads += 1;
          return `${value.trim()}-${headReads}\n`;
        }
        return value;
      },
      null: (cwd, args, options) => defaultGitRunner.null(cwd, args, options)
    };
    const evidence = await collectGitEvidence(baseline, {
      runner: movingRunner
    });
    assert.equal(evidence.state, 'unstable');
    assert.match(evidence.reasons.join('\n'), /changed.*twice/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function nullResult(fields: readonly string[], truncated = false): GitNullResult {
  return { fields, truncated, bytesRead: 0 };
}

function createRepository(): string {
  const directory = realpathSync.native(
    mkdtempSync(path.join(tmpdir(), 'lookout-evidence-'))
  );
  git(directory, ['init', '-q']);
  configureUser(directory);
  return directory;
}

function configureUser(directory: string): void {
  git(directory, ['config', 'user.name', 'Lookout Tests']);
  git(directory, ['config', 'user.email', 'lookout@example.invalid']);
}

function captureBaseline(directory: string): GitBaseline {
  return {
    repoRoot: directory,
    commit: gitOutput(directory, ['rev-parse', 'HEAD']),
    branch: currentBranch(directory),
    capturedAt: Date.now()
  };
}

function currentBranch(directory: string): string {
  return gitOutput(directory, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

function gitOutput(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8'
  }).trim();
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}
