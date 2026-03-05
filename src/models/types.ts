/** Supported CLI tool types */
export type CLITool = 'copilot-cli' | 'claude-code' | 'cline';

export interface CLIToolInfo {
  name: string;
  icon: string;     // codicon name
  color: string;    // hex color for gutter/blame
  tool: CLITool;
}

export const CLI_TOOLS: Record<CLITool, CLIToolInfo> = {
  'copilot-cli': { name: 'Copilot CLI', icon: 'copilot', color: '#0969DA', tool: 'copilot-cli' },
  'claude-code': { name: 'Claude Code', icon: 'sparkle', color: '#D97706', tool: 'claude-code' },
  'cline': { name: 'Cline', icon: 'robot', color: '#16A34A', tool: 'cline' },
};

/** A parsed session */
export interface Session {
  id: string;
  tool: CLITool;
  cwd: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
  summary?: string;
  /** Absolute path to the session directory on disk */
  sessionDir: string;
  createdAt: Date;
  updatedAt: Date;
  prompts: PromptEvent[];
  /** True if this session was committed to the repo by another user */
  shared?: boolean;
  /** Git author who committed the shared session */
  author?: string;
}

/** A single user prompt and its effects */
export interface PromptEvent {
  id: string;
  sessionId: string;
  tool: CLITool;
  timestamp: Date;
  userMessage: string;
  filesChanged: FileChange[];
  toolCalls: ToolCall[];
  snapshotId?: string;
}

/** A file change caused by a prompt */
export interface FileChange {
  path: string;
  status: 'created' | 'modified' | 'deleted';
  /** For edits: the old content that was replaced */
  oldStr?: string;
  /** For edits: the new content that replaced it */
  newStr?: string;
  /** For creates: full file content */
  fileText?: string;
  /** Path to backup file in rewind-snapshots */
  backupFile?: string;
  /** Git-style status code */
  gitStatus?: string;
  contentHash?: string;
}

/** A tool call made by the AI during a prompt */
export interface ToolCall {
  id: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  result?: string;
  timestamp: Date;
}

/** Line-level blame entry */
export interface LineBlamEntry {
  /** 1-indexed line number */
  line: number;
  prompt: PromptEvent;
  /** The change type for this line */
  changeType: 'added' | 'modified';
}

/** Index mapping file paths to prompt events */
export interface SessionIndex {
  /** file path → prompts that changed it */
  fileToPrompts: Map<string, PromptEvent[]>;
  /** prompt id → file changes */
  promptToFiles: Map<string, FileChange[]>;
  /** file path → line-level blame */
  fileLineBlame: Map<string, LineBlamEntry[]>;
}
