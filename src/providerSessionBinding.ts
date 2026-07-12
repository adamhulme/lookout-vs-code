import type {
  AgentEvent,
  AgentSession,
  ManagedAgentKind,
  ProviderSessionReference,
  SessionIntegration,
  SessionLineage
} from './types';

const MAX_PROVIDER_REFERENCES = 8;

export interface ProviderBindingResult {
  readonly session: AgentSession;
  readonly changed: boolean;
  readonly conflict?: string;
}

export function bindProviderSession(
  session: AgentSession,
  event: AgentEvent,
  now = Date.now()
): ProviderBindingResult {
  const provider = event.provider;
  const providerSessionId = event.providerSessionId?.trim();
  if (!provider || !providerSessionId) {
    return { session, changed: false };
  }
  if (session.kind !== provider) {
    return conflict(
      session,
      `Received ${provider} identity for a ${session.kind} session`,
      now
    );
  }

  const references = [...session.providerSessions];
  const current = references.at(-1);
  if (!current) {
    const expected = session.integration.expectedProviderSessionId;
    if (expected && expected !== providerSessionId) {
      return conflict(
        session,
        `Resumed provider session ${providerSessionId} did not match expected ${expected}`,
        now
      );
    }
    if (
      session.lineage.operation === 'fork' &&
      session.lineage.sourceProviderSessionId === providerSessionId
    ) {
      return conflict(
        session,
        'Fork reused the source provider session identity',
        now
      );
    }
    return {
      session: withHealthyIdentity(
        session,
        [...references, reference(provider, providerSessionId, now)],
        now
      ),
      changed: true
    };
  }
  if (current.provider === provider && current.id === providerSessionId) {
    references[references.length - 1] = { ...current, lastSeenAt: now };
    return {
      session: withHealthyIdentity(session, references, now),
      changed: true
    };
  }

  const expected = session.integration.expectedProviderSessionId;
  if (expected && expected === providerSessionId) {
    return {
      session: withHealthyIdentity(
        session,
        appendReference(references, reference(provider, providerSessionId, now)),
        now
      ),
      changed: true
    };
  }
  if (event.providerSessionSource === 'clear') {
    return {
      session: withHealthyIdentity(
        session,
        appendReference(references, reference(provider, providerSessionId, now)),
        now
      ),
      changed: true
    };
  }

  return conflict(
    session,
    `Provider session changed unexpectedly from ${current.id} to ${providerSessionId}`,
    now
  );
}

export function providerSessionCollision(
  sessions: readonly AgentSession[],
  lookoutSessionId: string,
  provider: ManagedAgentKind,
  providerSessionId: string,
  isOpen: (sessionId: string) => boolean
): AgentSession | undefined {
  return sessions.find(
    (candidate) =>
      candidate.id !== lookoutSessionId &&
      candidate.kind === provider &&
      isOpen(candidate.id) &&
      candidate.providerSessions.at(-1)?.id === providerSessionId
  );
}

export function normalizeProviderSessionState(session: AgentSession): AgentSession {
  const kind = session.kind;
  const providerSessions = Array.isArray(session.providerSessions)
    ? session.providerSessions.filter(isProviderReference).slice(-MAX_PROVIDER_REFERENCES)
    : [];
  return {
    ...session,
    providerSessions,
    lineage: normalizeLineage(session.lineage),
    integration: normalizeIntegration(session.integration, kind)
  };
}

function withHealthyIdentity(
  session: AgentSession,
  providerSessions: ProviderSessionReference[],
  now: number
): AgentSession {
  return {
    ...session,
    providerSessions: providerSessions.slice(-MAX_PROVIDER_REFERENCES),
    integration: {
      lifecycle: 'healthy',
      hookTrust: 'observed',
      lastHookAt: now
    }
  };
}

function conflict(
  session: AgentSession,
  message: string,
  now: number
): ProviderBindingResult {
  return {
    session: {
      ...session,
      integration: {
        ...session.integration,
        lifecycle: 'stale',
        lastHookAt: now,
        conflict: message
      }
    },
    changed: true,
    conflict: message
  };
}

function reference(
  provider: ManagedAgentKind,
  id: string,
  now: number
): ProviderSessionReference {
  return {
    provider,
    id,
    firstSeenAt: now,
    lastSeenAt: now,
    state: 'available'
  };
}

function appendReference(
  references: readonly ProviderSessionReference[],
  next: ProviderSessionReference
): ProviderSessionReference[] {
  return [...references, next].slice(-MAX_PROVIDER_REFERENCES);
}

function normalizeLineage(value: unknown): SessionLineage {
  if (!isRecord(value)) {
    return { operation: 'new' };
  }
  const operation = value.operation;
  if (
    operation !== 'new' &&
    operation !== 'resume' &&
    operation !== 'fork' &&
    operation !== 'reopen'
  ) {
    return { operation: 'new' };
  }
  return {
    operation,
    ...(typeof value.sourceLookoutSessionId === 'string'
      ? { sourceLookoutSessionId: value.sourceLookoutSessionId }
      : {}),
    ...(typeof value.sourceProviderSessionId === 'string'
      ? { sourceProviderSessionId: value.sourceProviderSessionId }
      : {})
  };
}

function normalizeIntegration(
  value: unknown,
  kind: AgentSession['kind']
): SessionIntegration {
  if (!isRecord(value)) {
    return {
      lifecycle: kind === 'custom' ? 'disabled' : 'awaiting-first-hook',
      hookTrust: kind === 'custom' ? 'not-applicable' : 'unknown'
    };
  }
  const lifecycle = value.lifecycle;
  const normalizedLifecycle =
    lifecycle === 'disabled' ||
    lifecycle === 'bridge-unavailable' ||
    lifecycle === 'injection-skipped' ||
    lifecycle === 'awaiting-first-hook' ||
    lifecycle === 'healthy' ||
    lifecycle === 'stale'
      ? lifecycle
      : kind === 'custom'
        ? 'disabled'
        : 'awaiting-first-hook';
  const hookTrust = value.hookTrust;
  return {
    lifecycle: normalizedLifecycle,
    hookTrust:
      hookTrust === 'not-applicable' ||
      hookTrust === 'unknown' ||
      hookTrust === 'observed'
        ? hookTrust
        : kind === 'custom'
          ? 'not-applicable'
          : 'unknown',
    ...(typeof value.lastHookAt === 'number' && Number.isFinite(value.lastHookAt)
      ? { lastHookAt: value.lastHookAt }
      : {}),
    ...(typeof value.expectedProviderSessionId === 'string'
      ? { expectedProviderSessionId: value.expectedProviderSessionId }
      : {}),
    ...(typeof value.conflict === 'string' ? { conflict: value.conflict } : {})
  };
}

function isProviderReference(value: unknown): value is ProviderSessionReference {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.provider === 'codex' || value.provider === 'claude') &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.firstSeenAt === 'number' &&
    typeof value.lastSeenAt === 'number' &&
    (value.state === 'available' ||
      value.state === 'provider-archived' ||
      value.state === 'unavailable' ||
      value.state === 'unknown')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
