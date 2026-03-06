/**
 * Normalize a file path for cross-platform comparison.
 * Converts backslashes to forward slashes and lowercases the entire path.
 * This handles Windows drive-letter casing (C: vs c:) and separator mismatches.
 * On Linux/macOS this is effectively a no-op for separator style,
 * and the lowercase step correctly handles macOS's case-insensitive filesystem.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}
