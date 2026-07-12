import * as path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessVerification,
  createReviewContext,
  normalizeRepoRoot,
  reconcileReviewContext,
  sameVerificationSignature
} from '../src/verification/verificationModel';
import type {
  ReviewContextAttachment,
  VerificationCheckOutcome,
  VerificationFreshnessSignature,
  VerificationPolicy,
  VerificationRun
} from '../src/verification/verificationTypes';

const signature: VerificationFreshnessSignature = {
  gitHead: 'abc',
  gitWorktree: 'clean',
  diagnosticBaselineId: 'diagnostics-1',
  diagnosticGeneration: 4
};

const policy: VerificationPolicy = {
  id: 'release',
  revision: 2,
  label: 'Release checks',
  steps: [
    { id: 'test', type: 'task', label: 'Tests', task: { name: 'test' } },
    { id: 'lint', type: 'task', label: 'Lint', task: { name: 'lint' } },
    {
      id: 'manual',
      type: 'manual',
      label: 'Optional review',
      required: false
    }
  ]
};

test('creates a physical-worktree context from the earliest attachment', () => {
  const root = path.join(process.cwd(), 'fixture-repo');
  const later = attachment('later', root, 200, 'later-commit');
  const earlier = attachment('earlier', root, 100, 'earlier-commit');
  const context = createReviewContext([later, earlier], 500);
  assert.equal(context.repoRootKey, normalizeRepoRoot(root));
  assert.equal(context.baseline.sessionId, 'earlier');
  assert.equal(context.baseline.commit, 'earlier-commit');
  assert.deepEqual(context.attachedSessionIds, ['earlier', 'later']);
  assert.equal(context.status, 'active');
});

test('keeps an active context baseline stable, then starts fresh after closure', () => {
  const root = path.join(process.cwd(), 'fixture-repo');
  const initial = createReviewContext([attachment('one', root, 100, 'first')], 100);
  const updated = reconcileReviewContext(
    initial,
    [attachment('two', root, 50, 'older-but-late')],
    200
  );
  assert.equal(updated?.baseline.commit, 'first');
  assert.deepEqual(updated?.attachedSessionIds, ['two']);

  const closed = reconcileReviewContext(updated, [], 300);
  assert.equal(closed?.status, 'closed');
  assert.equal(closed?.closedAt, 300);
  const fresh = reconcileReviewContext(
    closed,
    [attachment('three', root, 400, 'fresh')],
    400
  );
  assert.equal(fresh?.baseline.commit, 'fresh');
  assert.notEqual(fresh?.id, initial.id);
});

test('rejects attachments spanning physical worktree roots', () => {
  assert.throws(
    () =>
      createReviewContext([
        attachment('one', path.join(process.cwd(), 'one'), 1, 'a'),
        attachment('two', path.join(process.cwd(), 'two'), 2, 'b')
      ]),
    /cannot span/i
  );
});

test('assesses a completed current run as ready from policy-required checks', () => {
  const run = verificationRun('passed', 'passed');
  // Persisted `required` is presentation metadata; policy is authoritative.
  run.checks.forEach((check) => {
    (check as { required: boolean }).required = false;
  });
  assert.deepEqual(assessVerification(policy, run, signature), {
    state: 'ready',
    stale: false,
    reasons: []
  });
});

test('assesses running, failed, missing, and incomplete checks distinctly', () => {
  assert.equal(
    assessVerification(policy, { ...verificationRun('passed', 'passed'), completedAt: undefined }, signature).state,
    'running'
  );
  assert.equal(
    assessVerification(policy, verificationRun('failed', 'passed'), signature).state,
    'failed'
  );
  assert.equal(
    assessVerification(
      policy,
      { ...verificationRun('passed', 'passed'), checks: [] },
      signature
    ).state,
    'incomplete'
  );
  assert.equal(assessVerification(policy, undefined, signature).state, 'incomplete');
});

test('makes a completed run incomplete when policy or evidence changes', () => {
  const run = verificationRun('passed', 'passed');
  const stale = assessVerification(
    policy,
    run,
    { ...signature, gitWorktree: 'dirty' }
  );
  assert.equal(stale.state, 'incomplete');
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.reasons, ['evidence-stale']);
  assert.equal(
    assessVerification({ ...policy, revision: 3 }, run, signature).reasons[0],
    'policy-changed'
  );
  assert.equal(
    assessVerification(policy, { ...run, signature: undefined }, signature)
      .reasons[0],
    'evidence-missing'
  );
});

test('compares every Git and diagnostic freshness component', () => {
  assert.equal(sameVerificationSignature(signature, { ...signature }), true);
  assert.equal(
    sameVerificationSignature(signature, {
      ...signature,
      diagnosticGeneration: 5
    }),
    false
  );
});

function attachment(
  sessionId: string,
  repoRoot: string,
  capturedAt: number,
  commit: string
): ReviewContextAttachment {
  return {
    sessionId,
    repoRoot,
    baseline: { commit, branch: 'main', capturedAt }
  };
}

function verificationRun(
  first: VerificationCheckOutcome,
  second: VerificationCheckOutcome
): VerificationRun {
  return {
    id: 'run-1',
    contextId: 'context-1',
    policyId: policy.id,
    policyRevision: policy.revision,
    startedAt: 10,
    completedAt: 20,
    signature,
    checks: [
      {
        id: 'check-test',
        stepId: 'test',
        stepType: 'task',
        label: 'Tests',
        required: true,
        outcome: first
      },
      {
        id: 'check-lint',
        stepId: 'lint',
        stepType: 'task',
        label: 'Lint',
        required: true,
        outcome: second
      }
    ]
  };
}
