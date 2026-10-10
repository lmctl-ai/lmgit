// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview Git cherry-pick operations
 * @module services/git/providers/cli/operations/branches/cherry-pick
 */


import type {
  GitCherryPickOptions,
  GitCherryPickResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import {
  buildGitCommand,
  mapGitError
} from '../../utils/index.js';

/**
 * Execute git cherry-pick to apply commits.
 *
 * A cherry-pick that exits non-zero solely because of a CONFLICT is a
 * documented success state with conflicted files to resolve, not a failure.
 * We pass `allowNonZeroExit` so we can return the conflict info structurally.
 */
export async function executeCherryPick(
  options: GitCherryPickOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitCherryPickResult> {
  try {
    const args: string[] = [];

    if (options.abort) {
      args.push('--abort');
    } else if (options.continueOperation) {
      args.push('--continue');
    } else {
      if (options.noCommit) {
        args.push('--no-commit');
      }

      if (options.mainline !== undefined) {
        args.push('--mainline', String(options.mainline));
      }

      if (options.strategy) {
        args.push('--strategy', options.strategy);
      }

      if (options.signoff) {
        args.push('--signoff');
      }

      if (!!context.signCommits) {
        args.push('--gpg-sign');
      }

      args.push(...options.commits);
    }

    const cmd = buildGitCommand({ command: 'cherry-pick', args });
    const result = await execGit(
      cmd,
      context.workingDirectory,
      { allowNonZeroExit: true },
    );

    const hasConflicts =
      result.stdout.includes('CONFLICT') || result.stderr.includes('CONFLICT');
    const exitCode = result.exitCode ?? 0;

    if (exitCode !== 0 && !hasConflicts) {
      throw new Error(
        `Exit Code: ${exitCode}\nStderr: ${result.stderr}\nStdout: ${result.stdout}`,
      );
    }

    const conflictedFiles = parseConflictedFiles(
      `${result.stdout}\n${result.stderr}`,
    );

    const cherryPickResult: GitCherryPickResult = {
      success: true,
      pickedCommits:
        options.abort || options.continueOperation ? [] : options.commits,
      conflicts: hasConflicts,
      conflictedFiles,
    };

    return cherryPickResult;
  } catch (error) {
    throw mapGitError(error, 'cherry-pick');
  }
}

function parseConflictedFiles(combined: string): string[] {
  const seen = new Set<string>();
  for (const line of combined.split('\n')) {
    const match = line.match(/CONFLICT.*?\sin\s(.+?)\s*$/);
    if (match?.[1]) {
      seen.add(match[1].trim());
    }
  }
  return [...seen];
}
