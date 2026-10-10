// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview CLI provider git commit operation
 * @module services/git/providers/cli/operations/commits/commit
 */


import type {
  GitCommitOptions,
  GitCommitResult,
  GitOperationContext,
} from '../../types.js';
import type { ExecGitFn } from '../../utils/git-executor.js';
import {
  buildGitCommand,
  GIT_FIELD_DELIMITER,
  GIT_RECORD_DELIMITER,
  mapGitError
} from '../../utils/index.js';

/**
 * Execute git commit to create a new commit.
 */
export async function executeCommit(
  options: GitCommitOptions,
  context: GitOperationContext,
  execGit: ExecGitFn,
): Promise<GitCommitResult> {
  try {
    // Stage specified files before committing (atomic stage+commit)
    if (options.filesToStage?.length) {
      const addCmd = buildGitCommand({
        command: 'add',
        args: ['--', ...options.filesToStage],
      });
      await execGit(addCmd, context.workingDirectory);
    }

    const args: string[] = [`--message=${options.message}`];

    if (options.amend) {
      args.push('--amend');
    }

    if (options.allowEmpty) {
      args.push('--allow-empty');
    }

    if (options.noVerify) {
      args.push('--no-verify');
    }

    // Signing policy: attempt when GIT_SIGN_COMMITS is enabled, fall back
    // to unsigned silently on failure. `signed` in the result reflects the
    // actual outcome so callers can observe fallback.
    const signRequested = !!context.signCommits;
    let signed = false;
    let signingWarning: string | undefined;

    if (signRequested) {
      args.push('--gpg-sign');
    }

    if (options.author) {
      const authorStr = `${options.author.name} <${options.author.email}>`;
      args.push(`--author=${authorStr}`);
    }

    const cmd = buildGitCommand({ command: 'commit', args });

    try {
      await execGit(cmd, context.workingDirectory);
      signed = signRequested;
    } catch (error) {
      if (!signRequested) {
        throw error;
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      process.stderr.write('git2: commit signing failed, retrying unsigned: ' + errorMessage + '\n');
      signingWarning = `GIT_SIGN_COMMITS is enabled but signing failed; commit created unsigned. Check signing key availability (gpg-agent running, SSH key accessible). Underlying error: ${errorMessage}`;
      const unsignedArgs = args.filter((a) => a !== '--gpg-sign');
      const unsignedCmd = buildGitCommand({
        command: 'commit',
        args: unsignedArgs,
      });
      await execGit(
        unsignedCmd,
        context.workingDirectory);
    }

    // Get commit hash reliably
    const hashCmd = buildGitCommand({
      command: 'rev-parse',
      args: ['HEAD'],
    });
    const hashResult = await execGit(
      hashCmd,
      context.workingDirectory);
    const commitHash = hashResult.stdout.trim();

    // Get commit details using the reliable hash
    const showCmd = buildGitCommand({
      command: 'show',
      args: [
        `--format=%an${GIT_FIELD_DELIMITER}%at${GIT_RECORD_DELIMITER}`,
        '--name-only',
        commitHash,
      ],
    });
    const showResult = await execGit(
      showCmd,
      context.workingDirectory);

    const parts = showResult.stdout.split(GIT_RECORD_DELIMITER);
    const metaParts = parts[0]?.split(GIT_FIELD_DELIMITER) || [];
    const authorName = metaParts[0] || '';
    const timestamp = parseInt(metaParts[1] || '0', 10);

    // Parse changed files from the second part of the output
    // git show --name-only outputs filenames after the metadata section
    const filesChanged = parts[1]?.split('\n').filter((f) => f.trim()) || [];

    const result: GitCommitResult = {
      success: true,
      commitHash,
      message: options.message,
      author: authorName,
      timestamp,
      filesChanged,
      signed,
    };

    if (signingWarning) {
      result.signingWarning = signingWarning;
    }

    return result;
  } catch (error) {
    throw mapGitError(error, 'commit');
  }
}
