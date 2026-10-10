// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git clean operation
 * @module services/git/providers/cli/operations/core/clean
 */


import type {
  GitCleanOptions,
  GitCleanResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git clean to remove untracked files.
 */
export async function executeClean(
  options: GitCleanOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitCleanResult> {
  try {
    const args: string[] = [];

    if (options.dryRun) {
      args.push('-n');
    } else if (options.force) {
      args.push('-f');
    }

    if (options.directories) {
      args.push('-d');
    }

    if (options.ignored) {
      args.push('-x');
    }

    const cmd = buildGitCommand({ command: 'clean', args });
    const result = await execGit(
      cmd,
      context.workingDirectory);

    // Parse output to get removed items
    const files: string[] = [];
    const directories: string[] = [];

    const lines = result.stdout.split('\n');
    for (const line of lines) {
      if (line.startsWith('Removing') || line.startsWith('Would remove')) {
        const item = line.replace(/^(Removing|Would remove)\s+/, '');
        if (item.endsWith('/')) {
          directories.push(item);
        } else {
          files.push(item);
        }
      }
    }

    const cleanResult = {
      success: true,
      filesRemoved: files,
      directoriesRemoved: directories,
      dryRun: options.dryRun || false,
    };

    return cleanResult;
  } catch (error) {
    throw mapGitError(error, 'clean');
  }
}
