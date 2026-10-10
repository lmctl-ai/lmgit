// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git add operation
 * @module services/git/providers/cli/operations/staging/add
 */


import type {
  GitAddOptions,
  GitAddResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git add to stage changes.
 */
export async function executeAdd(
  options: GitAddOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitAddResult> {
  try {
    const args: string[] = [];

    if (options.all) {
      args.push('--all');
    } else if (options.update) {
      args.push('--update');
    } else if (options.paths.length > 0) {
      args.push(...options.paths);
    }

    if (options.force) {
      args.push('--force');
    }

    const cmd = buildGitCommand({ command: 'add', args });
    await execGit(cmd, context.workingDirectory);

    // When --all or --update is used, we don't know the actual files staged.
    // Only report paths when explicit paths were provided.
    const stagedFiles = options.all || options.update ? [] : options.paths;

    const result = {
      success: true,
      stagedFiles,
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'add');
  }
}
