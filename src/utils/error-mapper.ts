// Modified by Lattice Systems LLC: derived from cyanheads/git-mcp-server (Apache-2.0), ported from the MCP server to a
// standalone CLI (MCP/DI/OpenTelemetry wrapper removed). The upstream header below is preserved. See NOTICE.
/**
 * @fileoverview Git CLI error mapping utilities
 * @module services/git/providers/cli/utils/error-mapper
 */

import { ErrorCode, CliError } from '@lmctl-ai/lmts/server';

/**
 * Git error patterns and their corresponding error codes.
 */
const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  code: ErrorCode;
  messageTransform?: (match: RegExpMatchArray) => string;
}> = [
  // Repository errors
  {
    pattern: /not a git repository/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /repository .* not found/i,
    code: ErrorCode.InvalidRequest,
  },

  // Permission errors
  {
    pattern: /permission denied/i,
    code: ErrorCode.InternalError,
  },
  {
    pattern: /eacces/i,
    code: ErrorCode.InternalError,
  },

  // File errors
  {
    pattern: /pathspec '(.+)' did not match any files/i,
    code: ErrorCode.InvalidRequest,
    messageTransform: (match) => `File not found: ${match[1]}`,
  },
  {
    pattern: /no such file or directory/i,
    code: ErrorCode.InvalidRequest,
  },

  // Conflict errors
  {
    pattern: /conflict/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /you have unstaged changes/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /your local changes would be overwritten/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /failed to merge/i,
    code: ErrorCode.InvalidRequest,
  },

  // Branch errors
  {
    pattern: /branch '(.+)' already exists/i,
    code: ErrorCode.InvalidRequest,
    messageTransform: (match) => `Branch already exists: ${match[1]}`,
  },
  {
    pattern: /branch '(.+)' not found/i,
    code: ErrorCode.InvalidRequest,
    messageTransform: (match) => `Branch not found: ${match[1]}`,
  },

  // Remote errors
  {
    pattern: /could not read from remote/i,
    code: ErrorCode.InternalError,
  },
  {
    pattern: /failed to connect/i,
    code: ErrorCode.InternalError,
  },
  {
    pattern: /authentication failed/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /remote .* does not exist/i,
    code: ErrorCode.InvalidRequest,
  },

  // Network errors
  {
    pattern: /network/i,
    code: ErrorCode.InternalError,
  },
  {
    pattern: /connection/i,
    code: ErrorCode.InternalError,
  },
  {
    pattern: /timeout/i,
    code: ErrorCode.InternalError,
  },

  // Commit errors
  {
    pattern: /nothing to commit/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /no changes added to commit/i,
    code: ErrorCode.InvalidRequest,
  },

  // Reference errors
  {
    pattern: /reference is not a tree/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /ambiguous argument/i,
    code: ErrorCode.InvalidRequest,
  },
  {
    pattern: /unknown revision/i,
    code: ErrorCode.InvalidRequest,
  },
];

/**
 * Map a git CLI error to an appropriate CliError.
 *
 * @param error - The original error from git command execution
 * @param operation - The git operation that failed
 * @returns Mapped CliError with appropriate code and message
 */
export function mapGitError(error: unknown, operation: string): CliError {
  if (error instanceof CliError) {
    return error;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const lowerMessage = errorMessage.toLowerCase();

  // Try to match against known error patterns
  for (const { pattern, code, messageTransform } of ERROR_PATTERNS) {
    const match = errorMessage.match(pattern);
    if (match) {
      const message = messageTransform
        ? messageTransform(match)
        : `Git ${operation} failed: ${errorMessage}`;

      return new CliError(code, message, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  // Check for git not installed
  if (
    lowerMessage.includes('git') &&
    (lowerMessage.includes('not found') ||
      lowerMessage.includes('enoent') ||
      lowerMessage.includes('command not found'))
  ) {
    return new CliError(
      ErrorCode.InternalError,
      'Git command not found. Please ensure Git is installed and in your PATH.',
      { cause: error instanceof Error ? error : undefined },
    );
  }

  // Default error
  return new CliError(
    ErrorCode.InternalError,
    `Git ${operation} failed: ${errorMessage}`,
    { cause: error instanceof Error ? error : undefined },
  );
}

/**
 * Check if an error indicates a missing git installation.
 *
 * @param error - Error to check
 * @returns True if git is not installed
 */
export function isGitNotFoundError(error: unknown): boolean {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).toLowerCase();
  return (
    message.includes('git') &&
    (message.includes('not found') ||
      message.includes('enoent') ||
      message.includes('command not found'))
  );
}

/**
 * Extract meaningful error context from git stderr output.
 *
 * @param stderr - Git command stderr output
 * @returns Cleaned error message
 */
export function extractGitErrorMessage(stderr: string): string {
  // Remove common git prefixes
  let message = stderr
    .replace(/^fatal:\s*/gim, '')
    .replace(/^error:\s*/gim, '')
    .replace(/^warning:\s*/gim, '')
    .trim();

  // Take only the first meaningful line
  const lines = message.split('\n').filter((l) => l.trim());
  if (lines.length > 0) {
    message = lines[0]!;
  }

  return message;
}
