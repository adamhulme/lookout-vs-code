import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindProviderSession,
  normalizeProviderSessionState,
  providerSessionCollision
} from '../src/providerSessionBinding';
import { createSession } from '../src/sessionModel';

test('binds and refreshes a provider identity without duplicating it', () => {
  const session = createSession('codex', 'One', 'codex', '/repo', 1, 'one');
  const first = bindProviderSession(
    session,
    {
      kind: 'status',
      sessionId: 'one',
      status: 'running',
      provider: 'codex',
      providerSessionId: 'provider-1',
      providerSessionSource: 'startup'
    },
    2
  ).session;
  const refreshed = bindProviderSession(
    first,
    {
      kind: 'foreground-stop',
      sessionId: 'one',
      provider: 'codex',
      providerSessionId: 'provider-1',
      reason: 'turn-end'
    },
    3
  ).session;

  assert.equal(refreshed.providerSessions.length, 1);
  assert.equal(refreshed.providerSessions[0].firstSeenAt, 2);
  assert.equal(refreshed.providerSessions[0].lastSeenAt, 3);
  assert.equal(refreshed.integration.lifecycle, 'healthy');
  assert.equal(refreshed.integration.hookTrust, 'observed');
});

test('allows documented clear identity rotation and rejects unexplained changes', () => {
  const session = bindProviderSession(
    createSession('claude', 'One', 'claude', '/repo', 1, 'one'),
    {
      kind: 'status',
      sessionId: 'one',
      status: 'running',
      provider: 'claude',
      providerSessionId: 'provider-1'
    },
    2
  ).session;
  const rotated = bindProviderSession(
    session,
    {
      kind: 'status',
      sessionId: 'one',
      status: 'running',
      provider: 'claude',
      providerSessionId: 'provider-2',
      providerSessionSource: 'clear'
    },
    3
  );
  assert.deepEqual(
    rotated.session.providerSessions.map((reference) => reference.id),
    ['provider-1', 'provider-2']
  );

  const conflict = bindProviderSession(
    rotated.session,
    {
      kind: 'status',
      sessionId: 'one',
      status: 'running',
      provider: 'claude',
      providerSessionId: 'unexpected'
    },
    4
  );
  assert.match(conflict.conflict ?? '', /changed unexpectedly/);
  assert.equal(conflict.session.providerSessions.at(-1)?.id, 'provider-2');
  assert.equal(conflict.session.integration.lifecycle, 'stale');
});

test('finds an open duplicate provider session and normalizes legacy state', () => {
  const one = bindProviderSession(
    createSession('codex', 'One', 'codex', '/repo', 1, 'one'),
    {
      kind: 'status',
      sessionId: 'one',
      status: 'running',
      provider: 'codex',
      providerSessionId: 'provider-1'
    },
    2
  ).session;
  const two = createSession('codex', 'Two', 'codex', '/repo', 2, 'two');
  assert.equal(
    providerSessionCollision(
      [one, two],
      'two',
      'codex',
      'provider-1',
      () => true
    )?.id,
    'one'
  );

  const normalized = normalizeProviderSessionState({
    ...two,
    providerSessions: undefined,
    lineage: undefined,
    integration: undefined
  } as unknown as typeof two);
  assert.deepEqual(normalized.providerSessions, []);
  assert.deepEqual(normalized.lineage, { operation: 'new' });
  assert.equal(normalized.integration.lifecycle, 'awaiting-first-hook');
});

test('enforces expected resume identity and requires a new fork identity', () => {
  const resume = {
    ...createSession('codex', 'Resume', 'codex resume expected', '/repo', 1, 'resume'),
    lineage: {
      operation: 'resume' as const,
      sourceProviderSessionId: 'expected'
    },
    integration: {
      lifecycle: 'awaiting-first-hook' as const,
      hookTrust: 'unknown' as const,
      expectedProviderSessionId: 'expected'
    }
  };
  const mismatch = bindProviderSession(
    resume,
    {
      kind: 'provider-session',
      sessionId: 'resume',
      provider: 'codex',
      providerSessionId: 'wrong'
    },
    2
  );
  assert.match(mismatch.conflict ?? '', /did not match expected/);
  assert.deepEqual(mismatch.session.providerSessions, []);

  const fork = {
    ...createSession('claude', 'Fork', 'claude --resume source --fork-session', '/repo', 1, 'fork'),
    lineage: {
      operation: 'fork' as const,
      sourceProviderSessionId: 'source'
    }
  };
  const reused = bindProviderSession(
    fork,
    {
      kind: 'provider-session',
      sessionId: 'fork',
      provider: 'claude',
      providerSessionId: 'source'
    },
    2
  );
  assert.match(reused.conflict ?? '', /reused the source/);
});
