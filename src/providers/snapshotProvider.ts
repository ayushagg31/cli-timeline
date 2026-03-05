import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
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
    if (parts.length < 3) { return ''; }

    const [sessionId, promptId, ...filePathParts] = parts;
    const reconstructedPath = decodeURIComponent(filePathParts.join('/'));
    // Preserve Windows absolute paths (e.g., C:/Users/...) — don't prepend /
    const filePath = /^[a-zA-Z]:/.test(reconstructedPath) ? reconstructedPath : '/' + reconstructedPath;

    const session = this.sessionService.getSessionById(sessionId);
    if (!session) { return ''; }

    const prompt = session.prompts.find(p => p.id === promptId);
    if (!prompt) { return ''; }

    // Primary: use the backup file saved by the CLI
    const content = await this.sessionService.getSnapshotContent(prompt, filePath);
    if (content) {
      return content.toString('utf-8');
    }

    // Secondary: reconstruct from old_str/new_str edit data in events.jsonl
    const reconstructed = await this.reconstructContent(session, prompt, filePath);
    if (reconstructed !== null) {
      return reconstructed;
    }

    // No data available — show a readable message in the diff panel
    return [
      '⚠ Snapshot not available',
      '',
      'No backup was found for this file. This session may be old or the CLI was not updated at the time.',
      'Ensure your CLI is updated to the latest version to enable backups for future sessions.',
    ].join('\n');
  }

  /**
   * Reconstruct file state before a prompt using old_str/new_str edit data from events.jsonl.
   * Returns null when there is no edit data available to reconstruct from.
   */
  private async reconstructContent(
    session: import('../models/types').Session,
    prompt: PromptEvent,
    filePath: string
  ): Promise<string | null> {
    const change = prompt.filesChanged.find(f => f.path === filePath);
    if (!change) { return null; }

    // Before a created file — it didn't exist, so empty is correct
    if (change.status === 'created') {
      return '';
    }

    // Read current file and reverse all edits from this prompt onward using old_str/new_str
    try {
      const currentContent = await fs.promises.readFile(filePath, 'utf-8');
      let content = currentContent;

      const promptIndex = session.prompts.findIndex(p => p.id === prompt.id);

      // Reverse edits from latest prompt back to current prompt (inclusive)
      for (let i = session.prompts.length - 1; i >= promptIndex; i--) {
        const p = session.prompts[i];
        const edits = p.filesChanged
          .filter(f => f.path === filePath && f.status === 'modified' && f.newStr && f.oldStr);
        for (let j = edits.length - 1; j >= 0; j--) {
          const edit = edits[j];
          if (!edit.newStr || !edit.oldStr) { continue; }
          const idx = content.indexOf(edit.newStr);
          if (idx === -1) { continue; }
          // Only replace if the match is unambiguous (appears exactly once)
          const lastIdx = content.lastIndexOf(edit.newStr);
          if (idx === lastIdx) {
            content = content.substring(0, idx) + edit.oldStr + content.substring(idx + edit.newStr.length);
          }
        }
      }

      return content;
    } catch {
      // Current file doesn't exist on disk; use the stored oldStr snippet as last resort
      return change.oldStr ?? null;
    }
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

  const promptIndex = session.prompts.findIndex(p => p.id === prompt.id);
  const promptLabel = prompt.userMessage.substring(0, 40) + (prompt.userMessage.length > 40 ? '…' : '');
  const fileName = path.basename(filePath);

  const change = prompt.filesChanged.find(f => f.path === filePath);
  if (!change) {
    vscode.window.showInformationMessage(`No changes found for ${fileName} in this prompt.`);
    return;
  }

  const beforeUri = SnapshotContentProvider.buildUri(session.id, prompt.id, filePath);

  let afterUri: vscode.Uri;
  const nextPromptWithFile = session.prompts
    .slice(promptIndex + 1)
    .find(p => p.filesChanged.some(f => f.path === filePath && f.backupFile));

  if (nextPromptWithFile) {
    afterUri = SnapshotContentProvider.buildUri(session.id, nextPromptWithFile.id, filePath);
  } else {
    afterUri = vscode.Uri.file(filePath);
  }

  const title = `${fileName} — "${promptLabel}"`;
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
}

/**
 * Revert a single file to its state before a prompt.
 */
