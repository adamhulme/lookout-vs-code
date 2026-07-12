import { normalizeSessionActivity } from './sessionActivity';
import { isSessionEvent, type SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export const SESSION_STORE_SCHEMA_VERSION = 2 as const;

export interface PersistedSessionStore {
  readonly schemaVersion: typeof SESSION_STORE_SCHEMA_VERSION;
  readonly nextSequence: number;
  readonly sessions: AgentSession[];
  readonly events: SessionEvent[];
}

export interface DecodedSessionStore {
  readonly store: PersistedSessionStore;
  readonly migrated: boolean;
}

export function decodeSessionStore(
  current: unknown,
  legacy: unknown
): DecodedSessionStore {
  if (isRecord(current) && current.schemaVersion === SESSION_STORE_SCHEMA_VERSION) {
    const sessions = Array.isArray(current.sessions)
      ? current.sessions.filter(isPersistedSession).map(normalizeSessionActivity)
      : [];
    const events = Array.isArray(current.events)
      ? current.events.filter(isSessionEvent).sort((a, b) => a.sequence - b.sequence)
      : [];
    const highestSequence = events.at(-1)?.sequence ?? 0;
    const requestedNext =
      typeof current.nextSequence === 'number' && Number.isFinite(current.nextSequence)
        ? Math.floor(current.nextSequence)
        : 1;
    return {
      store: {
        schemaVersion: SESSION_STORE_SCHEMA_VERSION,
        nextSequence: Math.max(1, highestSequence + 1, requestedNext),
        sessions,
        events
      },
      migrated: false
    };
  }

  const sessions = Array.isArray(legacy)
    ? legacy.filter(isPersistedSession).map(normalizeSessionActivity)
    : [];
  return {
    store: {
      schemaVersion: SESSION_STORE_SCHEMA_VERSION,
      nextSequence: 1,
      sessions,
      events: []
    },
    migrated: true
  };
}

export function createPersistedSessionStore(
  sessions: readonly AgentSession[],
  events: readonly SessionEvent[],
  nextSequence: number
): PersistedSessionStore {
  return {
    schemaVersion: SESSION_STORE_SCHEMA_VERSION,
    nextSequence: Math.max(1, Math.floor(nextSequence)),
    sessions: sessions.map(toPersistedSession),
    events: [...events]
  };
}

export function toPersistedSession(session: AgentSession): AgentSession {
  return {
    ...session,
    command: session.kind === 'custom' ? '' : session.command,
    ...(session.kind === 'custom' ? { providerCommand: undefined } : {}),
    // Both fields describe live provider processes. They are invalid after a
    // restore, and command text can contain sensitive arguments.
    runningCommands: [],
    backgroundAgents: []
  };
}

export function isPersistedSession(value: unknown): value is AgentSession {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.id === 'string' &&
    (value.kind === 'codex' || value.kind === 'claude' || value.kind === 'custom') &&
    typeof value.label === 'string' &&
    typeof value.command === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.status === 'string' &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.terminalName === 'string' &&
    typeof value.bridgeAvailable === 'boolean' &&
    typeof value.unread === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
