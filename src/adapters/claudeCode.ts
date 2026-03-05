import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { CLIAdapter } from './adapter';
import { CLITool, Session, PromptEvent, FileChange, ToolCall } from '../models/types';

interface ClaudeMessage {
  id?: string;
  uuid?: string;
  type?: string;
  role?: string;
  content: unknown;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  summary?: string;
}

export class ClaudeCodeAdapter implements CLIAdapter {
  tool: CLITool = 'claude-code';

  getDefaultSessionDir(): string {
    return path.join(os.homedir(), '.claude', 'projects');
  }

  /**
   * Claude Code stores each session as a .jsonl file inside a per-project subdirectory.
   * We treat each .jsonl file path as a "session dir" (reusing the interface string).
   */
  async listSessionDirs(rootDir: string): Promise<string[]> {
    const sessionFiles: string[] = [];
    try {
      const projectDirs = await fs.promises.readdir(rootDir, { withFileTypes: true });
      for (const dir of projectDirs) {
        if (!dir.isDirectory()) { continue; }
        const projectPath = path.join(rootDir, dir.name);
        try {
          const files = await fs.promises.readdir(projectPath);
          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              sessionFiles.push(path.join(projectPath, file));
            }
          }
        } catch { /* skip unreadable dirs */ }
      }
    } catch { /* projects dir may not exist */ }
    return sessionFiles;
  }

  async sessionMatchesWorkspace(sessionFile: string, workspacePath: string): Promise<boolean> {
    const cwd = await this.readSessionCwd(sessionFile);
    if (!cwd) { return false; }
    const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, '');
    const normalizedCwd = cwd.replace(/[\\/]+$/, '');
    return normalizedCwd === normalizedWorkspace ||
           normalizedCwd.startsWith(normalizedWorkspace + path.sep);
  }

  async parseSession(sessionFile: string): Promise<Session | null> {
    const lines = await this.readJsonlLines(sessionFile);
    if (lines.length === 0) { return null; }

    // The first line with a cwd field is the session root
    const meta = lines.find(l => l.cwd);
    const sessionId = meta?.sessionId || path.basename(sessionFile, '.jsonl');
    const cwd = meta?.cwd || '';
    const summary = meta?.summary;

    const timestamps = lines
      .filter(l => l.timestamp)
      .map(l => new Date(l.timestamp!).getTime())
      .filter(t => !isNaN(t));

    const createdAt = timestamps.length > 0 ? new Date(Math.min(...timestamps)) : new Date();
    const updatedAt = timestamps.length > 0 ? new Date(Math.max(...timestamps)) : createdAt;

    const prompts = this.parsePrompts(lines, sessionId, cwd);
    return {
      id: sessionId,
      tool: this.tool,
      cwd,
      summary,
      sessionDir: sessionFile, // file path reused as sessionDir for interface compat
      createdAt,
      updatedAt,
      prompts,
    };
  }

  /** Claude Code does not save pre-prompt backup files. */
  async getSnapshotContent(_sessionDir: string, _backupFile: string): Promise<Buffer | null> {
    return null;
  }

  private async readSessionCwd(sessionFile: string): Promise<string | null> {
    try {
      const content = await fs.promises.readFile(sessionFile, 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) { continue; }
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) { return obj.cwd as string; }
        } catch { /* skip malformed lines */ }
      }
    } catch { /* file unreadable */ }
    return null;
  }

  private async readJsonlLines(sessionFile: string): Promise<ClaudeMessage[]> {
    const lines: ClaudeMessage[] = [];
    try {
      const stream = fs.createReadStream(sessionFile, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) { continue; }
        try { lines.push(JSON.parse(line)); } catch { /* skip */ }
      }
    } catch { /* file may not exist */ }
    return lines;
  }

  private parsePrompts(lines: ClaudeMessage[], sessionId: string, cwd: string): PromptEvent[] {
    const prompts: PromptEvent[] = [];

    // User messages are the prompt boundaries
    const userLines = lines.filter(l => l.role === 'user' || l.type === 'user');

    for (let i = 0; i < userLines.length; i++) {
      const userLine = userLines[i];
      const nextUserLine = userLines[i + 1];

      const messageText = this.extractText(userLine.content);
      if (!messageText) { continue; }

      // Collect assistant messages (with tool uses) between this and the next user message
      const userTime = userLine.timestamp ? new Date(userLine.timestamp).getTime() : 0;
      const nextTime = nextUserLine?.timestamp ? new Date(nextUserLine.timestamp).getTime() : Infinity;

      const assistantLines = lines.filter(l => {
        if (l.role !== 'assistant' && l.type !== 'assistant') { return false; }
        const t = l.timestamp ? new Date(l.timestamp).getTime() : 0;
        return t >= userTime && t < nextTime;
      });

      const fileChanges: FileChange[] = [];
      const toolCalls: ToolCall[] = [];
      const seenFileEdits = new Set<string>(); // deduplicate: tool-id level

      for (const asst of assistantLines) {
        const blocks = Array.isArray(asst.content) ? asst.content as Record<string, unknown>[] : [];
        for (const block of blocks) {
          if (block['type'] !== 'tool_use') { continue; }

          const blockId = block['id'] as string || '';
          const toolName = block['name'] as string || '';
          const input = (block['input'] || {}) as Record<string, unknown>;

          toolCalls.push({
            id: blockId || `${sessionId}-${i}-${toolCalls.length}`,
            toolName,
            arguments: input,
            timestamp: new Date(asst.timestamp || userLine.timestamp || Date.now()),
          });

          // Extract file changes — expand MultiEdit into individual changes
          const changes = this.extractFileChanges(toolName, input, cwd);
          for (const change of changes) {
            const dedupeKey = `${blockId}:${change.path}:${change.oldStr ?? ''}`;
            if (seenFileEdits.has(dedupeKey)) { continue; }
            seenFileEdits.add(dedupeKey);
            fileChanges.push(change);
          }
        }
      }

      prompts.push({
        id: userLine.id || userLine.uuid || `${sessionId}-${i}`,
        sessionId,
        tool: this.tool,
        timestamp: new Date(userLine.timestamp || Date.now()),
        userMessage: messageText.substring(0, 500),
        filesChanged: fileChanges,
        toolCalls,
      });
    }

    return prompts.filter(p => p.userMessage.length > 0);
  }

  private extractText(content: unknown): string {
    if (typeof content === 'string') { return content.trim(); }
    if (Array.isArray(content)) {
      return (content as Record<string, unknown>[])
        .filter(b => b['type'] === 'text')
        .map(b => String(b['text'] || ''))
        .join(' ')
        .trim();
    }
    return '';
  }

  /**
   * Maps Claude Code tool names to FileChange entries.
   * - Write  → creates/overwrites a file (status: created)
   * - Edit   → single string replacement (status: modified)
   * - MultiEdit → multiple replacements; expanded into one change per edit
   */
  private extractFileChanges(
    toolName: string,
    input: Record<string, unknown>,
    cwd: string
  ): FileChange[] {
    const rawPath = (input['file_path'] || input['path'] || '') as string;
    if (!rawPath) { return []; }

    // Resolve relative paths against session cwd
    const filePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);

    if (toolName === 'Write') {
      return [{ path: filePath, status: 'created', fileText: input['content'] as string }];
    }

    if (toolName === 'Edit') {
      return [{
        path: filePath,
        status: 'modified',
        oldStr: input['old_string'] as string,
        newStr: input['new_string'] as string,
      }];
    }

    if (toolName === 'MultiEdit') {
      const edits = (input['edits'] || []) as Record<string, unknown>[];
      return edits.map(edit => ({
        path: filePath,
        status: 'modified' as const,
        oldStr: edit['old_string'] as string,
        newStr: edit['new_string'] as string,
      }));
    }

    return [];
  }
}
