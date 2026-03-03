import * as vscode from 'vscode';
import { CLIAdapter } from '../adapters/adapter';
import { CopilotCLIAdapter } from '../adapters/copilotCLI';
import { Session, PromptEvent, FileChange, LineBlamEntry, SessionIndex, CLITool } from '../models/types';

export class SessionService {
  private adapters: CLIAdapter[] = [];
  private sessions: Session[] = [];
  private index: SessionIndex = {
    fileToPrompts: new Map(),
    promptToFiles: new Map(),
    fileLineBlame: new Map(),
  };
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor() {
    this.adapters.push(new CopilotCLIAdapter());
  }

  async loadSessions(workspacePath: string): Promise<void> {
    this.sessions = [];
    this.index = {
      fileToPrompts: new Map(),
      promptToFiles: new Map(),
      fileLineBlame: new Map(),
    };

    const config = vscode.workspace.getConfiguration('cliTimeline');

    for (const adapter of this.adapters) {
      let rootDir = adapter.getDefaultSessionDir();
      if (adapter.tool === 'copilot-cli') {
        const custom = config.get<string>('sessionPaths.copilotCLI');
        if (custom) { rootDir = custom; }
      }

      const sessionDirs = await adapter.listSessionDirs(rootDir);

      for (const dir of sessionDirs) {
        try {
          const matches = await adapter.sessionMatchesWorkspace(dir, workspacePath);
          if (!matches) { continue; }
          const session = await adapter.parseSession(dir);
          if (session && session.prompts.length > 0) {
            this.sessions.push(session);
          }
        } catch {
          // skip
        }
      }
    }

    this.sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    this.buildIndex();
    this._onDidChange.fire();
  }

  private buildIndex(): void {
    for (const session of this.sessions) {
      for (const prompt of session.prompts) {
        this.index.promptToFiles.set(prompt.id, prompt.filesChanged);
        for (const file of prompt.filesChanged) {
          const existing = this.index.fileToPrompts.get(file.path) || [];
          existing.push(prompt);
          this.index.fileToPrompts.set(file.path, existing);
        }
      }
    }
  }

  getSessions(): Session[] {
    return this.sessions;
  }

  getSessionById(id: string): Session | undefined {
    return this.sessions.find(s => s.id === id);
  }

  getPromptsForFile(filePath: string): PromptEvent[] {
    return this.index.fileToPrompts.get(filePath) || [];
  }

  getFilesForPrompt(promptId: string): FileChange[] {
    return this.index.promptToFiles.get(promptId) || [];
  }

  getLastPromptForFile(filePath: string): PromptEvent | undefined {
    const prompts = this.getPromptsForFile(filePath);
    if (prompts.length === 0) { return undefined; }
    return prompts[prompts.length - 1];
  }

  /** Find the prompt that last changed a line matching the given content */
  getPromptForLine(filePath: string, lineContent: string): PromptEvent | undefined {
    const prompts = this.getPromptsForFile(filePath);
    const trimmed = lineContent.trim();
    if (!trimmed) { return undefined; }
    for (let i = prompts.length - 1; i >= 0; i--) {
      const prompt = prompts[i];
      for (const change of prompt.filesChanged) {
        if (change.path !== filePath) { continue; }
        if (change.status === 'created' && change.fileText?.includes(trimmed)) {
          return prompt;
        }
        if (change.status === 'modified' && change.newStr?.includes(trimmed)) {
          return prompt;
        }
      }
    }
    return undefined;
  }

  async getSnapshotContent(prompt: PromptEvent, filePath: string): Promise<Buffer | null> {
    const session = this.getSessionById(prompt.sessionId);
    if (!session) { return null; }
    const adapter = this.adapters.find(a => a.tool === session.tool);
    if (!adapter) { return null; }
    const change = prompt.filesChanged.find(f => f.path === filePath);
    if (!change?.backupFile) { return null; }
    const rootDir = adapter.getDefaultSessionDir();
    const sessionDir = `${rootDir}/${session.id}`;
    return adapter.getSnapshotContent(sessionDir, change.backupFile);
  }

  getAllChangedFiles(): string[] {
    return Array.from(this.index.fileToPrompts.keys());
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
