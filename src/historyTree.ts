import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildHistoryEntries,
  historyAvailabilityLabel,
  safeHistoryLatestEvent,
  type HistoryAvailability,
  type HistoryEntry
} from './historyQuery';
import type { SessionManager } from './sessionManager';
import type { SessionEvent } from './sessionEvents';
import {
  operationalStatsTooltipLines,
  sessionOperationalStats
} from './sessionStats';
import type { AgentSession } from './types';

const HISTORY_ICONS: Readonly<Record<HistoryAvailability, vscode.ThemeIcon>> = {
  open: new vscode.ThemeIcon('terminal', new vscode.ThemeColor('charts.green')),
  resumable: new vscode.ThemeIcon('debug-restart'),
  'terminal-only': new vscode.ThemeIcon('history'),
  closed: new vscode.ThemeIcon('circle-slash'),
  archived: new vscode.ThemeIcon('archive')
};

export class HistoryTreeItem extends vscode.TreeItem {
  public readonly session: AgentSession;

  public constructor(
    public readonly entry: HistoryEntry,
    events: readonly SessionEvent[] = []
  ) {
    const { session, availability } = entry;
    super(session.label, vscode.TreeItemCollapsibleState.None);
    const stats = sessionOperationalStats(session, events);
    this.session = session;
    this.id = `history-${session.id}`;
    this.contextValue = `lookout.historySession.${availability}`;
    this.description = `${historyAvailabilityLabel(availability)} · ${path.basename(session.cwd)}`;
    this.iconPath = HISTORY_ICONS[availability];
    const identity = session.providerSessions.at(-1);
    this.tooltip = [
      session.label,
      `Provider: ${session.kind}`,
      `Availability: ${historyAvailabilityLabel(availability)}`,
      `Directory: ${session.cwd}`,
      `Provider identity: ${identity ? 'observed' : 'not available'}`,
      `Latest: ${safeHistoryLatestEvent(entry.latestEvent)}`,
      `Last activity: ${new Date(entry.lastActivityAt).toLocaleString()}`,
      ...operationalStatsTooltipLines(stats)
    ].join('\n');
    this.command = availability === 'open'
      ? {
          command: 'lookout.focusSession',
          title: 'Focus Agent',
          arguments: [this]
        }
      : availability === 'resumable'
        ? {
            command: 'lookout.resumeSession',
            title: 'Resume Agent',
            arguments: [this]
          }
        : undefined;
    this.accessibilityInformation = {
      label: `${session.label}, ${historyAvailabilityLabel(availability)}, ${session.kind}`
    };
  }
}

export class HistoryTreeProvider
  implements vscode.TreeDataProvider<HistoryTreeItem>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly manager: SessionManager,
    private readonly maximum = 100
  ) {
    this.subscription = manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: HistoryTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(): HistoryTreeItem[] {
    return buildHistoryEntries(
      this.manager.history(),
      this.manager.eventsFor(),
      (id) => this.manager.isOpen(id),
      this.maximum
    ).map(
      (entry) =>
        new HistoryTreeItem(
          entry,
          this.manager.eventsFor(entry.session.id)
        )
    );
  }

  public refresh(): void {
    this.changedEmitter.fire();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changedEmitter.dispose();
  }
}
