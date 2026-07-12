import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSessionAge,
  operationalStatsTooltipLines,
  sessionOperationalStats
} from '../src/sessionStats';
import type { SessionEvent } from '../src/sessionEvents';
import type { AgentSession } from '../src/types';

test('computes bounded operational counters for only the requested session', () => {
  const value = session('target');
  value.backgroundAgents = [{ id: 'currently-active', label: 'private label' }];
  value.exitCode = 17;
  const stats = sessionOperationalStats(
    value,
    [
      event(1, 'target', 'provider-attention', 'action'),
      event(2, 'target', 'provider-completed', 'notice'),
      { ...event(3, 'target', 'delegated-started'), correlationId: 'agent-a' },
      { ...event(4, 'target', 'delegated-finished'), correlationId: 'agent-a' },
      { ...event(5, 'target', 'delegated-started'), correlationId: 'agent-b' },
      event(6, 'target', 'identity-observed'),
      event(7, 'other', 'identity-observed', 'action')
    ],
    121_000
  );

  assert.deepEqual(stats, {
    ageMs: 120_000,
    eventCount: 6,
    attentionEventCount: 2,
    delegatedEventCount: 3,
    delegatedAgentCount: 3,
    activeDelegatedAgentCount: 1,
    providerIdentityObservationCount: 1,
    exitCode: 17
  });
});

test('uses fixed tooltip labels and never includes stored text or identifiers', () => {
  const value = session('opaque-session-id');
  value.backgroundAgents = [{ id: 'opaque-agent-id', label: 'SECRET label' }];
  const events = [
    {
      ...event(1, value.id, 'delegated-started'),
      summary: 'SECRET provider message',
      correlationId: 'opaque-agent-id'
    }
  ];
  const text = operationalStatsTooltipLines(
    sessionOperationalStats(value, events, 61_000)
  ).join('\n');

  assert.match(text, /Age: 1 minute/);
  assert.match(text, /Delegated agents observed: 1/);
  assert.doesNotMatch(text, /SECRET|opaque/);
});

test('formats elapsed age in compact whole units and clamps clock skew', () => {
  assert.equal(formatSessionAge(-1), 'less than 1 minute');
  assert.equal(formatSessionAge(59_999), 'less than 1 minute');
  assert.equal(formatSessionAge(60_000), '1 minute');
  assert.equal(formatSessionAge(3_600_000), '1 hour');
  assert.equal(formatSessionAge(86_400_000), '1 day');
});

function event(
  sequence: number,
  sessionId: string,
  kind: SessionEvent['kind'],
  attention: SessionEvent['attention'] = 'none'
): SessionEvent {
  return {
    id: `event-${sequence}`,
    sequence,
    sessionId,
    kind,
    observedAt: sequence,
    source: 'system',
    summary: 'ignored',
    attention
  };
}

function session(id: string): AgentSession {
  return {
    id,
    kind: 'codex',
    label: 'Session',
    command: 'private command',
    cwd: '/repo',
    status: 'closed',
    createdAt: 1_000,
    updatedAt: 1_000,
    terminalName: 'Session',
    bridgeAvailable: true,
    unread: false,
    backgroundAgents: [],
    runningCommands: [],
    foregroundState: 'done',
    providerSessions: [],
    lineage: { operation: 'new' },
    integration: {
      lifecycle: 'healthy',
      hookTrust: 'observed'
    }
  };
}
