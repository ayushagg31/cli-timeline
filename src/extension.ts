import * as vscode from 'vscode';
import { SessionService } from './services/sessionService';
import { SessionExplorerProvider } from './views/sessionExplorer';
import { BlameProvider } from './providers/blameProvider';
import { PromptTimelineProvider } from './providers/timelineProvider';
import { PromptHoverProvider } from './providers/hoverProvider';
import {
  SnapshotContentProvider,
  showPromptDiffCommand,
  previousPromptCommand,
  revertToPromptCommand,
} from './providers/snapshotProvider';

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

  // Snapshot Content Provider (virtual documents for diffs)
  const snapshotProvider = new SnapshotContentProvider(sessionService);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(SnapshotContentProvider.scheme, snapshotProvider)
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('cliTimeline.refreshSessions', () => loadWorkspaceSessions()),
    vscode.commands.registerCommand('cliTimeline.toggleBlame', () => blameProvider.toggle()),
    vscode.commands.registerCommand('cliTimeline.showPromptsForFile', (uri?: vscode.Uri) => {
      showPromptsForFile(uri);
    }),
    vscode.commands.registerCommand('cliTimeline.showPromptDiff', (prompt, filePath) => {
      showPromptDiffCommand(sessionService, prompt, filePath);
    }),
    vscode.commands.registerCommand('cliTimeline.comparePrompts', () => {
      previousPromptCommand(sessionService);
    }),
    vscode.commands.registerCommand('cliTimeline.revertToPrompt', () => {
      revertToPromptCommand(sessionService);
    }),
    vscode.commands.registerCommand('cliTimeline.previousPrompt', () => {
      previousPromptCommand(sessionService);
    }),
    vscode.commands.registerCommand('cliTimeline.nextPrompt', () => {
      previousPromptCommand(sessionService);
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
