import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VERIFICATION_STORE_VERSION,
  boundVerificationStore,
  emptyVerificationStore,
  loadVerificationStore,
  persistableVerificationStore,
  type VerificationStoreLimits,
  type VerificationStoreState
} from '../src/verification/verificationStoreModel';
import type {
  DiagnosticBaselineMetadata,
  ReviewContext,
  VerificationRun
} from '../src/verification/verificationTypes';

const now = 1_000_000;
const limits: VerificationStoreLimits = {
  maxContexts: 2,
  maxRunsPerContext: 2,
  maxDiagnosticBaselines: 2,
  maxDiagnosticHashes: 2,
  maxAttachedSessions: 2,
  retentionMs: 1000
};

test('creates an empty current-version store', () => {
  assert.deepEqual(emptyVerificationStore(), {
    version: VERIFICATION_STORE_VERSION,
    contexts: [],
    runs: [],
    diagnosticBaselines: []
  });
});

test('bounds contexts, per-context runs, attachments, hashes, and retention', () => {
  const active = context('active', now - 10, 'active');
  active.attachedSessionIds = ['one', 'two', 'three'];
  active.diagnosticBaselineId = 'baseline-active';
  const recentClosed = context('recent', now - 20, 'closed');
  recentClosed.closedAt = now - 20;
  const oldClosed = context('old', now - 2000, 'closed');
  oldClosed.closedAt = now - 2000;
  const state: VerificationStoreState = {
    version: VERIFICATION_STORE_VERSION,
    contexts: [oldClosed, recentClosed, active],
    runs: [
      run('active-1', active.id, now - 1),
      run('active-2', active.id, now - 2),
      run('active-3', active.id, now - 3),
      run('old-run', oldClosed.id, now - 2000)
    ],
    diagnosticBaselines: [
      diagnosticBaseline('baseline-active', active.id, now - 5000, [
        hash('a'),
        hash('b'),
        hash('c')
      ]),
      diagnosticBaseline('baseline-old', oldClosed.id, now - 2000, [hash('d')])
    ]
  };
  const bounded = boundVerificationStore(state, now, limits);
  assert.deepEqual(
    bounded.contexts.map((item) => item.id),
    ['active', 'recent']
  );
  assert.deepEqual(bounded.contexts[0].attachedSessionIds, ['one', 'two']);
  assert.deepEqual(
    bounded.runs.map((item) => item.id),
    ['active-1', 'active-2']
  );
  assert.equal(bounded.diagnosticBaselines.length, 1);
  assert.equal(bounded.diagnosticBaselines[0].fingerprints.length, 2);
  assert.equal(bounded.diagnosticBaselines[0].state, 'partial');
  assert.ok(
    bounded.diagnosticBaselines[0].issues.includes('hashes-truncated')
  );
});

test('migrates legacy v0 runsByContext into the current bounded schema', () => {
  const current = context('context', now, 'active');
  const migrated = loadVerificationStore(
    {
      version: 0,
      contexts: [current],
      runsByContext: { [current.id]: [run('legacy-run', current.id, now)] },
      diagnosticBaselines: []
    },
    now,
    limits
  );
  assert.equal(migrated.version, VERIFICATION_STORE_VERSION);
  assert.deepEqual(migrated.runs.map((item) => item.id), ['legacy-run']);
});

test('allow-list persistence strips commands, output, transcripts, and unknown data', () => {
  const current = context('context', now, 'active');
  const malicious = {
    version: VERIFICATION_STORE_VERSION,
    contexts: [{ ...current, prompt: 'PRIVATE PROMPT' }],
    runs: [
      {
        ...run('run', current.id, now),
        command: 'PRIVATE COMMAND',
        stdout: 'PRIVATE STDOUT',
        stderr: 'PRIVATE STDERR',
        transcript: 'PRIVATE TRANSCRIPT',
        checks: [
          {
            ...run('nested', current.id, now).checks[0],
            output: 'PRIVATE CHECK OUTPUT'
          }
        ]
      }
    ],
    diagnosticBaselines: []
  };
  const persisted = persistableVerificationStore(
    malicious as unknown as VerificationStoreState,
    now,
    limits
  );
  const serialized = JSON.stringify(persisted);
  for (const secret of [
    'PRIVATE PROMPT',
    'PRIVATE COMMAND',
    'PRIVATE STDOUT',
    'PRIVATE STDERR',
    'PRIVATE TRANSCRIPT',
    'PRIVATE CHECK OUTPUT'
  ]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('diagnostic persistence accepts hashes only and degrades invalid baselines', () => {
  const current = context('context', now, 'active');
  current.diagnosticBaselineId = 'diagnostics';
  const loaded = loadVerificationStore(
    {
      version: VERIFICATION_STORE_VERSION,
      contexts: [current],
      runs: [],
      diagnosticBaselines: [
        {
          id: 'diagnostics',
          contextId: current.id,
          createdAt: now,
          hashAlgorithm: 'sha256',
          state: 'complete',
          diagnosticCount: 2,
          fingerprints: [hash('a'), 'src/private.ts: secret diagnostic'],
          issues: [],
          message: 'secret diagnostic',
          uri: 'src/private.ts'
        }
      ]
    },
    now,
    limits
  );
  const baseline = loaded.diagnosticBaselines[0];
  assert.deepEqual(baseline.fingerprints, [hash('a')]);
  assert.equal(baseline.state, 'partial');
  assert.deepEqual(baseline.issues, ['invalid-hashes-removed']);
  assert.equal(JSON.stringify(loaded).includes('private.ts'), false);
  assert.equal(JSON.stringify(loaded).includes('secret diagnostic'), false);
});

test('rejects unknown future schemas instead of guessing', () => {
  assert.deepEqual(loadVerificationStore({ version: 999 }), emptyVerificationStore());
});

function context(
  id: string,
  updatedAt: number,
  status: ReviewContext['status']
): ReviewContext {
  return {
    id,
    repoRoot: `C:\\repo\\${id}`,
    repoRootKey: `c:\\repo\\${id}`,
    baseline: {
      sessionId: `session-${id}`,
      commit: `commit-${id}`,
      branch: 'main',
      capturedAt: updatedAt
    },
    createdAt: updatedAt,
    updatedAt,
    status,
    attachedSessionIds: [`session-${id}`]
  };
}

function run(id: string, contextId: string, startedAt: number): VerificationRun {
  return {
    id,
    contextId,
    policyId: 'release',
    policyRevision: 1,
    startedAt,
    completedAt: startedAt + 1,
    signature: { gitHead: 'abc', gitWorktree: 'clean' },
    checks: [
      {
        id: `check-${id}`,
        stepId: 'test',
        stepType: 'task',
        label: 'Tests',
        required: true,
        outcome: 'passed',
        exitCode: 0
      }
    ]
  };
}

function diagnosticBaseline(
  id: string,
  contextId: string,
  createdAt: number,
  fingerprints: readonly string[]
): DiagnosticBaselineMetadata {
  return {
    id,
    contextId,
    createdAt,
    hashAlgorithm: 'sha256',
    state: 'complete',
    diagnosticCount: fingerprints.length,
    fingerprints,
    issues: []
  };
}

function hash(character: string): string {
  return character.repeat(64);
}
