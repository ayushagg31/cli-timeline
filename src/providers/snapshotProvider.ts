import * as vscode from 'vscode';
import { SessionService } from '../services/sessionService';
import { PromptEvent } from '../models/types';

const SCHEME = 'cli-timeline-snapshot';

/**
 * Provides virtual document content for prompt snapshots.
 * URI format: cli-timeline-snapshot:/<sessionId>/<promptId>/<encodedFilePath>
 */
export class SnapshotContentProvider implements vscode.TextDocumentContentProvider {
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private sessionService: SessionService) {}

  async provideTextDocumentContent(uri: vscode.Uri, _token: vscode.CancellationToken): Promise<string> {
    const parts = uri.path.split('/').filter(Boolean);
    if (parts.length < 3) { return '// Invalid snapshot URI'; }

    const [sessionId, promptId, ...filePathParts] = parts;
    const filePath = '/' + decodeURIComponent(filePathParts.join('/'));

    const session = this.sessionService.getSessionById(sessionId);
    if (!session) { return `// Session not found: ${sessionId}`; }

    const prompt = session.prompts.find(p => p.id === promptId);
    if (!prompt) { return `// Prompt not found: ${promptId}`; }

    // Try to get snapshot content from backup files
    const content = await this.sessionService.getSnapshotContent(prompt, filePath);
    if (content) {
      return content.toString('utf-8');
    }

    // Fallback: reconstruct from edit events by applying edits in reverse
    return this.reconstructContent(session, prompt, filePath);
  }

  /**
   * Reconstruct file state before a prompt by looking at the edit's old_str.
   * This gives us what the file looked like before the prompt's changes.
   */
  private reconstructContent(
    session: import('../models/types').Session,
    prompt: PromptEvent,
    filePath: string
  ): string {
    const change = prompt.filesChanged.find(f => f.path === filePath);
    if (!change) { return `// No changes found for ${filePath} in this prompt`; }

    if (change.status === 'created' && change.fileText) {
      // For created files, the "before" state is empty
      return `// File created by this prompt\n\n${change.fileText}`;
    }

    if (change.status === 'modified' && change.oldStr) {
      return [
        `// State before prompt: "${prompt.userMessage.substring(0, 60)}..."`,
        `// The following content was replaced by this prompt:`,
        ``,
        `// --- OLD (replaced) ---`,
        change.oldStr,
        ``,
        `// --- NEW (replacement) ---`,
        change.newStr || '',
      ].join('\n');
    }

    return `// Unable to reconstruct content for ${filePath}`;
  }

  static buildUri(sessionId: string, promptId: string, filePath: string): vscode.Uri {
    const encodedPath = filePath.startsWith('/') ? filePath.substring(1) : filePath;
    return vscode.Uri.parse(`${SCHEME}:/${sessionId}/${promptId}/${encodeURIComponent(encodedPath)}`);
  }

  static get scheme(): string {
    return SCHEME;
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}

/**
 * Show a diff between the file state before and after a prompt.
 */
export async function showPromptDiffCommand(
  sessionService: SessionService,
  prompt: PromptEvent,
  filePath: string
): Promise<void> {
  const session = sessionService.getSessionById(prompt.sessionId);
  if (!session) { return; }

  // Find the prompt index
  const promptIndex = session.prompts.findIndex(p => p.id === prompt.id);
  const promptLabel = prompt.userMessage.substring(0, 40) + (prompt.userMessage.length > 40 ? '…' : '');
  const fileName = filePath.split('/').pop() || filePath;

  // Find the change for this file
  const change = prompt.filesChanged.find(f => f.path === filePath);
  if (!change) {
    vscode.window.showInformationMessage(`No changes found for ${fileName} in this prompt.`);
    return;
  }

  if (change.status === 'created') {
    // For created files, just open the file
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
    return;
  }

  // Build URIs for the diff
  const beforeUri = SnapshotContentProvider.buildUri(session.id, prompt.id, filePath);
  const afterUri = vscode.Uri.file(filePath);

  const title = `${fileName} — Prompt #${promptIndex + 1}: "${promptLabel}"`;

  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}

/**
 * Navigate to the previous prompt's version of the current file.
 */
export async function previousPromptCommand(sessionService: SessionService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  const filePath = editor.document.uri.fsPath;
  const prompts = sessionService.getPromptsForFile(filePath);

  if (prompts.length === 0) {
    vscode.window.showInformationMessage('No CLI prompts found that changed this file.');
    return;
  }

  // Show quick pick to select which prompt to view
  const items = prompts.map((p, i) => ({
    label: `#${i + 1}: ${p.userMessage.substring(0, 60)}${p.userMessage.length > 60 ? '…' : ''}`,
    description: `${p.filesChanged.length} files • ${p.timestamp.toLocaleString()}`,
    prompt: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select prompt to compare with current file',
  });

  if (selected) {
    await showPromptDiffCommand(sessionService, selected.prompt, filePath);
  }
}

/**
 * Revert a file to its state before a prompt (using the old_str from edit events).
 */
export async function revertToPromptCommand(sessionService: SessionService): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  const filePath = editor.document.uri.fsPath;
  const prompts = sessionService.getPromptsForFile(filePath);

  if (prompts.length === 0) {
    vscode.window.showInformationMessage('No CLI prompts found that changed this file.');
    return;
  }

  const items = prompts.map((p, i) => ({
    label: `#${i + 1}: ${p.userMessage.substring(0, 60)}${p.userMessage.length > 60 ? '…' : ''}`,
    description: `${p.filesChanged.length} files • ${p.timestamp.toLocaleString()}`,
    prompt: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select prompt — file will be reverted to state BEFORE this prompt',
  });

  if (!selected) { return; }

  const confirm = await vscode.window.showWarningMessage(
    `Revert ${filePath.split('/').pop()} to state before prompt "${selected.prompt.userMessage.substring(0, 40)}"?`,
    { modal: true },
    'Revert'
  );

  if (confirm !== 'Revert') { return; }

  // Try to get snapshot content
  const content = await sessionService.getSnapshotContent(selected.prompt, filePath);
  if (content) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)
    );
    edit.replace(editor.document.uri, fullRange, content.toString('utf-8'));
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(`Reverted ${filePath.split('/').pop()} to pre-prompt state.`);
  } else {
    vscode.window.showWarningMessage('Snapshot backup not available for this prompt. Cannot revert.');
  }
}
