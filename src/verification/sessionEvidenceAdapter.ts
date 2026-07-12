import type { AgentSession } from '../types';
import type { ReviewSessionSnapshot } from './runtimeEvidence';

/**
 * Projects the session model onto the narrow identity/baseline shape accepted
 * by verification. Command text, output, prompts, and provider data cannot
 * cross this boundary.
 */
export function toReviewSessionSnapshots(
  sessions: readonly Pick<AgentSession, 'id' | 'baseline'>[],
  isOpen: (sessionId: string) => boolean
): ReviewSessionSnapshot[] {
  return sessions.map((session) => ({
    id: session.id,
    isOpen: isOpen(session.id),
    ...(session.baseline ? { baseline: session.baseline } : {})
  }));
}
