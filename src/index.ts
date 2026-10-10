// Modified by Lattice Systems LLC: adapted from CliGitProvider in cyanheads/git-mcp-server (Apache-2.0); the MCP
// logging/DI coupling is replaced by per-method policy checks. See NOTICE.
/**
 * @fileoverview git2 — policy-driven facade over the ported CLI git provider
 * operations. Replaces the original CliGitProvider (which coupled operations
 * to MCP-style logging and DI) with a small class whose per-method policy
 * enforcement gates write operations before any command is built.
 * @module git2
 */

import {
  checkPolicy,
  isDryRunResult,
  type Access,
  type DryRunResult,
  type Policy,
} from '@lmctl-ai/lmts/server';

import type {
  GitAddOptions,
  GitAddResult,
  GitBlameOptions,
  GitBlameResult,
  GitBranchOptions,
  GitBranchResult,
  GitCherryPickOptions,
  GitCherryPickResult,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCleanOptions,
  GitCleanResult,
  GitCloneOptions,
  GitCloneResult,
  GitCommitOptions,
  GitCommitResult,
  GitDiffOptions,
  GitDiffResult,
  GitFetchOptions,
  GitFetchResult,
  GitInitOptions,
  GitInitResult,
  GitLogOptions,
  GitLogResult,
  GitMergeOptions,
  GitMergeResult,
  GitOperationContext,
  GitPullOptions,
  GitPullResult,
  GitPushOptions,
  GitPushResult,
  GitRebaseOptions,
  GitRebaseResult,
  GitReflogOptions,
  GitReflogResult,
  GitRemoteOptions,
  GitRemoteResult,
  GitResetOptions,
  GitResetResult,
  GitShowOptions,
  GitShowResult,
  GitStashOptions,
  GitStashResult,
  GitStatusOptions,
  GitStatusResult,
  GitTagOptions,
  GitTagResult,
  GitWorktreeOptions,
  GitWorktreeResult,
} from './types.js';
import {
  executeAdd,
  executeBlame,
  executeBranch,
  executeCherryPick,
  executeCheckout,
  executeClean,
  executeClone,
  executeCommit,
  executeDiff,
  executeFetch,
  executeInit,
  executeLog,
  executeMerge,
  executePull,
  executePush,
  executeRebase,
  executeReflog,
  executeRemote,
  executeReset,
  executeShow,
  executeStash,
  executeStatus,
  executeTag,
  executeWorktree,
} from './operations/index.js';
import {
  executeGitCommand,
  type ExecGitFn,
  type ExecuteGitOptions,
} from './utils/git-executor.js';

export * from './types.js';
export * from './operations/index.js';
export { executeGitCommand } from './utils/git-executor.js';
export type { ExecGitFn } from './utils/git-executor.js';

export interface Git2Options {
  policy?: Partial<Policy>;
}

/**
 * A write operation that mutates remote history or publishes refs.
 * Used for labeling only; the access model is binary read/write.
 */
export class Git2 {
  readonly policy: Policy;

  constructor(options: Git2Options = {}) {
    this.policy = {
      dryRun: options.policy?.dryRun ?? false,
      readOnly: options.policy?.readOnly ?? false,
    };
  }

  private makeExecGit(): ExecGitFn {
    return (
      args: string[],
      cwd: string,
      options?: ExecuteGitOptions,
    ) => executeGitCommand(args, cwd, options);
  }

  private makeContext(workingDirectory: string): GitOperationContext {
    return {
      workingDirectory,
      signCommits: ['1', 'true', 'yes', 'on'].includes(
        (process.env['GIT_SIGN_COMMITS'] ?? '').toLowerCase(),
      ),
    };
  }

  /**
   * Enforce policy for a write operation. Returns a DryRunResult when the
   * operation should be simulated; otherwise undefined (proceed for real).
   */
  private guard(access: Access, name: string, cwd: string, command?: string[]): DryRunResult | undefined {
    return checkPolicy(access, this.policy, {
      name,
      command,
      data: { workingDirectory: cwd },
    });
  }

  // ----------------------------------------------------------------------
  // Repository operations
  // ----------------------------------------------------------------------

  async init(options: GitInitOptions): Promise<GitInitResult | DryRunResult> {
    const simulated = this.guard('write', 'git_init', options.path, [
      'git2', 'init',
    ]);
    if (simulated) return simulated;
    return executeInit(options, this.makeContext(options.path), this.makeExecGit());
  }

  async clone(options: GitCloneOptions): Promise<GitCloneResult | DryRunResult> {
    const simulated = this.guard('write', 'git_clone', options.localPath, [
      'git2', 'clone',
    ]);
    if (simulated) return simulated;
    return executeClone(options, this.makeContext(options.localPath), this.makeExecGit());
  }

  async status(cwd: string, options: GitStatusOptions = {}): Promise<GitStatusResult> {
    this.guard('read', 'git_status', cwd);
    return executeStatus(options, this.makeContext(cwd), this.makeExecGit());
  }

