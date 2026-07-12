import type * as vscode from 'vscode';
import {
  createPersistedSessionStore,
  decodeSessionStore,
  type PersistedSessionStore
} from './sessionStoreModel';
import type { SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export const SESSION_STORE_KEY = 'lookout.sessionStore.v2';
export const LEGACY_SESSION_STORE_KEY = 'lookout.sessions.v1';

export class SessionStore {
  public constructor(private readonly state: vscode.Memento) {}

  public async load(): Promise<PersistedSessionStore> {
    const decoded = decodeSessionStore(
      this.state.get<unknown>(SESSION_STORE_KEY),
      this.state.get<unknown>(LEGACY_SESSION_STORE_KEY)
    );
    if (decoded.migrated) {
      // A valid v2 write must complete before the legacy key is removed. If the
      // extension host stops between these operations, migration is idempotent.
      await this.state.update(SESSION_STORE_KEY, decoded.store);
      await this.state.update(LEGACY_SESSION_STORE_KEY, undefined);
    }
    return decoded.store;
  }

  public save(
    sessions: readonly AgentSession[],
    events: readonly SessionEvent[],
    nextSequence: number
  ): Thenable<void> {
    return this.state.update(
      SESSION_STORE_KEY,
      createPersistedSessionStore(sessions, events, nextSequence)
    );
  }
}
