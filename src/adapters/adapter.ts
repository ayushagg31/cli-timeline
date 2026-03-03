import { CLITool, Session, PromptEvent, FileChange, ToolCall } from '../models/types';

/** Interface that all CLI tool adapters must implement */
export interface CLIAdapter {
  tool: CLITool;
  /** Get the default session storage directory */
  getDefaultSessionDir(): string;
  /** List all session directories */
  listSessionDirs(rootDir: string): Promise<string[]>;
  /** Check if a session belongs to a given workspace */
  sessionMatchesWorkspace(sessionDir: string, workspacePath: string): Promise<boolean>;
  /** Parse a session directory into a Session object */
  parseSession(sessionDir: string): Promise<Session | null>;
  /** Get file content from a snapshot backup */
  getSnapshotContent(sessionDir: string, backupFile: string): Promise<Buffer | null>;
}