export async function revertFileToSnapshotCommand(
  sessionService: SessionService,
  prompt: PromptEvent,
  filePath: string
): Promise<void> {
  const fileName = path.basename(filePath);
  const promptLabel = prompt.userMessage.substring(0, 40) + (prompt.userMessage.length > 40 ? '…' : '');

  const confirm = await vscode.window.showWarningMessage(
    `Revert ${fileName} to state before "${promptLabel}"?`,
    { modal: true },
    'Revert'
  );
  if (confirm !== 'Revert') { return; }

  const content = await sessionService.getSnapshotContent(prompt, filePath);
  if (!content) {
    vscode.window.showWarningMessage(
      `Cannot revert ${fileName}: No backup was found for this file. ` +
      `This session may be old or the CLI was not updated at the time. ` +
      `Ensure your CLI is updated to the latest version for future sessions.`
    );
    return;
  }

  const uri = vscode.Uri.file(filePath);
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(uri, fullRange, content.toString('utf-8'));
  await vscode.workspace.applyEdit(edit);
  vscode.window.showInformationMessage(`Reverted ${fileName} to pre-prompt state.`);
}

/**
 * Revert all files changed by a prompt to their pre-prompt state.
 */
export async function revertPromptCommand(
  sessionService: SessionService,
  prompt: PromptEvent,
): Promise<void> {
  const promptLabel = prompt.userMessage.substring(0, 40) + (prompt.userMessage.length > 40 ? '…' : '');
  const filesWithBackup = prompt.filesChanged.filter(f => f.backupFile);
  const filesWithoutBackup = prompt.filesChanged.filter(f => !f.backupFile);

  if (filesWithBackup.length === 0) {
    vscode.window.showWarningMessage(
      `Cannot revert "${promptLabel}": No backups were found for any files in this prompt. ` +
      `This session may be old or the CLI was not updated at the time. ` +
      `Ensure your CLI is updated to the latest version for future sessions.`
    );
    return;
  }

  // Build confirmation message — warn explicitly if some files will be skipped
  let message = `Revert ${filesWithBackup.length} file(s) to state before "${promptLabel}"?`;
  if (filesWithoutBackup.length > 0) {
    const skippedNames = filesWithoutBackup
      .map(f => `• ${path.basename(f.path)}`)
      .join('\n');
    message +=
      `\n\n${filesWithoutBackup.length} file(s) have no backup (session may be old or CLI was not updated at the time) and will be skipped:\n` +
      skippedNames;
  }

  const confirmLabel = filesWithoutBackup.length > 0
    ? `Revert ${filesWithBackup.length} of ${prompt.filesChanged.length} Files`
    : 'Revert All';

  const confirm = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    confirmLabel
  );
  if (confirm !== confirmLabel) { return; }

  let reverted = 0;
  const batchEdit = new vscode.WorkspaceEdit();

  for (const change of filesWithBackup) {
    const content = await sessionService.getSnapshotContent(prompt, change.path);
    if (!content) { continue; }

    try {
      const uri = vscode.Uri.file(change.path);
      const document = await vscode.workspace.openTextDocument(uri);
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      batchEdit.replace(uri, fullRange, content.toString('utf-8'));
      reverted++;
    } catch {
      // skip files that can't be reverted
    }
  }

  if (reverted > 0) {
    await vscode.workspace.applyEdit(batchEdit);
  }

  vscode.window.showInformationMessage(`Reverted ${reverted} file(s) to pre-prompt state.`);
}

/**
 * Revert a file to its state before a prompt (command palette version).
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

  const items = prompts.map(p => ({
    label: p.userMessage.substring(0, 60) + (p.userMessage.length > 60 ? '…' : ''),
    description: `${p.filesChanged.length} files • ${p.timestamp.toLocaleString()}`,
    prompt: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select prompt — file will be reverted to state BEFORE this prompt',
  });

  if (!selected) { return; }

  const confirm = await vscode.window.showWarningMessage(
    `Revert ${path.basename(filePath)} to state before prompt "${selected.prompt.userMessage.substring(0, 40)}"?`,
    { modal: true },
    'Revert'
  );

  if (confirm !== 'Revert') { return; }

  const content = await sessionService.getSnapshotContent(selected.prompt, filePath);
  if (content) {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      editor.document.positionAt(0),
      editor.document.positionAt(editor.document.getText().length)
    );
    edit.replace(editor.document.uri, fullRange, content.toString('utf-8'));
    await vscode.workspace.applyEdit(edit);
    vscode.window.showInformationMessage(`Reverted ${path.basename(filePath)} to pre-prompt state.`);
  } else {
    vscode.window.showWarningMessage(
      `Cannot revert ${path.basename(filePath)}: No backup was found for this file. ` +
      `This session may be old or the CLI was not updated at the time. ` +
      `Ensure your CLI is updated to the latest version for future sessions.`
    );
  }
}
