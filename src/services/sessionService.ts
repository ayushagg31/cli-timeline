import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CLIAdapter } from '../adapters/adapter';
import { CopilotCLIAdapter } from '../adapters/copilotCLI';
import { ClaudeCodeAdapter } from '../adapters/claudeCode';
import { Session, PromptEvent, FileChange, LineBlamEntry, SessionIndex, CLITool } from '../models/types';
import { normalizePath } from '../utils/pathUtils';

export class SessionService {
  private adapters: CLIAdapter[] = [];
  private sessions: Session[] = [];
  private index: SessionIndex = {
    fileToPrompts: new Map(),
    promptToFiles: new Map(),
    fileLineBlame: new Map(),
  };
  private _isLoading = false;
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private outputChannel: vscode.OutputChannel;

  constructor() {
    this.adapters.push(new CopilotCLIAdapter());
    this.adapters.push(new ClaudeCodeAdapter());
    this.outputChannel = vscode.window.createOutputChannel('CLI Timeline');
  }

  async loadSessions(workspacePath: string): Promise<void> {
    if (this._isLoading) { return; }
    this._isLoading = true;

    try {
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
      if (adapter.tool === 'claude-code') {
        const custom = config.get<string>('sessionPaths.claudeCode');
        if (custom) { rootDir = custom; }
      }

      const sessionDirs = await adapter.listSessionDirs(rootDir);
      this.outputChannel.appendLine(`[${adapter.tool}] Found ${sessionDirs.length} session(s) in ${rootDir}`);

      for (const dir of sessionDirs) {
        try {
          const matches = await adapter.sessionMatchesWorkspace(dir, workspacePath);
          this.outputChannel.appendLine(`  ${path.basename(dir)}: workspace match = ${matches}`);
          if (!matches) { continue; }
          const session = await adapter.parseSession(dir);
          if (session && session.prompts.length > 0) {
            this.sessions.push(session);
            this.outputChannel.appendLine(`    → loaded ${session.prompts.length} prompt(s)`);
          }
        } catch {
          // skip
        }
      }
    }

    this.sessions.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Load shared sessions committed to the repo
    await this.loadSharedSessions(workspacePath);

    this.buildIndex();
    this._onDidChange.fire();
    } finally {
      this._isLoading = false;
    }
  }

  private buildIndex(): void {
    for (const session of this.sessions) {
      for (const prompt of session.prompts) {
        this.index.promptToFiles.set(prompt.id, prompt.filesChanged);
        for (const file of prompt.filesChanged) {
          const key = normalizePath(file.path);
          const existing = this.index.fileToPrompts.get(key) || [];
          existing.push(prompt);
          this.index.fileToPrompts.set(key, existing);
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
    return this.index.fileToPrompts.get(normalizePath(filePath)) || [];
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
    const normalizedFilePath = normalizePath(filePath);
    for (let i = prompts.length - 1; i >= 0; i--) {
      const prompt = prompts[i];
      for (const change of prompt.filesChanged) {
        if (normalizePath(change.path) !== normalizedFilePath) { continue; }
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
    const normalizedFilePath = normalizePath(filePath);
    const change = prompt.filesChanged.find(f => normalizePath(f.path) === normalizedFilePath);

    // Try backup file first
    if (change?.backupFile) {
      const content = await adapter.getSnapshotContent(session.sessionDir, change.backupFile);
      if (content) { return content; }
    }

    return null;
  }

  getAllChangedFiles(): string[] {
    return Array.from(this.index.fileToPrompts.keys());
  }

  /**
   * Commit a session to the repo's .cli-sessions/ folder so other users can view it.
   * Copies session data with paths preserved, writes metadata, and git commits.
   */
  async commitSessionToRepo(session: Session, workspacePath: string): Promise<void> {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileAsync = promisify(execFile);

    // Create a readable folder name from summary or session ID
    const folderName = session.summary
      ? session.summary.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '').substring(0, 40)
      : session.id.substring(0, 8);
    const exportDir = path.join(workspacePath, '.cli-sessions', folderName);

    // Don't overwrite an existing export
    try {
      await fs.promises.access(exportDir);
      throw new Error(`Session already committed at .cli-sessions/${folderName}`);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.startsWith('Session already')) { throw e; }
    }

    await fs.promises.mkdir(exportDir, { recursive: true });

    // Get git author
    let author = 'unknown';
    try {
      const { stdout } = await execFileAsync('git', ['config', 'user.name'], { cwd: workspacePath });
      author = stdout.trim();
    } catch { /* use default */ }

    // Collect changed file paths
    const allFiles = new Set<string>();
    for (const p of session.prompts) {
      for (const f of p.filesChanged) { allFiles.add(f.path); }
    }

    // Write session.json metadata
    const meta = {
      id: session.id,
      tool: session.tool,
      summary: session.summary || `Session ${session.id.substring(0, 8)}`,
      author,
      branch: session.branch,
      repository: session.repository,
      exportedAt: new Date().toISOString(),
      originalCwd: session.cwd,
      promptCount: session.prompts.length,
      fileCount: allFiles.size,
    };
    await fs.promises.writeFile(
      path.join(exportDir, 'session.json'),
      JSON.stringify(meta, null, 2)
    );

    // Copy events.jsonl
    try {
      await fs.promises.copyFile(
        path.join(session.sessionDir, 'events.jsonl'),
        path.join(exportDir, 'events.jsonl')
      );
    } catch { /* Claude Code sessions may not have this */ }

    // Copy workspace.yaml
    try {
      await fs.promises.copyFile(
        path.join(session.sessionDir, 'workspace.yaml'),
        path.join(exportDir, 'workspace.yaml')
      );
    } catch { /* optional */ }

    // Copy rewind-snapshots (backup files for diffs/revert)
    const srcSnapshots = path.join(session.sessionDir, 'rewind-snapshots');
    try {
      await this.copyDirRecursive(srcSnapshots, path.join(exportDir, 'rewind-snapshots'));
    } catch { /* snapshots may not exist */ }

    // git add and commit — clean up copied files if git fails
    try {
      await execFileAsync('git', ['add', exportDir], { cwd: workspacePath });
      const commitMsg = `chore: add CLI session "${meta.summary}"\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`;
      await execFileAsync('git', ['commit', '-m', commitMsg], { cwd: workspacePath });
    } catch (gitError) {
      await fs.promises.rm(exportDir, { recursive: true, force: true }).catch(() => {});
      throw gitError;
    }
  }

  /** Load shared sessions from .cli-sessions/ in the workspace */
  private async loadSharedSessions(workspacePath: string): Promise<void> {
    const sharedDir = path.join(workspacePath, '.cli-sessions');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(sharedDir, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory()) { continue; }
      const sessionDir = path.join(sharedDir, entry.name);

      try {
        // Read session.json for metadata
        const metaContent = await fs.promises.readFile(
          path.join(sessionDir, 'session.json'), 'utf-8'
        );
        const meta = JSON.parse(metaContent);

        // Skip if this session is already loaded from local state
        if (this.sessions.some(s => s.id === meta.id)) { continue; }

        // Use the appropriate adapter to parse
        const adapter = this.adapters.find(a => a.tool === (meta.tool as CLITool));
        if (!adapter) { continue; }

        const session = await adapter.parseSession(sessionDir);
        if (!session || session.prompts.length === 0) { continue; }

        // Remap paths from original workspace to current workspace
        if (meta.originalCwd && meta.originalCwd !== workspacePath) {
          this.remapSessionPaths(session, meta.originalCwd, workspacePath);
        }

        session.shared = true;
        session.author = meta.author;
        session.summary = meta.summary || session.summary;

        this.sessions.push(session);
      } catch {
        // skip unparseable shared sessions
      }
    }
  }

  /** Remap absolute file paths from one workspace root to another */
  private remapSessionPaths(session: Session, fromPrefix: string, toPrefix: string): void {
    const normalizedFrom = normalizePath(fromPrefix.replace(/[\\/]+$/, ''));
    const remap = (p: string) => {
      if (normalizePath(p).startsWith(normalizedFrom)) {
        return toPrefix + p.substring(normalizedFrom.length);
      }
      if (!path.isAbsolute(p)) {
        return path.join(toPrefix, p);
      }
      return p;
    };

    for (const prompt of session.prompts) {
      for (const change of prompt.filesChanged) {
        change.path = remap(change.path);
      }
    }
    session.cwd = toPrefix;
    if (session.gitRoot) { session.gitRoot = remap(session.gitRoot); }
  }

  /** Recursively copy a directory */
  private async copyDirRecursive(src: string, dst: string): Promise<void> {
    await fs.promises.mkdir(dst, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const dstPath = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        await this.copyDirRecursive(srcPath, dstPath);
      } else {
        await fs.promises.copyFile(srcPath, dstPath);
      }
    }
  }

  dispose(): void {
    this._onDidChange.dispose();
    this.outputChannel.dispose();
  }
}
