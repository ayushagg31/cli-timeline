import * as vscode from 'vscode';
import { SessionService } from '../services/sessionService';
import { Session, PromptEvent, FileChange, CLI_TOOLS } from '../models/types';

type TreeItem = ToolNode | SessionNode | PromptNode | FileChangeNode;

class ToolNode extends vscode.TreeItem {
  constructor(public readonly toolKey: string, sessionCount: number) {
    const info = CLI_TOOLS[toolKey as keyof typeof CLI_TOOLS];
    super(
      `${info?.name || toolKey} (${sessionCount})`,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.iconPath = new vscode.ThemeIcon(info?.icon || 'symbol-event');
    this.contextValue = 'tool';
  }
}

class SessionNode extends vscode.TreeItem {
  constructor(public readonly session: Session) {
    const label = session.summary || `Session ${session.id.substring(0, 8)}`;
    super(label, vscode.TreeItemCollapsibleState.Collapsed);

    const info = CLI_TOOLS[session.tool];
    this.iconPath = new vscode.ThemeIcon(info?.icon || 'symbol-event');
    this.description = formatDate(session.createdAt);
    this.tooltip = new vscode.MarkdownString(
      `**${label}**\n\n` +
      `📅 ${session.createdAt.toLocaleString()}\n\n` +
      `📂 ${session.cwd}\n\n` +
      `🔀 ${session.branch || 'N/A'}\n\n` +
      `💬 ${session.prompts.length} prompts`
    );
    this.contextValue = 'session';
  }
}

class PromptNode extends vscode.TreeItem {
  constructor(
    public readonly prompt: PromptEvent,
    public readonly promptIndex: number
  ) {
    const truncated = prompt.userMessage.substring(0, 80) + (prompt.userMessage.length > 80 ? '...' : '');
    super(`#${promptIndex + 1}: ${truncated}`, vscode.TreeItemCollapsibleState.Collapsed);

    const info = CLI_TOOLS[prompt.tool];
    this.iconPath = new vscode.ThemeIcon('comment', new vscode.ThemeColor('charts.blue'));
    this.description = `${prompt.filesChanged.length} files • ${formatTimeAgo(prompt.timestamp)}`;
    this.tooltip = new vscode.MarkdownString(
      `**Prompt #${promptIndex + 1}**\n\n` +
      `> ${prompt.userMessage.substring(0, 300)}\n\n` +
      `📅 ${prompt.timestamp.toLocaleString()}\n\n` +
      `📄 ${prompt.filesChanged.length} files changed\n\n` +
      `🔧 ${prompt.toolCalls.length} tool calls`
    );
    this.contextValue = 'prompt';
  }
}

class FileChangeNode extends vscode.TreeItem {
  constructor(
    public readonly change: FileChange,
    public readonly prompt: PromptEvent
  ) {
    const fileName = change.path.split('/').pop() || change.path;
    super(fileName, vscode.TreeItemCollapsibleState.None);

    const statusIcon = change.status === 'created' ? 'diff-added'
      : change.status === 'deleted' ? 'diff-removed' : 'diff-modified';
    const statusColor = change.status === 'created' ? 'charts.green'
      : change.status === 'deleted' ? 'charts.red' : 'charts.yellow';

    this.iconPath = new vscode.ThemeIcon(statusIcon, new vscode.ThemeColor(statusColor));
    this.description = change.path;
    this.tooltip = `${change.status}: ${change.path}`;
    this.contextValue = 'fileChange';

    // Click to open the file
    this.command = {
      command: 'vscode.open',
      title: 'Open File',
      arguments: [vscode.Uri.file(change.path)],
    };
  }
}

export class SessionExplorerProvider implements vscode.TreeDataProvider<TreeItem> {
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

    if (element instanceof ToolNode) {
      return this.getSessionsForTool(element.toolKey);
    }

    if (element instanceof SessionNode) {
      return this.getPromptsForSession(element.session);
    }

    if (element instanceof PromptNode) {
      return this.getFileChangesForPrompt(element.prompt);
    }

    return [];
  }

  private getRootChildren(): TreeItem[] {
    const sessions = this.sessionService.getSessions();
    if (sessions.length === 0) {
      const item = new vscode.TreeItem('No CLI sessions found for this workspace');
      item.iconPath = new vscode.ThemeIcon('info');
      return [item as TreeItem];
    }

    // Group by tool
    const byTool = new Map<string, Session[]>();
    for (const session of sessions) {
      const existing = byTool.get(session.tool) || [];
      existing.push(session);
      byTool.set(session.tool, existing);
    }

    // If only one tool, skip the tool grouping level
    if (byTool.size === 1) {
      const [, toolSessions] = [...byTool.entries()][0];
      return this.groupSessionsByDate(toolSessions);
    }

    return [...byTool.entries()].map(([tool, toolSessions]) =>
      new ToolNode(tool, toolSessions.length)
    );
  }

  private getSessionsForTool(toolKey: string): TreeItem[] {
    const sessions = this.sessionService.getSessions().filter(s => s.tool === toolKey);
    return this.groupSessionsByDate(sessions);
  }

  private groupSessionsByDate(sessions: Session[]): SessionNode[] {
    // Sort by date descending and return as flat list with date in description
    return sessions
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map(s => new SessionNode(s));
  }

  private getPromptsForSession(session: Session): PromptNode[] {
    return session.prompts.map((p, i) => new PromptNode(p, i));
  }

  private getFileChangesForPrompt(prompt: PromptEvent): FileChangeNode[] {
    return prompt.filesChanged.map(f => new FileChangeNode(f, prompt));
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
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
