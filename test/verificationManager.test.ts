import assert from 'node:assert/strict';
import test from 'node:test';
import type { GitReviewEvidence } from '../src/verification/gitEvidenceTypes';
import type {
  DiagnosticEvidenceSource,
  GitEvidenceCollector,
  ReviewSessionSnapshot,
  RuntimeDiagnostic
} from '../src/verification/runtimeEvidence';
import {
  ReviewEvidenceAbortError,
  VerificationManager
} from '../src/verification/verificationManager';
import type {
  ReviewContext,
  VerificationPolicy,
  VerificationRun
} from '../src/verification/verificationTypes';

const policy: VerificationPolicy = {
  id: 'release',
  revision: 1,
  label: 'Release',
  steps: [
    { id: 'test', type: 'task', label: 'Tests', task: { name: 'test' } }
  ]
};

test('reconciles sessions by physical root and keeps the earliest baseline stable', () => {
  const diagnostics = diagnosticSource([]);
  const manager = new VerificationManager({
    diagnostics,
    collectGit: async (): Promise<GitReviewEvidence> => gitEvidence()
  });
  const [context] = manager.reconcileSessions([
    session('later', 20, 'later'),
    session('earlier', 10, 'earlier')
  ]);
  assert.equal(context.baseline.commit, 'earlier');
  assert.equal(context.attachedSessionIds.length, 2);
  manager.reconcileSessions([session('later', 20, 'later')]);
  assert.equal(manager.getContext(context.id)?.baseline.commit, 'earlier');
  manager.reconcileSessions([]);
  assert.equal(manager.getContext(context.id)?.status, 'closed');
  const contexts = manager.reconcileSessions([session('fresh', 30, 'fresh')]);
  const fresh = contexts.find((candidate) => candidate.status === 'active');
  assert.equal(fresh?.baseline.commit, 'fresh');
  assert.notEqual(fresh?.id, context.id);
});

test('deduplicates in-flight collection, caches packets, and force refreshes', async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const collect: GitEvidenceCollector = async () => {
    calls += 1;
    await gate;
    return gitEvidence();
  };
  const manager = new VerificationManager({
    diagnostics: diagnosticSource([]),
    collectGit: collect,
    cacheTtlMs: 10_000
  });
  const context = activeContext(manager);
  const first = manager.getReviewPacket(context.id, { policy });
  const second = manager.getReviewPacket(context.id, { policy });
  assert.equal(calls, 1);
  release?.();
  const [firstPacket, secondPacket] = await Promise.all([first, second]);
  assert.equal(firstPacket, secondPacket);
  await manager.getReviewPacket(context.id, { policy });
  assert.equal(calls, 1);
  await manager.getReviewPacket(context.id, { policy, force: true });
  assert.equal(calls, 2);
});

test('combines Git, diagnostic delta, run assessment, and stale signatures', async () => {
  const source = mutableDiagnosticSource([]);
  const manager = new VerificationManager({
    diagnostics: source,
    collectGit: async (): Promise<GitReviewEvidence> => gitEvidence(),
    cacheTtlMs: 10_000
  });
  const context = activeContext(manager);
  const initial = await manager.getReviewPacket(context.id, { policy });
  assert.equal(initial.diagnostics.addedCount, 0);
  assert.equal(initial.readiness.state, 'incomplete');
  const run: VerificationRun = {
    id: 'run',
    contextId: context.id,
    policyId: policy.id,
    policyRevision: policy.revision,
    startedAt: 1,
    completedAt: 2,
    signature: initial.signature,
    checks: [
      {
        id: 'check',
        stepId: 'test',
        stepType: 'task',
        label: 'Tests',
        required: true,
        outcome: 'passed'
      }
    ]
  };
  manager.recordRun(run);
  const ready = await manager.getReviewPacket(context.id, { policy });
  assert.equal(ready.readiness.state, 'ready');

  source.values = [diagnostic('src/new.ts', 'PRIVATE DIAGNOSTIC')];
  source.currentGeneration = 1;
  manager.invalidateRoot(context.repoRoot);
  const stale = await manager.getReviewPacket(context.id, { policy });
  assert.equal(stale.diagnostics.addedCount, 1);
  assert.equal(stale.readiness.state, 'incomplete');
  assert.equal(stale.assessment?.stale, true);
  // The persistence snapshot contains hashes, never runtime diagnostic data.
  const serialized = JSON.stringify(manager.snapshot());
  assert.equal(serialized.includes('PRIVATE DIAGNOSTIC'), false);
  assert.equal(serialized.includes('src/new.ts'), false);
});

