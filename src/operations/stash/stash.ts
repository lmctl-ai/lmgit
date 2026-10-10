// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git stash operation
 * @module services/git/providers/cli/operations/stash/stash
 */


import type {
  GitOperationContext,
  GitStashOptions,
  GitStashResult,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import { buildGitCommand, mapGitError } from '../../utils/index.js';

/**
 * Execute git stash operations.
 *
 * @param options - Stash options
 * @param context - Operation context
 * @param execGit - Function to execute git commands
 * @returns Stash result
 */
export async function executeStash(
  options: GitStashOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitStashResult> {
  try {
    const args: string[] = [options.mode];

    switch (options.mode) {
      case 'list': {
        // Use custom format to include unix timestamp.
        // `stash list` wraps `git log` on the stash ref, so `-n N` caps entries at the source.
        args.push('--format=%gd\t%ct\t%gs');
        if (typeof options.limit === 'number' && options.limit > 0) {
          args.push(`-n${options.limit}`);
        }
        const cmd = buildGitCommand({ command: 'stash', args });
        const result = await execGit(
          cmd,
          context.workingDirectory);

        // Parse stash list output (format: refname\ttimestamp\tsubject)
        const stashes = result.stdout
          .split('\n')
          .filter((line) => line.trim())
          .map((line, index) => {
            // Format: 0\t1709747200\tWIP on branch: message
            const parts = line.split('\t');
            const [refPart, tsPart, ...subjectParts] = parts;
            if (refPart && tsPart && subjectParts.length > 0) {
              // %gd outputs "stash@{N}" — extract the index from inside braces
              const indexMatch = refPart.match(/\{(\d+)\}/);
              const stashIndex = indexMatch
                ? parseInt(indexMatch[1]!, 10)
                : index;
              const timestamp = parseInt(tsPart, 10);
              const subject = subjectParts.join('\t');
              // Extract branch from "WIP on <branch>:" or "On <branch>:"
              const branchMatch = subject.match(
                /^(?:WIP on|On)\s+([^:]+):\s+(.*)$/,
              );
              return {
                ref: `stash@{${stashIndex}}`,
                index: stashIndex,
                branch: branchMatch?.[1] ?? '',
                description: branchMatch?.[2] ?? subject,
                timestamp,
              };
            }
            return {
              ref: `stash@{${index}}`,
              index,
              branch: '',
              description: line,
              timestamp: 0,
            };
          });

        const listResult = {
          mode: 'list' as const,
          stashes,
        };

        return listResult;
      }

      case 'push': {
        if (options.message) {
          args.push(`--message=${options.message}`);
        }

        if (options.includeUntracked) {
          args.push('--include-untracked');
        }

        if (options.keepIndex) {
          args.push('--keep-index');
        }

        const cmd = buildGitCommand({ command: 'stash', args });
        await execGit(cmd, context.workingDirectory);

        const pushResult = {
          mode: 'push' as const,
          created: 'stash@{0}',
        };

        return pushResult;
      }

      case 'pop':
      case 'apply': {
        if (options.stashRef) {
          args.push(options.stashRef);
        }

        const cmd = buildGitCommand({ command: 'stash', args });
        const result = await execGit(
          cmd,
          context.workingDirectory);

        const hasConflicts =
          result.stdout.includes('CONFLICT') ||
          result.stderr.includes('CONFLICT');

        const applyResult = {
          mode: options.mode,
          applied: options.stashRef || 'stash@{0}',
          conflicts: hasConflicts,
        };

        return applyResult;
      }

      case 'drop': {
        if (!options.stashRef) {
          throw new Error('Stash reference is required for drop operation');
        }

        args.push(options.stashRef);

        const cmd = buildGitCommand({ command: 'stash', args });
        await execGit(cmd, context.workingDirectory);

        const dropResult = {
          mode: 'drop' as const,
          dropped: options.stashRef,
        };

        return dropResult;
      }

      case 'clear': {
        const cmd = buildGitCommand({ command: 'stash', args });
        await execGit(cmd, context.workingDirectory);

        const clearResult = {
          mode: 'clear' as const,
        };

        return clearResult;
      }

      default:
        throw new Error('Unknown stash operation mode');
    }
  } catch (error) {
    throw mapGitError(error, 'stash');
  }
}
