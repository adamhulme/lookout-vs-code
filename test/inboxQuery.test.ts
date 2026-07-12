import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adjacentUnreadEvent,
  groupInboxEvents,
  orderedUnreadEvents,
  relativeEventTime,
  safeEventPresentation
} from '../src/inboxQuery';
import type { SessionEvent, SessionEventKind } from '../src/sessionEvents';
import type { AgentSession } from '../src/types';

test('groups bounded recent rows with action-required sessions first', () => {
  const routine = session('routine', 'codex', 1);
  const urgent = session('urgent', 'claude', 2);
  const events = [
    event('routine-1', 'routine', 1, 'provider-running'),
    event('routine-2', 'routine', 2, 'provider-completed', 'notice'),
    event('urgent-1', 'urgent', 3, 'provider-attention', 'action'),
    event('urgent-2', 'urgent', 4, 'delegated-started'),
    event('urgent-3', 'urgent', 5, 'command-started')
  ];

  const groups = groupInboxEvents([routine, urgent], events, {
    maxGroups: 10,
    maxEventsPerGroup: 2
  });

  assert.deepEqual(groups.map((group) => group.session.id), ['urgent', 'routine']);
  assert.deepEqual(groups[0]?.events.map((item) => item.id), [
    'urgent-1',
    'urgent-3'
  ]);
  assert.equal(groups[0]?.actionCount, 1);
  assert.equal(groups[0]?.unreadCount, 1);
});

test('orders unread action events before notices and navigates cyclically', () => {
  const events = [
    event('notice-old', 'a', 1, 'provider-completed', 'notice'),
    event('action-new', 'b', 4, 'provider-attention', 'action'),
    event('action-old', 'a', 2, 'identity-conflict', 'action'),
    { ...event('read', 'a', 3, 'provider-failed', 'notice'), readAt: 10 },
    event('routine', 'a', 5, 'provider-running')
  ];

  assert.deepEqual(orderedUnreadEvents(events).map((item) => item.id), [
    'action-old',
    'action-new',
    'notice-old'
  ]);
  assert.equal(adjacentUnreadEvent(events, undefined, 1)?.id, 'action-old');
  assert.equal(adjacentUnreadEvent(events, undefined, -1)?.id, 'notice-old');
  assert.equal(adjacentUnreadEvent(events, 'notice-old', 1)?.id, 'action-old');
  assert.equal(adjacentUnreadEvent(events, 'action-old', -1)?.id, 'notice-old');
});

test('uses fixed safe event summaries and never renders stored payload text', () => {
  const unsafe: SessionEvent = {
    ...event('unsafe', 'a', 1, 'command-finished', 'notice'),
    summary: 'SECRET command output and transcript text',
    correlationId: 'SECRET-correlation',
    providerSessionId: 'SECRET-provider-id',
    outcome: 'failed'
  };

  const presentation = safeEventPresentation(unsafe);
  assert.deepEqual(presentation, {
    label: 'Agent command finished',
    detail: 'Failed · Provider hook'
  });
  assert.equal(JSON.stringify(presentation).includes('SECRET'), false);
});

test('formats stable compact relative event times', () => {
  const now = 10 * 24 * 60 * 60 * 1_000;
  assert.equal(relativeEventTime(now - 30_000, now), 'just now');
  assert.equal(relativeEventTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(relativeEventTime(now - 3 * 60 * 60_000, now), '3h ago');
  assert.equal(relativeEventTime(now - 2 * 24 * 60 * 60_000, now), '2d ago');
});

function session(
  id: string,
  kind: AgentSession['kind'],
  updatedAt: number
): AgentSession {
  return {
    id,
    kind,
    label: id,
    command: kind,
    cwd: `/repo/${id}`,
    status: 'closed',
    createdAt: 1,
    updatedAt,
    terminalName: id,
    bridgeAvailable: false,
    unread: false,
    backgroundAgents: [],
    runningCommands: [],
    foregroundState: 'stopped',
    providerSessions: [],
    lineage: { operation: 'new' },
    integration: {
      lifecycle: 'disabled',
      hookTrust: 'not-applicable'
    }
  };
}

function event(
  id: string,
  sessionId: string,
  sequence: number,
  kind: SessionEventKind,
  attention: SessionEvent['attention'] = 'none'
): SessionEvent {
  return {
    id,
    sessionId,
    sequence,
    kind,
    observedAt: sequence * 1_000,
    source: 'provider-hook',
    summary: 'ignored stored summary',
    attention
  };
}