test('incomplete Git or diagnostic evidence cannot produce ready', async () => {
  const manager = new VerificationManager({
    collectGit: async (): Promise<GitReviewEvidence> => ({
      ...gitEvidence(),
      state: 'incomplete',
      reasons: ['status unavailable']
    })
  });
  const context = activeContext(manager);
  const first = await manager.getReviewPacket(context.id, { policy });
  manager.recordRun({
    id: 'run',
    contextId: context.id,
    policyId: policy.id,
    policyRevision: policy.revision,
    startedAt: 1,
    completedAt: 2,
    signature: first.signature,
    checks: [
      {
        id: 'check',
        stepId: 'test',
        stepType: 'task',
        label: 'Tests',
        required: true,
        outcome: 'passed'
      }
    ]
  });
  const packet = await manager.getReviewPacket(context.id, { policy });
  assert.equal(packet.assessment?.state, 'ready');
  assert.equal(packet.readiness.state, 'incomplete');
  assert.match(packet.readiness.reasons.join('\n'), /Git evidence/i);
});

test('invalidation aborts manager-owned in-flight evidence', async () => {
  const collect: GitEvidenceCollector = async (_baseline, options) =>
    new Promise<GitReviewEvidence>((resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(new ReviewEvidenceAbortError()),
        { once: true }
      );
      // Retain resolve to make the Promise executor intentionally complete.
      void resolve;
    });
  const manager = new VerificationManager({ collectGit: collect });
  const context = activeContext(manager);
  const pending = manager.getReviewPacket(context.id);
  manager.invalidateContext(context.id);
  await assert.rejects(pending, ReviewEvidenceAbortError);
});

test('recording a completed run replaces its in-progress metadata', () => {
  const manager = new VerificationManager();
  const context = activeContext(manager);
  const running: VerificationRun = {
    id: 'same-run',
    contextId: context.id,
    policyId: policy.id,
    policyRevision: policy.revision,
    startedAt: 1,
    checks: [
      {
        id: 'check',
        stepId: 'test',
        stepType: 'task',
        label: 'Tests',
        required: true,
        outcome: 'running'
      }
    ]
  };
  manager.recordRun(running);
  manager.recordRun({
    ...running,
    completedAt: 2,
    checks: [{ ...running.checks[0], outcome: 'passed' }]
  });
  assert.equal(manager.snapshot().runs.length, 1);
  assert.equal(manager.latestRun(context.id)?.checks[0].outcome, 'passed');
});

function activeContext(manager: VerificationManager): ReviewContext {
  return manager.reconcileSessions([session('session', 10, 'baseline')]).find(
    (context) => context.status === 'active'
  )!;
}

function session(
  id: string,
  capturedAt: number,
  commit: string
): ReviewSessionSnapshot {
  return {
    id,
    isOpen: true,
    baseline: {
      repoRoot: 'C:\\physical-worktree',
      commit,
      branch: 'main',
      capturedAt
    }
  };
}

function gitEvidence(): GitReviewEvidence {
  return {
    state: 'complete',
    reasons: [],
    collectedAt: 10,
    repoRoot: 'C:\\physical-worktree',
    repositoryName: 'repository',
    repositoryId: 'C:\\repository\\.git',
    commit: 'head',
    branch: 'main',
    baseline: {
      commit: 'baseline',
      branch: 'main',
      relation: 'ancestor',
      stale: false
    },
    workingTree: {
      clean: true,
      trackedChanges: 0,
      untrackedChanges: 0,
      conflictedChanges: 0
    },
    diff: {
      files: 0,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      untrackedFiles: 0,
      entries: [],
      truncated: false,
      incomplete: false
    },
    commits: { count: 1, entries: [], truncated: true, incomplete: false },
    upstream: { state: 'none' },
    conflicts: { paths: [], count: 0, truncated: false }
  };
}

function diagnosticSource(
  values: readonly RuntimeDiagnostic[]
): DiagnosticEvidenceSource {
  return { snapshot: () => values, generation: () => 0 };
}

function mutableDiagnosticSource(values: RuntimeDiagnostic[]): {
  values: RuntimeDiagnostic[];
  currentGeneration: number;
  snapshot(): readonly RuntimeDiagnostic[];
  generation(): number;
} {
  return {
    values,
    currentGeneration: 0,
    snapshot(): readonly RuntimeDiagnostic[] {
      return this.values;
    },
    generation(): number {
      return this.currentGeneration;
    }
  };
}

function diagnostic(filePath: string, message: string): RuntimeDiagnostic {
  return {
    path: filePath,
    range: {
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 1
    },
    severity: 'error',
    message
  };
}
