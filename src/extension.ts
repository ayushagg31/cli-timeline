import * as vscode from 'vscode';
import { SessionService } from './services/sessionService';
import { SessionExplorerProvider, SharedSessionExplorerProvider } from './views/sessionExplorer';
import {
  SnapshotContentProvider,
  showPromptDiffCommand,
  revertToPromptCommand,
  revertFileToSnapshotCommand,
  revertPromptCommand,
} from './providers/snapshotProvider';

let sessionService: SessionService;

export async function activate(context: vscode.ExtensionContext) {
  console.log('CLI Timeline: activating...');

  sessionService = new SessionService();

  // Session Explorer sidebar — local sessions
  const sessionExplorer = new SessionExplorerProvider(sessionService);
  const treeView = vscode.window.createTreeView('cliTimeline.sessions', {
    treeDataProvider: sessionExplorer,
  });
  sessionExplorer.setTreeView(treeView);
  context.subscriptions.push(treeView);

  // Shared Sessions sidebar — sessions committed to the repo
  const sharedExplorer = new SharedSessionExplorerProvider(sessionService);
  const sharedTreeView = vscode.window.createTreeView('cliTimeline.sharedSessions', {
    treeDataProvider: sharedExplorer,
  });
  context.subscriptions.push(sharedTreeView);

  // Snapshot Content Provider (virtual documents for diffs)
  const snapshotProvider = new SnapshotContentProvider(sessionService);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SnapshotContentProvider.scheme, snapshotProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cliTimeline.refreshSessions', () => loadWorkspaceSessions()),
    vscode.commands.registerCommand('cliTimeline.showPromptsForFile', (uri?: vscode.Uri) => {
      showPromptsForFile(uri);
    }),
    vscode.commands.registerCommand('cliTimeline.showPromptDiff', (prompt, filePath) => {
      showPromptDiffCommand(sessionService, prompt, filePath);
    }),
    vscode.commands.registerCommand('cliTimeline.revertToPrompt', () => {
      revertToPromptCommand(sessionService);
    }),
    vscode.commands.registerCommand('cliTimeline.revertFileToSnapshot', (node: any) => {
      if (node?.prompt && node?.change) {
        revertFileToSnapshotCommand(sessionService, node.prompt, node.change.path);
      }
    }),
    vscode.commands.registerCommand('cliTimeline.revertPrompt', (node: any) => {
      if (node?.prompt) {
        revertPromptCommand(sessionService, node.prompt);
      }
    }),
    vscode.commands.registerCommand('cliTimeline.copySessionId', (node: any) => {
      if (node?.session?.id) {
        vscode.env.clipboard.writeText(node.session.id);
        vscode.window.showInformationMessage(`Session ID copied: ${node.session.id.substring(0, 8)}…`);
      }
    }),
    vscode.commands.registerCommand('cliTimeline.commitSession', async (node: any) => {
      if (!node?.session) { return; }
      const session = node.session;
      if (session.shared) {
        vscode.window.showInformationMessage('This session is already shared from the repo.');
        return;
      }
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) { return; }
      const workspacePath = folders[0].uri.fsPath;

      try {
        await sessionService.commitSessionToRepo(session, workspacePath);
        vscode.window.showInformationMessage(
          `Session "${session.summary || session.id.substring(0, 8)}" committed to .cli-sessions/`
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to commit session: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('cliTimeline.filterSessions', async () => {
      const input = await vscode.window.showInputBox({
        placeHolder: 'Search sessions and prompts...',
        prompt: 'Filter by session name or prompt text',
      });
      if (input !== undefined) {
        sessionExplorer.setFilter(input);
        vscode.commands.executeCommand('setContext', 'cliTimeline.filterActive', input.length > 0);
      }
    }),
    vscode.commands.registerCommand('cliTimeline.clearFilter', () => {
      sessionExplorer.clearFilter();
      vscode.commands.executeCommand('setContext', 'cliTimeline.filterActive', false);
    }),
  );

  // File watcher for live session updates
  const watcher = setupFileWatcher();
  if (watcher) { context.subscriptions.push(watcher); }

  // Load sessions on startup
  await loadWorkspaceSessions();

  // Reload when workspace changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => loadWorkspaceSessions())
  );

  console.log('CLI Timeline: activated successfully');
}

async function loadWorkspaceSessions(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) { return; }

  const workspacePath = folders[0].uri.fsPath;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'CLI Timeline: Loading sessions...' },
    async () => {
      await sessionService.loadSessions(workspacePath);
      const sessions = sessionService.getSessions();
      const hasShared = sessions.some(s => s.shared);
      vscode.commands.executeCommand('setContext', 'cliTimeline.hasSharedSessions', hasShared);
      if (sessions.length > 0) {
        const totalPrompts = sessions.reduce((sum, s) => sum + s.prompts.length, 0);
        vscode.window.setStatusBarMessage(
          `$(history) CLI Timeline: ${sessions.length} sessions, ${totalPrompts} prompts`,
          5000
        );
      }
    }
  );
}

async function showPromptsForFile(uri?: vscode.Uri): Promise<void> {
  const fileUri = uri || vscode.window.activeTextEditor?.document.uri;
  if (!fileUri) { return; }

  const prompts = sessionService.getPromptsForFile(fileUri.fsPath);
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
    placeHolder: `${prompts.length} prompts changed this file`,
    matchOnDescription: true,
  });

  if (selected) {
    await showPromptDiffCommand(sessionService, selected.prompt, fileUri.fsPath);
  }
}

let lastReloadTime = 0;
const RELOAD_DEBOUNCE_MS = 5000;

function setupFileWatcher(): vscode.FileSystemWatcher | undefined {
  try {
    const nodeos = require('os');
    const nodepath = require('path');
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(nodepath.join(nodeos.homedir(), '.copilot', 'session-state')),
      '**/events.jsonl'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const debouncedReload = () => {
      const now = Date.now();
      if (now - lastReloadTime > RELOAD_DEBOUNCE_MS) {
        lastReloadTime = now;
        loadWorkspaceSessions();
      }
    };
    watcher.onDidChange(debouncedReload);
    watcher.onDidCreate(debouncedReload);
    return watcher;
  } catch {
    return undefined;
  }
}

export function deactivate() {
  sessionService?.dispose();
}
