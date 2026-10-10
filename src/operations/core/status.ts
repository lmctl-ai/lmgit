// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git status operation
 * @module services/git/providers/cli/operations/core/status
 */


import type {
  GitOperationContext,
  GitStatusOptions,
  GitStatusResult,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import {
  buildGitCommand,
  mapGitError,
  parseGitStatus,
} from '../../utils/index.js';

/**
 * Execute git status to show working tree status.
 */
export async function executeStatus(
  options: GitStatusOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitStatusResult> {
  try {
    const args = ['--porcelain=v2', '-b'];

    if (options.includeUntracked === false) {
      args.push('--untracked-files=no');
    }

    if (options.ignoreSubmodules) {
      args.push('--ignore-submodules');
    }

    const cmd = buildGitCommand({ command: 'status', args });
    const result = await execGit(
      cmd,
      context.workingDirectory);

    // The new parser handles all the logic.
    const statusResult = parseGitStatus(result.stdout);

    return statusResult;
  } catch (error) {
    throw mapGitError(error, 'status');
  }
}
