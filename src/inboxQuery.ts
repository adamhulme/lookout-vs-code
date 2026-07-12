import type { SessionEvent, SessionEventKind } from './sessionEvents';
import type { AgentSession } from './types';

export interface InboxLimits {
  readonly maxGroups: number;
  readonly maxEventsPerGroup: number;
}

export interface InboxGroup {
  readonly session: AgentSession;
  readonly events: readonly SessionEvent[];
  readonly unreadCount: number;
  readonly actionCount: number;
  readonly latestSequence: number;
}

export interface SafeEventPresentation {
  readonly label: string;
  readonly detail: string;
}

export const DEFAULT_INBOX_LIMITS: InboxLimits = {
  maxGroups: 50,
  maxEventsPerGroup: 20
};

export function groupInboxEvents(
  sessions: readonly AgentSession[],
  events: readonly SessionEvent[],
  limits: InboxLimits = DEFAULT_INBOX_LIMITS
): InboxGroup[] {
  const eventsBySession = new Map<string, SessionEvent[]>();
  for (const event of events) {
    const existing = eventsBySession.get(event.sessionId) ?? [];
    existing.push(event);
    eventsBySession.set(event.sessionId, existing);
  }

  return sessions
    .flatMap((session): InboxGroup[] => {
      const all = eventsBySession.get(session.id) ?? [];
      if (all.length === 0) {
        return [];
      }
      const sorted = [...all].sort((left, right) => right.sequence - left.sequence);
      const unread = all.filter(isUnreadAttention);
      const unreadIds = new Set(unread.map((event) => event.id));
      const displayOrder = [
        ...orderedUnreadEvents(unread),
        ...sorted.filter((event) => !unreadIds.has(event.id))
      ];
      const bounded = displayOrder.slice(
        0,
        Math.max(1, limits.maxEventsPerGroup)
      );
      return [
        {
          session,
          events: bounded,
          unreadCount: unread.length,
          actionCount: unread.filter((event) => event.attention === 'action').length,
          latestSequence: sorted[0]?.sequence ?? 0
        }
      ];
    })
    .sort(compareInboxGroups)
    .slice(0, Math.max(1, limits.maxGroups));
}

/** Action-required events come first, followed by unread notices, oldest first. */
export function orderedUnreadEvents(
  events: readonly SessionEvent[]
): SessionEvent[] {
  return events.filter(isUnreadAttention).sort((left, right) => {
    const priority = attentionPriority(left) - attentionPriority(right);
    return priority || left.sequence - right.sequence;
  });
}

export function adjacentUnreadEvent(
  events: readonly SessionEvent[],
  currentEventId: string | undefined,
  direction: 1 | -1
): SessionEvent | undefined {
  const unread = orderedUnreadEvents(events);
  if (unread.length === 0) {
    return undefined;
  }
  const index = unread.findIndex((event) => event.id === currentEventId);
  if (index < 0) {
    return direction === 1 ? unread[0] : unread.at(-1);
  }
  return unread[(index + direction + unread.length) % unread.length];
}

/**
 * Event text is derived exclusively from allow-listed enums. `event.summary`,
 * correlation IDs, provider IDs, command text, and provider payloads are not
 * rendered by the inbox.
 */
export function safeEventPresentation(
  event: Pick<SessionEvent, 'kind' | 'outcome' | 'source'>
): SafeEventPresentation {
  const label = EVENT_LABELS[event.kind];
  const outcome = event.outcome ? outcomeLabel(event.outcome) : undefined;
  return {
    label,
    detail: `${outcome ? `${outcome} · ` : ''}${sourceLabel(event.source)}`
  };
}

export function relativeEventTime(observedAt: number, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - observedAt) / 1_000));
  if (elapsedSeconds < 60) {
    return 'just now';
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

function compareInboxGroups(left: InboxGroup, right: InboxGroup): number {
  const action = Number(right.actionCount > 0) - Number(left.actionCount > 0);
  if (action !== 0) {
    return action;
  }
  const unread = Number(right.unreadCount > 0) - Number(left.unreadCount > 0);
  return unread || right.latestSequence - left.latestSequence;
}

function isUnreadAttention(event: SessionEvent): boolean {
  return event.readAt === undefined && event.attention !== 'none';
}

function attentionPriority(event: SessionEvent): number {
  return event.attention === 'action' ? 0 : 1;
}

function outcomeLabel(outcome: NonNullable<SessionEvent['outcome']>): string {
  switch (outcome) {
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    case 'unknown':
      return 'Unknown outcome';
  }
}

function sourceLabel(source: SessionEvent['source']): string {
  switch (source) {
    case 'provider-hook':
      return 'Provider hook';
    case 'terminal':
      return 'Terminal';
    case 'git':
      return 'Git';
    case 'task':
      return 'Task';
    case 'debug':
      return 'Debug';
    case 'user':
      return 'User action';
    case 'system':
      return 'Lookout';
  }
}

const EVENT_LABELS: Readonly<Record<SessionEventKind, string>> = {
  'session-created': 'Session created',
  'session-adopted': 'Terminal adopted',
  'session-focused': 'Session focused',
  'session-renamed': 'Session renamed',
  'session-removed': 'Session removed',
  'terminal-active': 'Terminal process active',
  'terminal-exited': 'Terminal process exited',
  'terminal-closed': 'Terminal closed',
  'provider-running': 'Agent is working',
  'provider-attention': 'Agent needs attention',
  'provider-completed': 'Agent completed',
  'provider-failed': 'Agent failed',
  'turn-finished': 'Agent turn finished',
  'delegated-started': 'Delegated agent started',
  'delegated-finished': 'Delegated agent finished',
  'command-started': 'Agent command started',
  'command-finished': 'Agent command finished',
  'identity-observed': 'Provider session identity observed',
  'identity-conflict': 'Provider session identity conflict'
};
