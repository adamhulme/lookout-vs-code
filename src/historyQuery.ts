import { safeEventPresentation } from './inboxQuery';
import { providerFor } from './providers/providerRegistry';
import type { SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export type HistoryAvailability =
  | 'open'
  | 'resumable'
  | 'terminal-only'
  | 'closed'
  | 'archived';

export interface HistoryEntry {
  readonly session: AgentSession;
  readonly availability: HistoryAvailability;
  readonly latestEvent?: SessionEvent;
  readonly lastActivityAt: number;
}

export function buildHistoryEntries(
  sessions: readonly AgentSession[],
  events: readonly SessionEvent[],
  isOpen: (sessionId: string) => boolean,
  maximum = 100
): HistoryEntry[] {
  const latestBySession = new Map<string, SessionEvent>();
  for (const event of events) {
    const existing = latestBySession.get(event.sessionId);
    if (!existing || existing.sequence < event.sequence) {
      latestBySession.set(event.sessionId, event);
    }
  }
  return sessions
    .map((session): HistoryEntry => {
      const latestEvent = latestBySession.get(session.id);
      return {
        session,
        availability: historyAvailability(session, isOpen(session.id)),
        ...(latestEvent ? { latestEvent } : {}),
        lastActivityAt: Math.max(
          session.updatedAt,
          latestEvent?.observedAt ?? session.updatedAt
        )
      };
    })
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    .slice(0, Math.max(1, maximum));
}

export function historyAvailability(
  session: AgentSession,
  open: boolean
): HistoryAvailability {
  if (session.archivedAt !== undefined) {
    return 'archived';
  }
  if (open) {
    return 'open';
  }
  const provider = providerFor(session.kind);
  const reference = session.providerSessions.at(-1);
  if (session.kind === 'custom' || !reference) {
    return 'terminal-only';
  }
  if (
    provider.capabilities.resume.support === 'supported' &&
    reference.state === 'available'
  ) {
    return 'resumable';
  }
  return 'closed';
}

export function historyAvailabilityLabel(value: HistoryAvailability): string {
  switch (value) {
    case 'open':
      return 'Open terminal';
    case 'resumable':
      return 'Resumable';
    case 'terminal-only':
      return 'Terminal-only history';
    case 'closed':
      return 'Closed';
    case 'archived':
      return 'Archived in Lookout';
  }
}

export function safeHistoryLatestEvent(event: SessionEvent | undefined): string {
  return event ? safeEventPresentation(event).label : 'No recorded events';
}
