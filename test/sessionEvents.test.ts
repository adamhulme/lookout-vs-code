import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendSessionEvent,
  eventFromAgentEvent,
  markSessionEventsRead,
  unreadSessionEvents,
  type EventLedger
} from '../src/sessionEvents';

test('stores bounded operational command metadata without command text or output', () => {
  const event = eventFromAgentEvent(
    {
      kind: 'command-stop',
      sessionId: 'one',
      commandId: 'tool-1',
      command: 'deploy --token super-secret',
      provider: 'claude',
      providerSessionId: 'provider-1',
      result: {
        outcome: 'failed',
        stderr: 'another-secret',
        exitCode: 1
      }
    },
    5
  );
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('another-secret'), false);
  assert.equal(event.correlationId, 'tool-1');
  assert.equal(event.outcome, 'failed');
});

test('retains bounded events and tracks event-level read state', () => {
  let ledger: EventLedger = { nextSequence: 1, events: [] };
  for (let index = 0; index < 5; index += 1) {
    ledger = appendSessionEvent(
      ledger,
      {
        sessionId: 'one',
        kind: 'provider-attention',
        source: 'provider-hook',
        summary: 'Agent needs attention',
        attention: 'action',
        observedAt: index
      },
      { maxEventsPerSession: 3, maxEventsPerWorkspace: 10 }
    );
  }
  assert.deepEqual(
    ledger.events.map((event) => event.sequence),
    [3, 4, 5]
  );
  assert.equal(unreadSessionEvents(ledger, 'one').length, 3);
  ledger = markSessionEventsRead(ledger, 'one', 10);
  assert.equal(unreadSessionEvents(ledger).length, 0);
  assert.ok(ledger.events.every((event) => event.readAt === 10));
});
