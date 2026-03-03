import * as vscode from 'vscode';
import { SessionService } from './services/sessionService';
import { SessionExplorerProvider } from './views/sessionExplorer';
import { BlameProvider } from './providers/blameProvider';
import { PromptTimelineProvider } from './providers/timelineProvider';
import { PromptHoverProvider } from './providers/hoverProvider';

let sessionService: SessionService;
let blameProvider: BlameProvider;

export async function activate(context: vscode.ExtensionContext) {
  console.log('CLI Timeline: activating...');

  // Initialize services
  sessionService = new SessionService();

  // Session Explorer sidebar
  const sessionExplorer = new SessionExplorerProvider(sessionService);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('cliTimeline.sessions', sessionExplorer)
  );

  // Timeline Provider (integrates into VS Code Timeline panel)
  const timelineProvider = new PromptTimelineProvider(sessionService);
  context.subscriptions.push(
    vscode.timeline.registerTimelineProvider('file', timelineProvider)
  );

  // Blame Provider (inline annotations)
  blameProvider = new BlameProvider(sessionService);
  context.subscriptions.push(blameProvider);

  // Hover Provider (rich prompt info on hover)
  const hoverProvider = new PromptHoverProvider(sessionService);
  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ scheme: 'file' }, hoverProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cliTimeline.refreshSessions', () => loadWorkspaceSessions()),
    vscode.commands.registerCommand('cliTimeline.toggleBlame', () => blameProvider.toggle()),
    vscode.commands.registerCommand('cliTimeline.showPromptsForFile', (uri?: vscode.Uri) => {
      showPromptsForFile(uri);
    }),
    vscode.commands.registerCommand('cliTimeline.showPromptDiff', (prompt, filePath) => {
      showPromptDiff(prompt, filePath);
    }),
    vscode.commands.registerCommand('cliTimeline.comparePrompts', () => {
      // TODO: implement prompt comparison picker
      vscode.window.showInformationMessage('CLI Timeline: Compare prompts — coming soon!');
    }),
    vscode.commands.registerCommand('cliTimeline.revertToPrompt', () => {
      vscode.window.showInformationMessage('CLI Timeline: Revert to prompt — coming soon!');
    }),
    vscode.commands.registerCommand('cliTimeline.previousPrompt', () => {
      vscode.window.showInformationMessage('CLI Timeline: Previous prompt — coming soon!');
    }),
    vscode.commands.registerCommand('cliTimeline.nextPrompt', () => {
      vscode.window.showInformationMessage('CLI Timeline: Next prompt — coming soon!');
    }),
    vscode.commands.registerCommand('cliTimeline.revealPrompt', (_promptId: string) => {
      // TODO: reveal prompt in session explorer
    })
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

  const items = prompts.map((p, i) => ({
    label: `#${i + 1}: ${p.userMessage.substring(0, 60)}${p.userMessage.length > 60 ? '…' : ''}`,
    description: `${p.filesChanged.length} files • ${p.timestamp.toLocaleString()}`,
    detail: `${p.toolCalls.length} tool calls`,
    prompt: p,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: `${prompts.length} prompts changed this file`,
    matchOnDescription: true,
  });

  if (selected) {
    await showPromptDiff(selected.prompt, fileUri.fsPath);
  }
}

async function showPromptDiff(prompt: unknown, filePath: string): Promise<void> {
  // For now, just open the file — diff implementation comes in Phase 7
  const uri = vscode.Uri.file(filePath);
  await vscode.commands.executeCommand('vscode.open', uri);
}

function setupFileWatcher(): vscode.FileSystemWatcher | undefined {
  // Watch for changes to session state files for live updates
  try {
    const os = require('os');
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(require('path').join(os.homedir(), '.copilot', 'session-state')),
      '**/events.jsonl'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(() => {
      // Debounce: only reload if the last reload was > 5 seconds ago
      loadWorkspaceSessions();
    });
    watcher.onDidCreate(() => loadWorkspaceSessions());
    return watcher;
  } catch {
    return undefined;
  }
}

export function deactivate() {
  sessionService?.dispose();
}
