import type { AgentEvent, ManagedAgentKind } from './types';

export type SessionEventKind =
  | 'session-created'
  | 'session-adopted'
  | 'session-focused'
  | 'session-renamed'
  | 'session-removed'
  | 'terminal-active'
  | 'terminal-exited'
  | 'terminal-closed'
  | 'provider-running'
  | 'provider-attention'
  | 'provider-completed'
  | 'provider-failed'
  | 'turn-finished'
  | 'delegated-started'
  | 'delegated-finished'
  | 'command-started'
  | 'command-finished'
  | 'identity-observed'
  | 'identity-conflict';

export type SessionEventSource =
  | 'provider-hook'
  | 'terminal'
  | 'git'
  | 'task'
  | 'debug'
  | 'user'
  | 'system';

export interface SessionEvent {
  readonly id: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly kind: SessionEventKind;
  readonly observedAt: number;
  readonly source: SessionEventSource;
  readonly summary: string;
  readonly attention: 'none' | 'notice' | 'action';
  readonly provider?: ManagedAgentKind;
  readonly providerSessionId?: string;
  readonly correlationId?: string;
  readonly outcome?: 'completed' | 'failed' | 'interrupted' | 'unknown';
  readAt?: number;
}

export interface EventLedger {
  readonly nextSequence: number;
  readonly events: readonly SessionEvent[];
}

export interface EventRetention {
  readonly maxEventsPerSession: number;
  readonly maxEventsPerWorkspace: number;
}

export const DEFAULT_EVENT_RETENTION: EventRetention = {
  maxEventsPerSession: 200,
  maxEventsPerWorkspace: 1_000
};

export function appendSessionEvent(
  ledger: EventLedger,
  event: Omit<SessionEvent, 'id' | 'sequence'>,
  retention: EventRetention = DEFAULT_EVENT_RETENTION
): EventLedger {
  const sequence = Math.max(1, Math.floor(ledger.nextSequence));
  const next: SessionEvent = {
    ...event,
    id: `event-${sequence}`,
    sequence
  };
  return {
    nextSequence: sequence + 1,
    events: pruneEvents([...ledger.events, next], retention)
  };
}

export function markSessionEventsRead(
  ledger: EventLedger,
  sessionId: string,
  readAt = Date.now()
): EventLedger {
  let changed = false;
  const events = ledger.events.map((event) => {
    if (event.sessionId !== sessionId || event.readAt !== undefined) {
      return event;
    }
    changed = true;
    return { ...event, readAt };
  });
  return changed ? { ...ledger, events } : ledger;
}

export function unreadSessionEvents(
  ledger: EventLedger,
  sessionId?: string
): SessionEvent[] {
  return ledger.events.filter(
    (event) =>
      event.readAt === undefined &&
      event.attention !== 'none' &&
      (sessionId === undefined || event.sessionId === sessionId)
  );
}

export function removeSessionEvents(
  ledger: EventLedger,
  sessionId: string
): EventLedger {
  return {
    ...ledger,
    events: ledger.events.filter((event) => event.sessionId !== sessionId)
  };
}

export function eventFromAgentEvent(
  event: AgentEvent,
  observedAt = Date.now()
): Omit<SessionEvent, 'id' | 'sequence'> {
  const common = {
    sessionId: event.sessionId,
    observedAt,
    source: 'provider-hook' as const,
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.providerSessionId
      ? { providerSessionId: event.providerSessionId }
      : {})
  };
  switch (event.kind) {
    case 'provider-session':
      return {
        ...common,
        kind: 'identity-observed',
        summary: 'Provider session identity observed',
        attention: 'none'
      };
    case 'status':
      return {
        ...common,
        kind: `provider-${event.status}` as Extract<
          SessionEventKind,
          | 'provider-running'
          | 'provider-attention'
          | 'provider-completed'
          | 'provider-failed'
        >,
        summary: statusSummary(event.status),
        attention:
          event.status === 'attention'
            ? 'action'
            : event.status === 'completed' || event.status === 'failed'
              ? 'notice'
              : 'none',
        ...(event.status === 'completed'
          ? { outcome: 'completed' as const }
          : event.status === 'failed'
            ? { outcome: 'failed' as const }
            : {})
      };
    case 'foreground-stop':
      return {
        ...common,
        kind: 'turn-finished',
        summary:
          event.reason === 'turn-end'
            ? 'Agent turn finished'
            : 'Agent is waiting for input',
        attention: event.reason === 'turn-end' ? 'notice' : 'action'
      };
    case 'background-start':
      return {
        ...common,
        kind: 'delegated-started',
        summary: 'Delegated agent started',
        attention: 'none',
        correlationId: event.agentId
      };
    case 'background-stop':
      return {
        ...common,
        kind: 'delegated-finished',
        summary: 'Delegated agent finished',
        attention: 'none',
        correlationId: event.agentId
      };
    case 'command-start':
      return {
        ...common,
        kind: 'command-started',
        summary: 'Agent command started',
        attention: 'none',
        correlationId: event.commandId
      };
    case 'command-stop':
      return {
        ...common,
        kind: 'command-finished',
        summary: 'Agent command finished',
        attention: event.result?.outcome === 'failed' ? 'notice' : 'none',
        correlationId: event.commandId,
        ...(event.result ? { outcome: event.result.outcome } : {})
      };
  }
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    typeof value.sequence === 'number' &&
    typeof value.sessionId === 'string' &&
    typeof value.observedAt === 'number' &&
    typeof value.summary === 'string' &&
    SESSION_EVENT_KINDS.has(value.kind as SessionEventKind) &&
    SESSION_EVENT_SOURCES.has(value.source as SessionEventSource) &&
    (value.attention === 'none' ||
      value.attention === 'notice' ||
      value.attention === 'action')
  );
}

function pruneEvents(
  events: readonly SessionEvent[],
  retention: EventRetention
): SessionEvent[] {
  const perSession = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const existing = perSession.get(event.sessionId) ?? [];
    existing.push(event);
    perSession.set(event.sessionId, existing);
  }
  const retained = [...perSession.values()].flatMap((sessionEvents) =>
    sessionEvents.slice(-Math.max(1, retention.maxEventsPerSession))
  );
  return retained
    .sort((a, b) => a.sequence - b.sequence)
    .slice(-Math.max(1, retention.maxEventsPerWorkspace));
}

function statusSummary(status: 'running' | 'attention' | 'completed' | 'failed'): string {
  switch (status) {
    case 'running':
      return 'Agent is working';
    case 'attention':
      return 'Agent needs attention';
    case 'completed':
      return 'Agent completed';
    case 'failed':
      return 'Agent failed';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const SESSION_EVENT_KINDS = new Set<SessionEventKind>([
  'session-created',
  'session-adopted',
  'session-focused',
  'session-renamed',
  'session-removed',
  'terminal-active',
  'terminal-exited',
  'terminal-closed',
  'provider-running',
  'provider-attention',
  'provider-completed',
  'provider-failed',
  'turn-finished',
  'delegated-started',
  'delegated-finished',
  'command-started',
  'command-finished',
  'identity-observed',
  'identity-conflict'
]);

const SESSION_EVENT_SOURCES = new Set<SessionEventSource>([
  'provider-hook',
  'terminal',
  'git',
  'task',
  'debug',
  'user',
  'system'
]);
