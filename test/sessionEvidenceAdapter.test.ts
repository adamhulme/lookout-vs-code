import assert from 'node:assert/strict';
import test from 'node:test';
import { toReviewSessionSnapshots } from '../src/verification/sessionEvidenceAdapter';

test('projects only session identity, open state, and Git baseline', () => {
  const sessions = [
    {
      id: 'open',
      baseline: {
        repoRoot: 'C:\\repo',
        commit: 'abc',
        branch: 'main',
        capturedAt: 10
      },
      command: 'must not persist'
    },
    { id: 'closed' }
  ];
  const snapshots = toReviewSessionSnapshots(
    sessions,
    (id) => id === 'open'
  );

  assert.deepEqual(snapshots, [
    {
      id: 'open',
      isOpen: true,
      baseline: {
        repoRoot: 'C:\\repo',
        commit: 'abc',
        branch: 'main',
        capturedAt: 10
      }
    },
    { id: 'closed', isOpen: false }
  ]);
  assert.equal(JSON.stringify(snapshots).includes('must not persist'), false);
});
