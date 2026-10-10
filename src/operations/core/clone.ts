// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git clone operation
 * @module services/git/providers/cli/operations/core/clone
 */

import { dirname, resolve } from 'node:path';


import type {
  GitCloneOptions,
  GitCloneResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git clone to clone a repository.
 */
export async function executeClone(
  options: GitCloneOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitCloneResult> {
  try {
    // Resolve localPath to absolute so git receives an unambiguous target,
    // then derive a cwd from its parent directory — the clone destination
    // doesn't exist yet, so we can't use it as cwd (ENOENT).
    const resolvedLocalPath = resolve(
      context.workingDirectory,
      options.localPath,
    );
    const cloneCwd = dirname(resolvedLocalPath);

    /**
     * Flags first, then `--end-of-options`, then positional args.
     * `--end-of-options` stops git's option parser, so even a remoteUrl like
     * `--config=core.sshCommand=<cmd>` is treated as a URL, not an option.
     * Defense in depth — `GitUrlSchema` rejects leading-`-` URLs at the tool
     * boundary; this guards against future code paths that bypass the schema.
     */
    const args: string[] = [];

    if (options.branch) {
      args.push('--branch', options.branch);
    }

    if (options.depth) {
      args.push('--depth', options.depth.toString());
    }

    if (options.bare) {
      args.push('--bare');
    }

    if (options.mirror) {
      args.push('--mirror');
    }

    if (options.recurseSubmodules) {
      args.push('--recurse-submodules');
    }

    args.push('--end-of-options', options.remoteUrl, resolvedLocalPath);

    const cmd = buildGitCommand({ command: 'clone', args });
    await execGit(cmd, cloneCwd);

    // Retrieve HEAD commit hash and actual branch from the cloned repo
    let commitHash: string | undefined;
    let actualBranch: string = options.branch || 'main';
    try {
      const [revParseResult, branchResult] = await Promise.all([
        execGit(
          buildGitCommand({ command: 'rev-parse', args: ['HEAD'] }),
          resolvedLocalPath),
        execGit(
          buildGitCommand({
            command: 'rev-parse',
            args: ['--abbrev-ref', 'HEAD'],
          }),
          resolvedLocalPath),
      ]);
      commitHash = revParseResult.stdout.trim() || undefined;
      actualBranch = branchResult.stdout.trim() || actualBranch;
    } catch {
      // Non-critical — empty repos have no HEAD
    }

    const result: GitCloneResult = {
      success: true,
      localPath: resolvedLocalPath,
      remoteUrl: options.remoteUrl,
      branch: actualBranch,
      ...(commitHash && { commitHash }),
    };

    return result;
  } catch (error) {
    throw mapGitError(error, 'clone');
  }
}
