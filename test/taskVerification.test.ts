import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completeTaskVerificationRun,
  restoredTaskVerificationPolicy,
  startTaskVerificationRun,
  taskVerificationPolicy,
  type VerificationTaskIdentity
} from '../src/verification/taskVerification';

const identity: VerificationTaskIdentity = {
  kind: 'test',
  name: 'private customer test command',
  source: 'private workspace',
  definitionType: 'shell',
  scope: 'C:\\secret\\repository'
};

test('task policies persist a digest and fixed label, not task identity', () => {
  const policy = taskVerificationPolicy(identity);
  const run = startTaskVerificationRun('context', identity, 100);
  const serialized = JSON.stringify({ policyId: policy.id, run });
  assert.match(policy.id, /^lookout\.vscode-task\.test\.[a-f\d]{64}$/);
  assert.equal(serialized.includes(identity.name), false);
  assert.equal(serialized.includes(identity.source), false);
  assert.equal(serialized.includes(identity.scope), false);
  assert.equal(run.checks[0].label, 'VS Code Test task');
  assert.deepEqual(restoredTaskVerificationPolicy(run), {
    id: policy.id,
    revision: 1,
    label: 'VS Code Task verification',
    steps: [
      {
        id: 'vscode-task',
        type: 'task',
        label: 'VS Code Test task',
        required: true,
        task: { name: 'VS Code Test task' }
      }
    ]
  });
});

test('only a zero process exit records a passed task check', () => {
  const run = startTaskVerificationRun('context', identity, 100);
  const signature = { gitHead: 'head', gitWorktree: 'tree' };
  const passed = completeTaskVerificationRun(
    run,
    { exitCode: 0 },
    signature,
    150
  );
  assert.equal(passed.checks[0].outcome, 'passed');
  assert.equal(passed.checks[0].exitCode, 0);
  assert.deepEqual(passed.signature, signature);

  const failed = completeTaskVerificationRun(
    run,
    { exitCode: 2 },
    signature,
    160
  );
  assert.equal(failed.checks[0].outcome, 'failed');
  assert.equal(failed.checks[0].reason, 'non-zero-exit');
  assert.equal(failed.checks[0].exitCode, 2);
});

test('missing process exit and launch failure never claim success', () => {
  const run = startTaskVerificationRun(
    'context',
    { ...identity, kind: 'workspace-fallback' },
    100
  );
  const unknown = completeTaskVerificationRun(run, {}, undefined, 150);
  assert.equal(unknown.checks[0].outcome, 'unknown');
  assert.equal(unknown.checks[0].reason, 'unknown-exit');
  assert.equal(unknown.signature, undefined);
  assert.equal(unknown.checks[0].label, 'Workspace task fallback');

  const unavailable = completeTaskVerificationRun(
    run,
    { launchFailed: true },
    undefined,
    150
  );
  assert.equal(unavailable.checks[0].outcome, 'unavailable');
  assert.equal(unavailable.checks[0].reason, 'unavailable');
});
