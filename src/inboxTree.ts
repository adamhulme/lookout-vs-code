import * as vscode from 'vscode';
import {
  groupInboxEvents,
  relativeEventTime,
  safeEventPresentation,
  type InboxGroup,
  type InboxLimits
} from './inboxQuery';
import type { SessionManager } from './sessionManager';
import type { SessionEvent } from './sessionEvents';
import type { AgentSession } from './types';

export type InboxTreeItem = InboxSessionTreeItem | InboxEventTreeItem;

export class InboxSessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly group: InboxGroup) {
    super(group.session.label, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `inbox-session-${group.session.id}`;
    this.contextValue = 'lookout.inboxSession';
    this.description = group.unreadCount
      ? `${group.unreadCount} unread · ${group.events.length} recent`
      : `${group.events.length} recent`;
    this.iconPath = group.actionCount
      ? new vscode.ThemeIcon(
          'bell-dot',
          new vscode.ThemeColor('list.warningForeground')
        )
      : group.unreadCount
        ? new vscode.ThemeIcon('bell')
        : new vscode.ThemeIcon('history');
    this.tooltip = [
      group.session.label,
      `${group.events.length} recent operational events`,
      `${group.unreadCount} unread`,
      `${group.actionCount} requiring action`
    ].join('\n');
    this.accessibilityInformation = {
      label: `${group.session.label}, ${group.unreadCount} unread events, ${group.actionCount} requiring action`
    };
  }
}

export class InboxEventTreeItem extends vscode.TreeItem {
  public readonly session: AgentSession;

  public constructor(
    public readonly event: SessionEvent,
    session: AgentSession,
    now = Date.now()
  ) {
    const presentation = safeEventPresentation(event);
    super(presentation.label, vscode.TreeItemCollapsibleState.None);
    this.session = session;
    this.id = event.id;
    this.contextValue = `lookout.inboxEvent.${event.readAt === undefined ? 'unread' : 'read'}`;
    this.description = `${relativeEventTime(event.observedAt, now)} · ${presentation.detail}`;
    this.iconPath = event.attention === 'action'
      ? new vscode.ThemeIcon(
          'bell-dot',
          new vscode.ThemeColor('list.warningForeground')
        )
      : event.attention === 'notice'
        ? new vscode.ThemeIcon('bell')
        : new vscode.ThemeIcon('circle-outline');
    this.tooltip = [
      presentation.label,
      `Session: ${session.label}`,
      `Observed: ${new Date(event.observedAt).toLocaleString()}`,
      `Source: ${presentation.detail}`,
      `Read: ${event.readAt === undefined ? 'no' : 'yes'}`
    ].join('\n');
    this.command = {
      command: 'lookout.focusSession',
      title: 'Focus Agent',
      arguments: [this]
    };
    this.accessibilityInformation = {
      label: `${presentation.label}, ${session.label}, ${event.readAt === undefined ? 'unread' : 'read'}, ${relativeEventTime(event.observedAt, now)}`
    };
  }
}

export class InboxTreeProvider
  implements vscode.TreeDataProvider<InboxTreeItem>, vscode.Disposable
{
  private readonly changedEmitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly manager: SessionManager,
    private readonly limits?: InboxLimits
  ) {
    this.subscription = manager.onDidChange(() => this.changedEmitter.fire());
  }

  public getTreeItem(element: InboxTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: InboxTreeItem): InboxTreeItem[] {
    if (element instanceof InboxSessionTreeItem) {
      return element.group.events.map(
        (event) => new InboxEventTreeItem(event, element.group.session)
      );
    }
    if (element) {
      return [];
    }
    return groupInboxEvents(
      this.manager.list(),
      this.manager.eventsFor(),
      this.limits
    ).map((group) => new InboxSessionTreeItem(group));
  }

  public refresh(): void {
    this.changedEmitter.fire();
  }

  public dispose(): void {
    this.subscription.dispose();
    this.changedEmitter.dispose();
  }
}

