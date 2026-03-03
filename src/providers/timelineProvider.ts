import * as vscode from 'vscode';
import { SessionService } from '../services/sessionService';
import { CLI_TOOLS, PromptEvent } from '../models/types';

export class PromptTimelineProvider implements vscode.TimelineProvider {
  readonly id = 'cli-timeline';
  readonly label = 'CLI Timeline';

  private _onDidChange = new vscode.EventEmitter<vscode.TimelineChangeEvent>();
  readonly onDidChange = this._onDidChange.event;

  readonly scheme = 'file';

  constructor(private sessionService: SessionService) {
    sessionService.onDidChange(() => {
      this._onDidChange.fire({ uri: undefined, reset: true });
    });
  }

  async provideTimeline(
    uri: vscode.Uri,
    options: vscode.TimelineOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.Timeline> {
    const filePath = uri.fsPath;
    const prompts = this.sessionService.getPromptsForFile(filePath);

    if (prompts.length === 0) {
      return { items: [] };
    }

    const items: vscode.TimelineItem[] = prompts.map((prompt, index) => {
      const toolInfo = CLI_TOOLS[prompt.tool];
      const truncated = prompt.userMessage.substring(0, 60) +
        (prompt.userMessage.length > 60 ? '…' : '');

      const item = new vscode.TimelineItem(truncated, prompt.timestamp.getTime());
      item.id = prompt.id;
      item.description = toolInfo?.name || prompt.tool;
      item.detail = prompt.userMessage;
      item.iconPath = new vscode.ThemeIcon(
        toolInfo?.icon || 'sparkle',
        new vscode.ThemeColor('charts.blue')
      );

      // Tooltip with rich info
      item.tooltip = new vscode.MarkdownString(
        `**${toolInfo?.name || prompt.tool}** — ${formatTimeAgo(prompt.timestamp)}\n\n` +
        `> ${prompt.userMessage.substring(0, 300)}\n\n` +
        `📄 ${prompt.filesChanged.length} files changed\n\n` +
        `🔧 ${prompt.toolCalls.length} tool calls` +
        (prompt.toolCalls.length > 0
          ? '\n\n' + summarizeToolCalls(prompt)
          : '')
      );

      // Command to open diff when clicked
      item.command = {
        command: 'cliTimeline.showPromptDiff',
        title: 'Show Prompt Diff',
        arguments: [prompt, filePath],
      };

      return item;
    });

    return { items };
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

function summarizeToolCalls(prompt: PromptEvent): string {
  const counts = new Map<string, number>();
  for (const tc of prompt.toolCalls) {
    counts.set(tc.toolName, (counts.get(tc.toolName) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => `\`${name}\` ×${count}`)
    .join(' · ');
}

function formatTimeAgo(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) { return 'just now'; }
  if (diffMins < 60) { return `${diffMins}m ago`; }
  if (diffHours < 24) { return `${diffHours}h ago`; }
  if (diffDays < 30) { return `${diffDays}d ago`; }
  return date.toLocaleDateString();
}
