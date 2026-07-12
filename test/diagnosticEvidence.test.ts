import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureDiagnosticBaseline,
  computeDiagnosticDelta,
  fingerprintDiagnostic,
  unavailableDiagnosticBaseline
} from '../src/verification/diagnosticEvidence';
import type { RuntimeDiagnostic } from '../src/verification/runtimeEvidence';

test('fingerprints every diagnostic identity field deterministically', () => {
  const value = diagnostic('src/main.ts', 'message');
  assert.equal(fingerprintDiagnostic(value), fingerprintDiagnostic({ ...value }));
  assert.notEqual(
    fingerprintDiagnostic(value),
    fingerprintDiagnostic({ ...value, message: 'changed' })
  );
  assert.notEqual(
    fingerprintDiagnostic(value),
    fingerprintDiagnostic({
      ...value,
      range: { ...value.range, startLine: 2 }
    })
  );
  assert.match(fingerprintDiagnostic(value), /^[a-f\d]{64}$/);
});

test('captures hashes only and marks a bounded baseline partial', () => {
  const baseline = captureDiagnosticBaseline(
    'baseline',
    'context',
    [diagnostic('one.ts', 'PRIVATE ONE'), diagnostic('two.ts', 'PRIVATE TWO')],
    10,
    { maxFingerprints: 1 }
  );
  assert.equal(baseline.state, 'partial');
  assert.equal(baseline.diagnosticCount, 2);
  assert.equal(baseline.fingerprints.length, 1);
  assert.deepEqual(baseline.issues, ['hashes-truncated']);
  const serialized = JSON.stringify(baseline);
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('one.ts'), false);
});

test('computes a multiset delta and retains only bounded runtime items', () => {
  const repeated = diagnostic('same.ts', 'same');
  const removed = diagnostic('removed.ts', 'removed');
  const baseline = captureDiagnosticBaseline(
    'baseline',
    'context',
    [repeated, repeated, removed],
    10
  );
  const addedOne = diagnostic('added-one.ts', 'new one');
  const addedTwo = diagnostic('added-two.ts', 'new two');
  const delta = computeDiagnosticDelta(
    baseline,
    [repeated, addedOne, addedTwo],
    4,
    { maxAddedItems: 1 }
  );
  assert.equal(delta.state, 'complete');
  assert.equal(delta.unchangedCount, 1);
  assert.equal(delta.addedCount, 2);
  assert.equal(delta.removedCount, 2);
  assert.deepEqual(delta.added, [addedOne]);
  assert.equal(delta.addedTruncated, true);
});

test('propagates unavailable and current-side truncation honestly', () => {
  const unavailable = computeDiagnosticDelta(
    unavailableDiagnosticBaseline('baseline', 'context'),
    [],
    0
  );
  assert.equal(unavailable.state, 'unavailable');
  const baseline = captureDiagnosticBaseline('complete', 'context', [], 10);
  const partial = computeDiagnosticDelta(
    baseline,
    [diagnostic('one.ts', 'one'), diagnostic('two.ts', 'two')],
    1,
    { maxFingerprints: 1 }
  );
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.issues, ['hashes-truncated']);
  assert.equal(partial.comparedCount, 1);
  assert.equal(partial.currentCount, 2);
});

function diagnostic(
  filePath: string,
  message: string
): RuntimeDiagnostic {
  return {
    path: filePath,
    range: {
      startLine: 1,
      startCharacter: 2,
      endLine: 1,
      endCharacter: 5
    },
    severity: 'error',
    source: 'typescript',
    code: 123,
    message
  };
}
