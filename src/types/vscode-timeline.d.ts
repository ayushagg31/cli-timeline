// VS Code Timeline API type augmentation (stable since VS Code 1.44)
import * as vscode from 'vscode';

declare module 'vscode' {
  export class TimelineItem {
    label: string;
    id?: string;
    timestamp: number;
    description?: string;
    detail?: string;
    tooltip?: string | vscode.MarkdownString;
    command?: vscode.Command;
    iconPath?: vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } | vscode.ThemeIcon;
    contextValue?: string;
    constructor(label: string, timestamp: number);
  }

  export interface TimelineOptions {
    cursor?: string;
    limit?: number | { timestamp: number; id?: string };
  }

  export interface Timeline {
    readonly paging?: { readonly cursor: string | undefined };
    readonly items: readonly TimelineItem[];
  }

  export interface TimelineChangeEvent {
    uri: vscode.Uri | undefined;
    reset?: boolean;
  }

  export interface TimelineProvider {
    id: string;
    label: string;
    onDidChange?: vscode.Event<TimelineChangeEvent>;
    provideTimeline(
      uri: vscode.Uri,
      options: TimelineOptions,
      token: vscode.CancellationToken
    ): vscode.ProviderResult<Timeline>;
  }

  export namespace timeline {
    export function registerTimelineProvider(
      scheme: string | string[],
      provider: TimelineProvider
    ): vscode.Disposable;
  }
}
