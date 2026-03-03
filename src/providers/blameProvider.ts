import * as vscode from 'vscode';
import { SessionService } from '../services/sessionService';
import { CLI_TOOLS } from '../models/types';

export class BlameProvider implements vscode.Disposable {
  private decoration: vscode.TextEditorDecorationType;
  private disposables: vscode.Disposable[] = [];
  private enabled = true;

  constructor(private sessionService: SessionService) {
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: {
        margin: '0 0 0 3em',
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
      },
      isWholeLine: true,
    });

    this.enabled = vscode.workspace.getConfiguration('cliTimeline').get('blame.enabled', true);

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(e => this.updateBlame(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor) { this.updateBlame(editor); }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('cliTimeline.blame.enabled')) {
          this.enabled = vscode.workspace.getConfiguration('cliTimeline').get('blame.enabled', true);
          const editor = vscode.window.activeTextEditor;
          if (editor) {
            if (this.enabled) { this.updateBlame(editor); }
            else { editor.setDecorations(this.decoration, []); }
          }
        }
      })
    );

    // Initial blame for active editor
    if (vscode.window.activeTextEditor && this.enabled) {
      this.updateBlame(vscode.window.activeTextEditor);
    }
  }

  toggle(): void {
    this.enabled = !this.enabled;
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      if (this.enabled) { this.updateBlame(editor); }
      else { editor.setDecorations(this.decoration, []); }
    }
  }

  private updateBlame(editor: vscode.TextEditor): void {
    if (!this.enabled) { return; }

    const selection = editor.selection;
    const line = selection.active.line;
    const lineText = editor.document.lineAt(line).text;
    const filePath = editor.document.uri.fsPath;

    const prompt = this.sessionService.getPromptForLine(filePath, lineText);
    if (!prompt) {
      editor.setDecorations(this.decoration, []);
      return;
    }

    const toolInfo = CLI_TOOLS[prompt.tool];
    const icon = toolInfo ? `$(${toolInfo.icon})` : '$(sparkle)';
    const toolName = toolInfo?.name || prompt.tool;
    const promptText = prompt.userMessage.substring(0, 40) +
      (prompt.userMessage.length > 40 ? '…' : '');
    const timeAgo = formatTimeAgo(prompt.timestamp);

    const range = new vscode.Range(line, 0, line, 0);
    const decorationOptions: vscode.DecorationOptions = {
      range,
      renderOptions: {
        after: {
          contentText: `${icon}  "${promptText}" • ${toolName} • ${timeAgo}`,
        },
      },
    };

    editor.setDecorations(this.decoration, [decorationOptions]);
  }

  dispose(): void {
    this.decoration.dispose();
    this.disposables.forEach(d => d.dispose());
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
