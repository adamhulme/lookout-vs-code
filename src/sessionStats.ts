import type { SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export interface SessionOperationalStats {
  readonly ageMs: number;
  readonly eventCount: number;
  readonly attentionEventCount: number;
  readonly delegatedEventCount: number;
  readonly delegatedAgentCount: number;
  readonly activeDelegatedAgentCount: number;
  readonly providerIdentityObservationCount: number;
  readonly exitCode?: number;
}

/**
 * Produces display-only operational counters from metadata Lookout already
 * keeps. Event payload text and correlation identifiers are never returned.
 */
export function sessionOperationalStats(
  session: AgentSession,
  events: readonly SessionEvent[],
  now = Date.now()
): SessionOperationalStats {
  const sessionEvents = events.filter((event) => event.sessionId === session.id);
  const delegatedEvents = sessionEvents.filter(
    (event) =>
      event.kind === 'delegated-started' || event.kind === 'delegated-finished'
  );
  const observedDelegatedAgents = new Set([
    ...session.backgroundAgents.map((agent) => agent.id),
    ...delegatedEvents.flatMap((event) =>
      event.correlationId === undefined ? [] : [event.correlationId]
    )
  ]);
  const startsWithoutIdentity = delegatedEvents.filter(
    (event) =>
      event.kind === 'delegated-started' && event.correlationId === undefined
  ).length;

  return {
    ageMs: Math.max(0, now - session.createdAt),
    eventCount: sessionEvents.length,
    attentionEventCount: sessionEvents.filter(
      (event) => event.attention !== 'none'
    ).length,
    delegatedEventCount: delegatedEvents.length,
    delegatedAgentCount: observedDelegatedAgents.size + startsWithoutIdentity,
    activeDelegatedAgentCount: session.backgroundAgents.length,
    providerIdentityObservationCount: sessionEvents.filter(
      (event) => event.kind === 'identity-observed'
    ).length,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode })
  };
}

export function formatSessionAge(ageMs: number): string {
  const totalMinutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (totalMinutes < 1) {
    return 'less than 1 minute';
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours} hour${totalHours === 1 ? '' : 's'}`;
  }
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays} day${totalDays === 1 ? '' : 's'}`;
}

export function operationalStatsTooltipLines(
  stats: SessionOperationalStats
): readonly string[] {
  const lines = [
    `Age: ${formatSessionAge(stats.ageMs)}`,
    `Recorded events: ${stats.eventCount}`,
    `Attention events: ${stats.attentionEventCount}`,
    `Provider identity observations: ${stats.providerIdentityObservationCount}`
  ];
  if (stats.delegatedAgentCount > 0 || stats.delegatedEventCount > 0) {
    lines.push(
      `Delegated agents observed: ${stats.delegatedAgentCount}`,
      `Delegated agents active: ${stats.activeDelegatedAgentCount}`,
      `Delegated activity events: ${stats.delegatedEventCount}`
    );
  }
  if (stats.exitCode !== undefined) {
    lines.push(`Known exit code: ${stats.exitCode}`);
  }
  return lines;
}
