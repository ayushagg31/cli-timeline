import * as vscode from 'vscode';
import { SessionService } from '../services/sessionService';
import { CLI_TOOLS, PromptEvent } from '../models/types';

export class PromptHoverProvider implements vscode.HoverProvider {
  constructor(private sessionService: SessionService) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): vscode.Hover | undefined {
    const lineText = document.lineAt(position.line).text;
    const filePath = document.uri.fsPath;

    const prompt = this.sessionService.getPromptForLine(filePath, lineText);
    if (!prompt) { return undefined; }

    const toolInfo = CLI_TOOLS[prompt.tool];
    const session = this.sessionService.getSessionById(prompt.sessionId);

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportHtml = true;

    // Header
    md.appendMarkdown(`### $(${toolInfo?.icon || 'sparkle'}) CLI Timeline — Prompt Blame\n\n`);

    // Prompt text
    md.appendMarkdown(`> ${prompt.userMessage.substring(0, 400)}\n\n`);

    // Metadata
    md.appendMarkdown(`**Tool:** ${toolInfo?.name || prompt.tool}\n\n`);
    md.appendMarkdown(`**When:** ${prompt.timestamp.toLocaleString()} (${formatTimeAgo(prompt.timestamp)})\n\n`);

    if (session) {
      md.appendMarkdown(`**Session:** ${session.summary || session.id.substring(0, 8)}\n\n`);
      if (session.branch) {
        md.appendMarkdown(`**Branch:** \`${session.branch}\`\n\n`);
      }
    }

    // Files changed by this prompt
    if (prompt.filesChanged.length > 0) {
      md.appendMarkdown(`**Files changed** (${prompt.filesChanged.length}):\n\n`);
      for (const file of prompt.filesChanged.slice(0, 10)) {
        const icon = file.status === 'created' ? '➕' : file.status === 'deleted' ? '❌' : '✏️';
        const shortPath = file.path.split('/').slice(-2).join('/');
        md.appendMarkdown(`${icon} \`${shortPath}\`\n\n`);
      }
      if (prompt.filesChanged.length > 10) {
        md.appendMarkdown(`_...and ${prompt.filesChanged.length - 10} more_\n\n`);
      }
    }

    // Tool calls summary
    if (prompt.toolCalls.length > 0) {
      const counts = new Map<string, number>();
      for (const tc of prompt.toolCalls) {
        counts.set(tc.toolName, (counts.get(tc.toolName) || 0) + 1);
      }
      md.appendMarkdown(`**Tools used:** ${[...counts.entries()].map(([n, c]) => `\`${n}\` ×${c}`).join(' · ')}\n\n`);
    }

    // Action links
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`[Show in Session Explorer](command:cliTimeline.revealPrompt?${encodeURIComponent(JSON.stringify(prompt.id))}) · `);
    md.appendMarkdown(`[Show All Prompts for File](command:cliTimeline.showPromptsForFile?${encodeURIComponent(JSON.stringify(filePath))})`);

    return new vscode.Hover(md);
  }
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