  async clean(cwd: string, options: GitCleanOptions): Promise<GitCleanResult | DryRunResult> {
    const simulated = this.guard('write', 'git_clean', cwd);
    if (simulated) return simulated;
    return executeClean(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Staging & commits
  // ----------------------------------------------------------------------

  async add(cwd: string, options: GitAddOptions): Promise<GitAddResult | DryRunResult> {
    const simulated = this.guard('write', 'git_add', cwd);
    if (simulated) return simulated;
    return executeAdd(options, this.makeContext(cwd), this.makeExecGit());
  }

  async reset(cwd: string, options: GitResetOptions): Promise<GitResetResult | DryRunResult> {
    const simulated = this.guard('write', 'git_reset', cwd);
    if (simulated) return simulated;
    return executeReset(options, this.makeContext(cwd), this.makeExecGit());
  }

  async commit(cwd: string, options: GitCommitOptions): Promise<GitCommitResult | DryRunResult> {
    const simulated = this.guard('write', 'git_commit', cwd);
    if (simulated) return simulated;
    return executeCommit(options, this.makeContext(cwd), this.makeExecGit());
  }

  async log(cwd: string, options: GitLogOptions = {}): Promise<GitLogResult> {
    this.guard('read', 'git_log', cwd);
    return executeLog(options, this.makeContext(cwd), this.makeExecGit());
  }

  async show(cwd: string, options: GitShowOptions): Promise<GitShowResult> {
    this.guard('read', 'git_show', cwd);
    return executeShow(options, this.makeContext(cwd), this.makeExecGit());
  }

  async diff(cwd: string, options: GitDiffOptions = {}): Promise<GitDiffResult> {
    this.guard('read', 'git_diff', cwd);
    return executeDiff(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Branches
  // ----------------------------------------------------------------------

  async branch(cwd: string, options: GitBranchOptions): Promise<GitBranchResult | DryRunResult> {
    const access: Access =
      options.mode === 'list' || options.mode === 'show-current' ? 'read' : 'write';
    const simulated = this.guard(access, `git_branch:${options.mode}`, cwd);
    if (simulated) return simulated;
    return executeBranch(options, this.makeContext(cwd), this.makeExecGit());
  }

  async checkout(cwd: string, options: GitCheckoutOptions): Promise<GitCheckoutResult | DryRunResult> {
    const simulated = this.guard('write', 'git_checkout', cwd);
    if (simulated) return simulated;
    return executeCheckout(options, this.makeContext(cwd), this.makeExecGit());
  }

  async merge(cwd: string, options: GitMergeOptions): Promise<GitMergeResult | DryRunResult> {
    const simulated = this.guard('write', 'git_merge', cwd);
    if (simulated) return simulated;
    return executeMerge(options, this.makeContext(cwd), this.makeExecGit());
  }

  async rebase(cwd: string, options: GitRebaseOptions): Promise<GitRebaseResult | DryRunResult> {
    const simulated = this.guard('write', 'git_rebase', cwd);
    if (simulated) return simulated;
    return executeRebase(options, this.makeContext(cwd), this.makeExecGit());
  }

  async cherryPick(cwd: string, options: GitCherryPickOptions): Promise<GitCherryPickResult | DryRunResult> {
    const simulated = this.guard('write', 'git_cherry_pick', cwd);
    if (simulated) return simulated;
    return executeCherryPick(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Remotes
  // ----------------------------------------------------------------------

  async remote(cwd: string, options: GitRemoteOptions): Promise<GitRemoteResult | DryRunResult> {
    const access: Access =
      options.mode === 'list' || options.mode === 'get-url' ? 'read' : 'write';
    const simulated = this.guard(access, `git_remote:${options.mode}`, cwd);
    if (simulated) return simulated;
    return executeRemote(options, this.makeContext(cwd), this.makeExecGit());
  }

  async fetch(cwd: string, options: GitFetchOptions = {}): Promise<GitFetchResult | DryRunResult> {
    const simulated = this.guard('write', 'git_fetch', cwd);
    if (simulated) return simulated;
    return executeFetch(options, this.makeContext(cwd), this.makeExecGit());
  }

  async push(cwd: string, options: GitPushOptions = {}): Promise<GitPushResult | DryRunResult> {
    const simulated = this.guard('write', 'git_push', cwd);
    if (simulated) return simulated;
    return executePush(options, this.makeContext(cwd), this.makeExecGit());
  }

  async pull(cwd: string, options: GitPullOptions = {}): Promise<GitPullResult | DryRunResult> {
    const simulated = this.guard('write', 'git_pull', cwd);
    if (simulated) return simulated;
    return executePull(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Tags
  // ----------------------------------------------------------------------

  async tag(cwd: string, options: GitTagOptions): Promise<GitTagResult | DryRunResult> {
    const access: Access = options.mode === 'list' || options.mode === 'verify' ? 'read' : 'write';
    const simulated = this.guard(access, `git_tag:${options.mode}`, cwd);
    if (simulated) return simulated;
    return executeTag(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Stash
  // ----------------------------------------------------------------------

  async stash(cwd: string, options: GitStashOptions): Promise<GitStashResult | DryRunResult> {
    const access: Access = options.mode === 'list' ? 'read' : 'write';
    const simulated = this.guard(access, `git_stash:${options.mode}`, cwd);
    if (simulated) return simulated;
    return executeStash(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // Worktree
  // ----------------------------------------------------------------------

  async worktree(cwd: string, options: GitWorktreeOptions): Promise<GitWorktreeResult | DryRunResult> {
    const access: Access = options.mode === 'list' ? 'read' : 'write';
    const simulated = this.guard(access, `git_worktree:${options.mode}`, cwd);
    if (simulated) return simulated;
    return executeWorktree(options, this.makeContext(cwd), this.makeExecGit());
  }

  // ----------------------------------------------------------------------
  // History inspection
  // ----------------------------------------------------------------------

  async blame(cwd: string, options: GitBlameOptions): Promise<GitBlameResult> {
    this.guard('read', 'git_blame', cwd);
    return executeBlame(options, this.makeContext(cwd), this.makeExecGit());
  }

  async reflog(cwd: string, options: GitReflogOptions = {}): Promise<GitReflogResult> {
    this.guard('read', 'git_reflog', cwd);
    return executeReflog(options, this.makeContext(cwd), this.makeExecGit());
  }
}

/** Convenience: true when a result is a synthetic dry-run result. */
export { isDryRunResult };
