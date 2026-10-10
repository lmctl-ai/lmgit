// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git reset operation
 * @module services/git/providers/cli/operations/staging/reset
 */


import type {
  GitOperationContext,
  GitResetOptions,
  GitResetResult,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';



/**
 * Execute git reset to move HEAD and/or modify the index/working tree.
 *
 * Reports the actual files affected by the reset by:
 *   1. Capturing HEAD before the reset.
 *   2. Capturing dirty files (porcelain status) before a `--hard` reset.
 *   3. After reset, computing `git diff --name-only OLD..NEW` for any HEAD
 *      movement (the content the reset is moving past).
 *   4. Combining with explicit `paths` (for path-only reset) and the
 *      pre-existing dirty files that `--hard` discarded.
 */
export async function executeReset(
  options: GitResetOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitResetResult> {
  try {
    const cwd = context.workingDirectory;

    // Capture pre-reset state for accurate "what happened" reporting.
    const previousCommit = await safeRevParse(execGit, cwd);
    const dirtyBefore =
      options.mode === 'hard' && !options.paths
        ? await listDirtyFiles(execGit, cwd)
        : [];

    // Build the reset command.
    const args: string[] = [];
    switch (options.mode) {
      case 'soft':
        args.push('--soft');
        break;
      case 'mixed':
        args.push('--mixed');
        break;
      case 'hard':
        args.push('--hard');
        break;
      case 'merge':
        args.push('--merge');
        break;
      case 'keep':
        args.push('--keep');
        break;
    }
    if (options.commit) args.push(options.commit);
    if (options.paths && options.paths.length > 0) {
      args.push('--', ...options.paths);
    }

    await execGit(buildGitCommand({ command: 'reset', args }), cwd);

    const currentCommit = await safeRevParse(execGit, cwd);

    // Compute the file list affected by the reset.
    const affected = new Set<string>();

    if (options.paths && options.paths.length > 0) {
      // Path-specific reset only changes those paths.
      for (const p of options.paths) affected.add(p);
    } else if (
      previousCommit &&
      currentCommit &&
      previousCommit !== currentCommit
    ) {
      // HEAD moved — the diff between old and new HEAD is what the reset
      // is rewinding/advancing past.
      const diffResult = await execGit(
        buildGitCommand({
          command: 'diff',
          args: ['--name-only', `${previousCommit}..${currentCommit}`],
        }),
        cwd,
        { allowNonZeroExit: true },
      );
      for (const line of diffResult.stdout.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) affected.add(trimmed);
      }
    }

    // --hard always wipes pending working-tree changes (whether or not HEAD
    // moved). Report those alongside any rewound commits.
    if (options.mode === 'hard') {
      for (const p of dirtyBefore) affected.add(p);
    }

    const result: GitResetResult = {
      success: true,
      mode: options.mode,
      commit: currentCommit ?? '',
      filesReset: [...affected],
    };
    if (previousCommit && previousCommit !== currentCommit) {
      result.previousCommit = previousCommit;
    }
    return result;
  } catch (error) {
    throw mapGitError(error, 'reset');
  }
}

/**
 * Resolve HEAD to a full commit hash. Returns undefined if the repo has no
 * commits yet (rev-parse exits non-zero) so callers can degrade gracefully.
 */
async function safeRevParse(
  execGit: ExecGitFn,
  cwd: string,
): Promise<string | undefined> {
  const result = await execGit(
    buildGitCommand({ command: 'rev-parse', args: ['HEAD'] }),
    cwd,
    { allowNonZeroExit: true },
  );
  if ((result.exitCode ?? 0) !== 0) return undefined;
  const hash = result.stdout.trim();
  return hash || undefined;
}

/**
 * List files with pending changes (staged, unstaged, or untracked-but-ignored
 * is omitted) so we can report what `--hard` discarded.
 */
async function listDirtyFiles(
  execGit: ExecGitFn,
  cwd: string,
): Promise<string[]> {
  const result = await execGit(
    buildGitCommand({
      command: 'status',
      args: ['--porcelain=v1', '--untracked-files=no'],
    }),
    cwd,
    { allowNonZeroExit: true },
  );
  const files: string[] = [];
  for (const line of result.stdout.split('\n')) {
    // Porcelain v1: "XY <path>" where XY is two status chars + space.
    const path = line.slice(3).trim();
    if (path) files.push(path);
  }
  return files;
}
