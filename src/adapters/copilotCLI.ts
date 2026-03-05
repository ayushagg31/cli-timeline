import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { CLIAdapter } from './adapter';
import { CLITool, Session, PromptEvent, FileChange, ToolCall } from '../models/types';

interface WorkspaceYaml {
  id: string;
  cwd?: string;
  git_root?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  created_at?: string;
  updated_at?: string;
}

interface RewindSnapshot {
  snapshotId: string;
  eventId: string;
  userMessage: string;
  timestamp: string;
  fileCount: number;
  gitCommit?: string;
  gitBranch?: string;
  backupHashes?: string[];
  files: Record<string, {
    gitStatus: string;
    contentHash: string;
    backupFile: string;
    size: number;
    mtime: string;
    mode: number;
  }>;
}

interface RewindIndex {
  version: number;
  snapshots: RewindSnapshot[];
  filePathMap?: Record<string, string>;
}

interface EventData {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

export class CopilotCLIAdapter implements CLIAdapter {
  tool: CLITool = 'copilot-cli';

  getDefaultSessionDir(): string {
    return path.join(os.homedir(), '.copilot', 'session-state');
  }

  async listSessionDirs(rootDir: string): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => path.join(rootDir, e.name));
    } catch {
      return [];
    }
  }

  async sessionMatchesWorkspace(sessionDir: string, workspacePath: string): Promise<boolean> {
    const meta = await this.parseWorkspaceYaml(sessionDir);
    if (!meta) { return false; }

    const normalizedWorkspace = workspacePath.replace(/[\\/]+$/, '');

    // Prefer git_root for matching (most accurate)
    if (meta.git_root) {
      const gitRoot = meta.git_root.replace(/[\\/]+$/, '');
      return gitRoot === normalizedWorkspace ||
             normalizedWorkspace.startsWith(gitRoot + path.sep);
    }

    // Fallback to cwd — must be exact or cwd inside workspace
    if (meta.cwd) {
      const cwd = meta.cwd.replace(/[\\/]+$/, '');
      return cwd === normalizedWorkspace ||
             cwd.startsWith(normalizedWorkspace + path.sep);
    }

    return false;
  }

  async parseSession(sessionDir: string): Promise<Session | null> {
    const meta = await this.parseWorkspaceYaml(sessionDir);
    if (!meta) { return null; }

    const prompts = await this.parsePrompts(sessionDir, meta.id);
    return {
      id: meta.id,
      tool: this.tool,
      cwd: meta.cwd || sessionDir,
      gitRoot: meta.git_root,
      repository: meta.repository,
      branch: meta.branch,
      summary: meta.summary,
      sessionDir,
      createdAt: new Date(meta.created_at || Date.now()),
      updatedAt: new Date(meta.updated_at || Date.now()),
      prompts,
    };
  }

  async getSnapshotContent(sessionDir: string, backupFile: string): Promise<Buffer | null> {
    const backupsDir = path.resolve(sessionDir, 'rewind-snapshots', 'backups');
    const backupPath = path.resolve(backupsDir, backupFile);
    // Prevent path traversal — resolved path must stay inside the backups directory
    if (!backupPath.startsWith(backupsDir + path.sep)) {
      return null;
    }
    try {
      return await fs.promises.readFile(backupPath);
    } catch {
      return null;
    }
  }

  private async parseWorkspaceYaml(sessionDir: string): Promise<WorkspaceYaml | null> {
    const yamlPath = path.join(sessionDir, 'workspace.yaml');
    try {
      const content = await fs.promises.readFile(yamlPath, 'utf-8');
      return this.simpleYamlParse(content);
    } catch {
      return null;
    }
  }

  /** Simple YAML parser for the flat key:value workspace.yaml format */
  private simpleYamlParse(content: string): WorkspaceYaml {
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) { continue; }
      const key = line.substring(0, colonIdx).trim();
      const value = line.substring(colonIdx + 1).trim();
      if (key && value) { result[key] = value; }
    }
    return result as unknown as WorkspaceYaml;
  }

  /** Parse events.jsonl + rewind-snapshots to build prompt events */
  private async parsePrompts(sessionDir: string, sessionId: string): Promise<PromptEvent[]> {
    // First try rewind-snapshots for file-level data
    const { snapshots, filePathMap } = await this.parseRewindSnapshots(sessionDir);

    // Build reverse map: filePath → hash
    const pathToHash = new Map<string, string>();
    for (const [hash, filePath] of Object.entries(filePathMap)) {
      pathToHash.set(filePath, hash);
    }

    // Then parse events.jsonl for tool calls and line-level data
    const events = await this.parseEventsJsonl(sessionDir);

    // Merge: use snapshots for prompt boundaries, events for detail
    const prompts: PromptEvent[] = [];
    const snapshotsByEventId = new Map(snapshots.map(s => [s.eventId, s]));

    // Find all user.message events
    const userMessages = events.filter(e => e.type === 'user.message');
    const toolEvents = events.filter(e =>
      e.type === 'tool.execution_start' || e.type === 'tool.execution_complete'
    );

    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i];
      const nextMsg = userMessages[i + 1];
      const msgContent = (msg.data as Record<string, unknown>).content as string ||
                         (msg.data as Record<string, unknown>).transformedContent as string || '';

      // Clean up plan mode prefixes
      const cleanMessage = msgContent
        .replace(/^<current_datetime>.*?<\/current_datetime>\s*/s, '')
        .replace(/^\[\[PLAN\]\].*?My request:\s*/s, '')
        .trim();

      // Get tool calls between this message and the next
      const promptToolCalls = toolEvents.filter(te => {
        const teTime = new Date(te.timestamp).getTime();
        const msgTime = new Date(msg.timestamp).getTime();
        const nextTime = nextMsg ? new Date(nextMsg.timestamp).getTime() : Infinity;
        return teTime >= msgTime && teTime < nextTime && te.type === 'tool.execution_start';
      });

      // Extract file changes from tool calls
      const fileChanges = this.extractFileChanges(promptToolCalls, sessionDir);
      const toolCalls = this.extractToolCalls(promptToolCalls);

      // Merge snapshot backup data into file changes using filePathMap
      const snapshot = snapshotsByEventId.get(msg.id);
      if (snapshot) {
        for (const change of fileChanges) {
          const hash = pathToHash.get(change.path);
          const snapshotFile = hash ? snapshot.files[hash] : undefined;
          if (snapshotFile) {
            change.backupFile = snapshotFile.backupFile;
            change.gitStatus = snapshotFile.gitStatus;
            change.contentHash = snapshotFile.contentHash;
          }
        }
      }

      const prompt: PromptEvent = {
        id: msg.id,
        sessionId,
        tool: this.tool,
        timestamp: new Date(msg.timestamp),
        userMessage: cleanMessage.substring(0, 500), // truncate for display
        filesChanged: fileChanges,
        toolCalls,
        snapshotId: snapshot?.snapshotId,
      };

      // Only include prompts that have content
      if (prompt.userMessage.length > 0) {
        prompts.push(prompt);
      }
    }

    return prompts;
  }

  private async parseRewindSnapshots(sessionDir: string): Promise<{ snapshots: RewindSnapshot[]; filePathMap: Record<string, string> }> {
    const indexPath = path.join(sessionDir, 'rewind-snapshots', 'index.json');
    try {
      const content = await fs.promises.readFile(indexPath, 'utf-8');
      const index: RewindIndex = JSON.parse(content);
      return {
        snapshots: index.snapshots || [],
        filePathMap: index.filePathMap || {},
      };
    } catch {
      return { snapshots: [], filePathMap: {} };
    }
  }

  private async parseEventsJsonl(sessionDir: string): Promise<EventData[]> {
    const eventsPath = path.join(sessionDir, 'events.jsonl');
    const events: EventData[] = [];

    try {
      const fileStream = fs.createReadStream(eventsPath, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) { continue; }
        try {
          events.push(JSON.parse(line));
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // events.jsonl may not exist for very new sessions
    }

    return events;
  }

  /** Extract file changes from tool.execution_start events */
  private extractFileChanges(toolEvents: EventData[], sessionDir: string): FileChange[] {
    const changes: FileChange[] = [];
    const seen = new Set<string>();

    for (const event of toolEvents) {
      const data = event.data;
      const toolName = data.toolName as string;
      const args = (data.arguments || {}) as Record<string, string>;

      if (toolName === 'edit' && args.path) {
        const filePath = args.path;
        // Skip session internal files
        if (filePath.includes(`session-state${path.sep}`) || filePath.includes(`session-state/`) ||
            filePath.includes(`.copilot${path.sep}`) || filePath.includes(`.copilot/`)) { continue; }

        const key = `edit:${filePath}:${event.id}`;
        if (seen.has(key)) { continue; }
        seen.add(key);

        changes.push({
          path: filePath,
          status: 'modified',
          oldStr: args.old_str,
          newStr: args.new_str,
        });
      } else if (toolName === 'create' && args.path) {
        const filePath = args.path;
        if (filePath.includes(`session-state${path.sep}`) || filePath.includes(`session-state/`) ||
            filePath.includes(`.copilot${path.sep}`) || filePath.includes(`.copilot/`)) { continue; }

        const key = `create:${filePath}`;
        if (seen.has(key)) { continue; }
        seen.add(key);

        changes.push({
          path: filePath,
          status: 'created',
          fileText: args.file_text,
        });
      }
    }

    return changes;
  }

  /** Extract tool call summaries */
  private extractToolCalls(toolEvents: EventData[]): ToolCall[] {
    return toolEvents.map(event => {
      const data = event.data;
      return {
        id: data.toolCallId as string || event.id,
        toolName: data.toolName as string || 'unknown',
        arguments: data.arguments as Record<string, unknown> | undefined,
        timestamp: new Date(event.timestamp),
      };
    });
  }
}
