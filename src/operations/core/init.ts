// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git init operation
 * @module services/git/providers/cli/operations/core/init
 */

import { mkdir } from 'node:fs/promises';


import type {
  GitInitOptions,
  GitInitResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git init to initialize a new repository.
 */
export async function executeInit(
  options: GitInitOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitInitResult> {
  try {
    const args: string[] = [];

    if (options.bare) {
      args.push('--bare');
    }

    // Default to 'main' if no initial branch is specified
    const initialBranch = options.initialBranch || 'main';
    args.push(`--initial-branch=${initialBranch}`);

    // Ensure the target directory exists before spawning git
    // (git init creates .git inside the dir, but posix_spawn fails if cwd doesn't exist)
    // Errors here (EPERM, EROFS) are non-fatal — git init will report a clear error.
    await mkdir(options.path, { recursive: true }).catch(() => {});

    const cmd = buildGitCommand({ command: 'init', args });
    await execGit(cmd, options.path);

    const result = {
      success: true,
      path: options.path,
      initialBranch,
      bare: options.bare || false,
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'init');
  }
}
