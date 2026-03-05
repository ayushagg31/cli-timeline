import * as vscode from 'vscode';
import * as path from 'path';
import { SessionService } from '../services/sessionService';
import { Session, PromptEvent, FileChange, CLI_TOOLS } from '../models/types';

type TreeItem = SessionNode | PromptNode | FileChangeNode;

class SessionNode extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    const label = session.summary || `Session ${session.id.substring(0, 8)}`;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    const info = CLI_TOOLS[session.tool];

    this.iconPath = new vscode.ThemeIcon(info?.icon || 'symbol-event');

    if (session.shared) {
      this.description = `${session.author || 'unknown'} • ${formatDate(session.createdAt)}`;
      this.contextValue = 'sharedSession';
      this.tooltip = session.tool === 'claude-code'
        ? `Shared by ${session.author} — ${info?.name || session.tool}\nHistory & diff available. Revert not available.`
        : `Shared by ${session.author} — ${info?.name || session.tool}`;
    } else {
      this.description = formatDate(session.createdAt);
      this.contextValue = 'session';
      this.tooltip = session.tool === 'claude-code'
        ? `${info?.name || session.tool} — History & diff available. Revert not available (Claude Code does not save backup files).`
        : info?.name || session.tool;
    }
  }
}

class PromptNode extends vscode.TreeItem {
  constructor(public readonly prompt: PromptEvent) {
    const truncated = prompt.userMessage.substring(0, 80) + (prompt.userMessage.length > 80 ? '...' : '');
    super(truncated, vscode.TreeItemCollapsibleState.Collapsed);

    this.iconPath = new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.blue'));
    this.description = `${prompt.filesChanged.length} files • ${formatTimeAgo(prompt.timestamp)}`;
    this.tooltip = prompt.userMessage;
    this.contextValue = 'prompt';
  }
}

class FileChangeNode extends vscode.TreeItem {
  constructor(
    public readonly change: FileChange,
    public readonly prompt: PromptEvent
  ) {
    const fileName = path.basename(change.path);
    super(fileName, vscode.TreeItemCollapsibleState.None);

    const statusIcon = change.status === 'created' ? 'diff-added'
      : change.status === 'deleted' ? 'diff-removed' : 'diff-modified';
    const statusColor = change.status === 'created' ? 'charts.green'
      : change.status === 'deleted' ? 'charts.red' : 'charts.yellow';

    this.iconPath = new vscode.ThemeIcon(statusIcon, new vscode.ThemeColor(statusColor));
    this.description = change.path;
    this.contextValue = 'fileChange';

    this.command = {
      command: 'cliTimeline.showPromptDiff',
      title: 'Show Prompt Diff',
      arguments: [prompt, change.path],
    };
  }
}

export class SessionExplorerProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private filterText = '';
  private treeView: vscode.TreeView<TreeItem> | undefined;

  constructor(private sessionService: SessionService) {
    sessionService.onDidChange(() => this.refresh());
  }

  /** Call after registering with createTreeView to enable view messages */
  setTreeView(treeView: vscode.TreeView<TreeItem>): void {
    this.treeView = treeView;
  }

  setFilter(text: string): void {
    this.filterText = text.toLowerCase();
    if (this.treeView) {
      this.treeView.message = text ? `Filter: ${text}` : undefined;
    }
    this.refresh();
  }

  clearFilter(): void {
    this.filterText = '';
    if (this.treeView) {
      this.treeView.message = undefined;
    }
    this.refresh();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof SessionNode) {
      return getPromptsForSession(element.session, this.filterText);
    }

    if (element instanceof PromptNode) {
      return getFileChangesForPrompt(element.prompt);
    }

    return [];
  }

  private getRootChildren(): TreeItem[] {
    // Only show local (non-shared) sessions
    const sessions = this.sessionService.getSessions().filter(s => !s.shared);
    if (sessions.length === 0) {
      const item = new vscode.TreeItem('No CLI sessions found for this workspace');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item as TreeItem];
    }

    let filtered = sessions
      .filter(s => s.prompts.some(p => p.filesChanged.length > 0));

    if (this.filterText) {
      filtered = filtered.filter(s => {
        const sessionMatch = (s.summary || s.id).toLowerCase().includes(this.filterText);
        const promptMatch = s.prompts.some(p =>
          p.filesChanged.length > 0 && p.userMessage.toLowerCase().includes(this.filterText)
        );
        return sessionMatch || promptMatch;
      });
    }

    if (filtered.length === 0) {
      const item = new vscode.TreeItem(`No results for "${this.filterText}"`);
      item.iconPath = new vscode.ThemeIcon('search');
      return [item as TreeItem];
    }

    return filtered
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(s => new SessionNode(s));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

/**
 * Separate tree view provider for shared sessions committed to the repo.
 * Read-only — no revert or share buttons.
 */
export class SharedSessionExplorerProvider implements vscode.TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private sessionService: SessionService) {
    sessionService.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeItem): TreeItem[] {
    if (!element) {
      return this.getRootChildren();
    }

    if (element instanceof SessionNode) {
      return getPromptsForSession(element.session, '');
    }

    if (element instanceof PromptNode) {
      return getFileChangesForPrompt(element.prompt);
    }

    return [];
  }

  private getRootChildren(): TreeItem[] {
    const shared = this.sessionService.getSessions()
      .filter(s => s.shared && s.prompts.some(p => p.filesChanged.length > 0));

    if (shared.length === 0) {
      const item = new vscode.TreeItem('No shared sessions in this repo');
      item.iconPath = new vscode.ThemeIcon('info');
      item.description = 'Use "Share Session to Repo" to add one';
      return [item as TreeItem];
    }

    return shared
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(s => new SessionNode(s));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// Shared helpers used by both providers

function getPromptsForSession(session: Session, filterText: string): PromptNode[] {
  let prompts = session.prompts
    .filter(p => p.filesChanged.length > 0);

  if (filterText) {
    const sessionMatch = (session.summary || session.id).toLowerCase().includes(filterText);
    if (!sessionMatch) {
      prompts = prompts.filter(p =>
        p.userMessage.toLowerCase().includes(filterText)
      );
    }
  }

  // Latest first
  return prompts
    .reverse()
    .map(p => new PromptNode(p));
}

function getFileChangesForPrompt(prompt: PromptEvent): FileChangeNode[] {
  const seen = new Set<string>();
  return prompt.filesChanged
    .filter(f => {
      if (seen.has(f.path)) { return false; }
      seen.add(f.path);
      return true;
    })
    .map(f => new FileChangeNode(f, prompt));
}

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) { return 'Today'; }
  if (diffDays === 1) { return 'Yesterday'; }
  if (diffDays < 7) { return `${diffDays} days ago`; }
  return date.toLocaleDateString();
}

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) { return 'just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  if (diffHours < 24) { return `${diffHours}h ago`; }
  if (diffDays < 30) { return `${diffDays}d ago`; }
  return date.toLocaleDateString();
}
