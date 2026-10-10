// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git blame operation
 * @module services/git/providers/cli/operations/history/blame
 */


import type {
  GitBlameOptions,
  GitBlameResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git blame to show line-by-line authorship.
 *
 * @param options - Blame options
 * @param context - Operation context
 * @param execGit - Function to execute git commands
 * @returns Blame result
 */
export async function executeBlame(
  options: GitBlameOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitBlameResult> {
  try {
    const args: string[] = ['--porcelain'];

    if (options.ignoreWhitespace) {
      args.push('-w');
    }

    if (options.startLine && options.endLine) {
      args.push(`-L${options.startLine},${options.endLine}`);
    } else if (options.startLine) {
      args.push(`-L${options.startLine},`);
    }

    args.push('--', options.file);

    const cmd = buildGitCommand({ command: 'blame', args });
    const gitOutput = await execGit(
      cmd,
      context.workingDirectory);

    // Parse porcelain format
    const lines = gitOutput.stdout.split('\n');
    const blameLines: GitBlameResult['lines'] = [];
    let currentCommit: Partial<(typeof blameLines)[0]> = {};

    for (const line of lines) {
      if (!line) continue;

      // Commit hash line: <hash> <orig-line> <final-line> [<group-lines>]
      if (line.match(/^[0-9a-f]{40}/)) {
        const parts = line.split(' ');
        currentCommit = {
          commitHash: parts[0]!,
          lineNumber: parseInt(parts[2]!, 10),
        };
      }
      // Author line
      else if (line.startsWith('author ')) {
        currentCommit.author = line.substring(7);
      }
      // Timestamp line
      else if (line.startsWith('author-time ')) {
        currentCommit.timestamp = parseInt(line.substring(12), 10);
      }
      // Content line (starts with tab)
      else if (line.startsWith('\t')) {
        currentCommit.content = line.substring(1);

        if (
          currentCommit.commitHash &&
          currentCommit.author &&
          currentCommit.timestamp !== undefined &&
          currentCommit.lineNumber !== undefined
        ) {
          blameLines.push(currentCommit as Required<(typeof blameLines)[0]>);
          currentCommit = {};
        }
      }
    }

    const result = {
      success: true,
      file: options.file,
      lines: blameLines,
      totalLines: blameLines.length,
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'blame');
  }
}
