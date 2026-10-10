#!/usr/bin/env bun
/**
 * @fileoverview git2 CLI entry point.
 *
 * Usage:
 *   git2 <operation> [options]
 *
 * Common options:
 *   --path <dir>             Working directory (defaults to process.cwd())
 *   --dryrun                 Simulate write operations
 *   --readonly               Refuse write operations
 *   --list                   List operations with their read/write access
 *
 * All results are printed as structured JSON to stdout.
 * @module git2/cli
 */

import { CliError, ErrorCode, runCli, type OpDef, type Policy } from '@lmctl-ai/lmts/server';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath$1 } from 'node:path';

import { Git2 } from './index.js';
import { ALL_GIT2_SCHEMAS, LM_STATUS_SCHEMA } from './schemas.js';

const schemaMap = new Map(ALL_GIT2_SCHEMAS.map((s) => [s.name, s]));

// schemaOp attaches a declared OperationSchema to an OpDef so the runner can
// route through @lmctl-ai/lmts (argv / JSON / GraphQL / --explain).
function schemaOp<P extends Record<string, unknown> = Record<string, unknown>>(
  name: string,
  access: 'read' | 'write',
  description: string,
  inputSchema: import('@lmctl-ai/lmts').OperationSchema,
  run: (p: P, ctx: Git2Ctx) => Promise<unknown>,
): OpDef<Git2Ctx> {
  return {
    name,
    access,
    description,
    inputSchema,
    run: async (p, ctx) => run(p as unknown as P, ctx),
  };
}
import {
  lmBlame,
  lmBranch,
  lmDiff,
  lmLog,
  lmLsFiles,
  lmRemote,
  lmRevParse,
  lmShow,
  lmStatus,
} from './lm-git.js';

interface Git2Ctx {
  git: Git2;
}

function resolvePath(params: Record<string, unknown>): string {
  const cwd = process.cwd();
  const p = params['path'] ?? params['repo'];
  if (p === undefined || p === null || p === '') return cwd;
  if (typeof p !== 'string') {
    throw new CliError(ErrorCode.InvalidRequest, '--path/--repo must be a string');
  }
  return resolvePath$1(cwd, p);
}

/** Resolve the working directory from --repo only (payload keeps --path). */
function resolveRepo(params: Record<string, unknown>): string {
  const cwd = process.cwd();
  const p = params['repo'];
  if (p === undefined || p === null || p === '') return cwd;
  if (typeof p !== 'string') {
    throw new CliError(ErrorCode.InvalidRequest, '--repo must be a string');
  }
  return resolvePath$1(cwd, p);
}

function stripPath(params: Record<string, unknown>): Record<string, unknown> {
  const { path: _path, repo: _repo, ...rest } = params;
  return rest;
}

// Strip only the repo working-dir flag: payload --path passes through.
function stripRepo(params: Record<string, unknown>): Record<string, unknown> {
  const { repo: _repo, ...rest } = params;
  return rest;
}

// ---------------------------------------------------------------------------
// Ops where --path is part of the payload (worktree add/remove/move, init),
// not the working directory. Those use --repo as the working directory flag.
// ---------------------------------------------------------------------------

function makeRepoOp<P, R>(
  name: string,
  access: 'read' | 'write',
  description: string,
  run: (path: string, p: P, ctx: Git2Ctx) => Promise<R>,
  _params?: Record<string, string>,
): OpDef<Git2Ctx> {
  const inputSchema = schemaMap.get(name);
  return {
    name,
    access,
    description: inputSchema?.description ?? description,
    inputSchema,
    run: async (p, ctx) => run(resolveRepo(p), stripRepo(p) as unknown as P, ctx),
  };
}

// ---------------------------------------------------------------------------
// Operation definitions
// ---------------------------------------------------------------------------

function makeOps(): OpDef<Git2Ctx>[] {
  // Read op operating inside a repository (defaults cwd, overridable --path).
  const repoRead = <P extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
    name: string,
    description: string,
    run: (path: string, p: P, ctx: Git2Ctx) => Promise<R>,
    _params?: Record<string, string>,
  ): OpDef<Git2Ctx> => {
    const inputSchema = schemaMap.get(name);
    return {
      name,
      description: inputSchema?.description ?? description,
      access: 'read',
      inputSchema,
      run: async (p, ctx) => run(resolvePath(p), stripPath(p) as unknown as P, ctx),
    };
  };

  // Write op operating inside a repository.
  const repoWrite = <P extends Record<string, unknown> = Record<string, unknown>, R = unknown>(
    name: string,
    description: string,
    run: (path: string, p: P, ctx: Git2Ctx) => Promise<R>,
    _params?: Record<string, string>,
  ): OpDef<Git2Ctx> => {
    const inputSchema = schemaMap.get(name);
    return {
      name,
      description: inputSchema?.description ?? description,
      access: 'write',
      inputSchema,
      run: async (p, ctx) => run(resolvePath(p), stripPath(p) as unknown as P, ctx),
    };
  };

  return [
    // ---- Repository operations ----
    {
      name: 'init',
      description: 'Initialize a new git repository',
      access: 'write',
      inputSchema: schemaMap.get('init'),
      run: async (p, ctx) =>
        ctx.git.init({ ...stripPath(p), path: resolvePath(p) } as never),
    },
    {
      name: 'clone',
      description: 'Clone a remote repository',
      access: 'write',
      inputSchema: schemaMap.get('clone'),
      run: async (p, ctx) => ctx.git.clone(p as never),
    },
    repoRead('status', 'Show working tree status', (path, p, ctx) => ctx.git.status(path, p as never), {
      includeUntracked: 'Include untracked files (default true)',
      ignoreSubmodules: 'Ignore submodules',
    }),
    repoWrite('clean', 'Remove untracked files / directories', (path, p, ctx) => ctx.git.clean(path, p as never), {
      force: 'Actually delete (git -f)',
      dryRun: "git's own -n: show what would be removed",
      directories: 'Include untracked directories (git -d)',
      ignored: 'Include ignored files (git -x)',
    }),

    // ---- Staging & commits ----
    repoWrite('add', 'Stage files', (path, p, ctx) => ctx.git.add(path, p as never), {
      paths: 'Array of paths to stage',
      all: 'Stage all changes',
      update: 'Update tracked files only',
      force: 'Force add ignored files',
    }),
    repoWrite('reset', 'Reset HEAD / unstage paths', (path, p, ctx) => ctx.git.reset(path, p as never), {
      mode: 'soft|mixed|hard|merge|keep',
      commit: 'Commit to reset to',
      paths: 'Paths to unstage',
    }),
    repoWrite('commit', 'Create a commit', (path, p, ctx) => ctx.git.commit(path, p as never), {
      message: 'Commit message (required)',
      amend: 'Amend previous commit',
      allowEmpty: 'Allow empty commit',
      noVerify: 'Skip hooks',
      author: 'Author {name,email} object',
    }),
    repoRead('log', 'Commit history', (path, p, ctx) => ctx.git.log(path, p as never), {
      maxCount: 'Maximum commits (default 10)',
      skip: 'Commits to skip',
      author: 'Filter by author',
      since: 'Filter by date (from)',
      until: 'Filter by date (until)',
      grep: 'Filter by message',
      branch: 'Branch/ref to read',
      file: 'Filter by file',
      follow: 'Follow file renames',
    }),
    repoRead('show', 'Show a git object (commit, tree, blob, tag)', (path, p, ctx) => ctx.git.show(path, p as never), {
      object: 'Object to show (required)', format: "'raw' for raw output", stat: 'Include diffstat', filePath: 'View specific file at the ref',
    }),
    repoRead('diff', 'Show diffs', (path, p, ctx) => ctx.git.diff(path, p as never), {
      commit1: 'First commit (default HEAD)',
      commit2: 'Second commit (default working tree)',
      staged: 'Diff staged changes',
      paths: 'Limit diff to paths',
      unified: 'Context lines',
      includeUntracked: 'Diff untracked files too',
      stat: 'Summary only (diffstat)',
      nameOnly: 'Show only changed file names',
      excludePatterns: 'Patterns to exclude (e.g. lock files)',
    }),

    // ---- Branches ----
    repoRead('branch_list', 'List branches', (path, p, ctx) => ctx.git.branch(path, { ...(p as object), mode: 'list' } as never), {
      remote: 'Remote only', all: 'Local+remote', merged: 'Filter merged', noMerged: 'Filter not-merged', limit: 'Cap results',
    }),
    repoRead('branch_current', 'Show current branch', (path, p, ctx) => ctx.git.branch(path, { ...(p as object), mode: 'show-current' } as never)),
    repoWrite('branch_create', 'Create a branch', (path, p, ctx) => ctx.git.branch(path, { ...(p as object), mode: 'create' } as never), {
      branchName: 'New branch name (required)', startPoint: 'Start point', force: 'Overwrite existing',
    }),
    repoWrite('branch_delete', 'Delete a branch', (path, p, ctx) => ctx.git.branch(path, { ...(p as object), mode: 'delete' } as never), {
      branchName: 'Branch to delete (required)', force: 'Force delete (-D)',
    }),
    repoWrite('branch_rename', 'Rename a branch', (path, p, ctx) => ctx.git.branch(path, { ...(p as object), mode: 'rename' } as never), {
      branchName: 'Current name (required)', newBranchName: 'New name (required)', force: 'Force',
    }),
    repoWrite('checkout', 'Checkout a branch/commit/paths', (path, p, ctx) => ctx.git.checkout(path, p as never), {
      target: 'Branch/commit to checkout (required)', createBranch: 'Create new branch', force: 'Discard changes', paths: 'Checkout specific paths', track: 'Set upstream tracking',
    }),
    repoWrite('merge', 'Merge a branch', (path, p, ctx) => ctx.git.merge(path, p as never), {
      branch: 'Branch to merge (required)', strategy: 'Merge strategy', noFastForward: 'No fast-forward', squash: 'Squash', message: 'Merge message', abort: 'Abort in-progress merge',
    }),
    repoWrite('rebase', 'Rebase current branch', (path, p, ctx) => ctx.git.rebase(path, p as never), {
      branch: 'Upstream branch (required)', onto: 'Rebase onto', interactive: 'Interactive', abort: 'Abort in-progress rebase', continueOp: 'Continue', preserveMerges: 'Preserve merges',
    }),
    repoWrite('cherry_pick', 'Apply commits on top', (path, p, ctx) => ctx.git.cherryPick(path, p as never), {
      commits: 'Commits to pick (array, required)', noCommit: 'Apply without committing', mainline: 'Parent number for merges', strategy: 'Merge strategy', signoff: 'Add Signed-off-by',
    }),

    // ---- Remotes ----
    repoRead('remote_list', 'List remotes', (path, p, ctx) => ctx.git.remote(path, { ...(p as object), mode: 'list' } as never)),
    repoRead('remote_get_url', 'Get remote URL', (path, p, ctx) => ctx.git.remote(path, { ...(p as object), mode: 'get-url' } as never), {
      name: 'Remote name (required)',
    }),
    repoWrite('remote_add', 'Add a remote', (path, p, ctx) => ctx.git.remote(path, { ...(p as object), mode: 'add' } as never), {
      name: 'Remote name (required)', url: 'Remote URL (required)',
    }),
    repoWrite('remote_remove', 'Remove a remote', (path, p, ctx) => ctx.git.remote(path, { ...(p as object), mode: 'remove' } as never), {
      name: 'Remote name (required)',
    }),
    repoWrite('remote_set_url', 'Set remote URL', (path, p, ctx) => ctx.git.remote(path, { ...(p as object), mode: 'set-url' } as never), {
      name: 'Remote name (required)', url: 'New URL (required)', push: 'Set push URL separately',
    }),
    repoWrite('fetch', 'Fetch from a remote', (path, p, ctx) => ctx.git.fetch(path, p as never), {
      remote: 'Remote (default origin)', prune: 'Prune stale refs', tags: 'Fetch tags', depth: 'Shallow fetch depth',
    }),
    repoWrite('push', 'Push to a remote', (path, p, ctx) => ctx.git.push(path, p as never), {
      remote: 'Remote (default origin)', branch: 'Branch (default current)', force: 'Force push', forceWithLease: 'Safer force push', setUpstream: 'Set upstream', tags: 'Push tags', delete: 'Delete remote branch', dryRun: "git's own --dry-run",
    }),
    repoWrite('pull', 'Pull from a remote', (path, p, ctx) => ctx.git.pull(path, p as never), {
      remote: 'Remote (default origin)', branch: 'Branch (default current)', rebase: 'Rebase instead of merge', ffOnly: 'Fast-forward only',
    }),

    // ---- Tags ----
    repoRead('tag_list', 'List tags', (path, p, ctx) => ctx.git.tag(path, { ...(p as object), mode: 'list' } as never), {
      limit: 'Cap results',
    }),
    repoRead('tag_verify', 'Verify a tag', (path, p, ctx) => ctx.git.tag(path, { ...(p as object), mode: 'verify' } as never), {
      tagName: 'Tag name (required)',
    }),
    repoWrite('tag_create', 'Create a tag', (path, p, ctx) => ctx.git.tag(path, { ...(p as object), mode: 'create' } as never), {
      tagName: 'Tag name (required)', commit: 'Commit to tag', message: 'Annotation message', annotated: 'Create annotated tag', force: 'Overwrite existing',
    }),
    repoWrite('tag_delete', 'Delete a tag', (path, p, ctx) => ctx.git.tag(path, { ...(p as object), mode: 'delete' } as never), {
      tagName: 'Tag name (required)',
    }),

    // ---- Stash ----
    repoRead('stash_list', 'List stashes', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'list' } as never), {
      limit: 'Cap results',
    }),
    repoWrite('stash_push', 'Stash changes', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'push' } as never), {
      message: 'Stash message', includeUntracked: 'Include untracked files', keepIndex: 'Keep staged changes',
    }),
    repoWrite('stash_pop', 'Pop a stash', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'pop' } as never)),
    repoWrite('stash_apply', 'Apply a stash', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'apply' } as never)),
    repoWrite('stash_drop', 'Drop a stash', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'drop' } as never), {
      stashRef: 'Stash ref (e.g. stash@{0})',
    }),
    repoWrite('stash_clear', 'Clear all stashes', (path, p, ctx) => ctx.git.stash(path, { ...(p as object), mode: 'clear' } as never)),

    // ---- Worktree ----
    makeRepoOp('worktree_list', 'read', 'List worktrees', (path, p: object, ctx) => ctx.git.worktree(path, { ...p, mode: 'list' } as never)),
    makeRepoOp('worktree_add', 'write', 'Add a worktree', (path, p: object, ctx) => ctx.git.worktree(path, { ...p, mode: 'add' } as never), {
      path: 'Worktree path (required)', branch: 'Branch name', commitish: 'Commit to checkout', detach: 'Detached HEAD', force: 'Force',
    }),
    makeRepoOp('worktree_remove', 'write', 'Remove a worktree', (path, p: object, ctx) => ctx.git.worktree(path, { ...p, mode: 'remove' } as never), {
      path: 'Worktree path (required)', force: 'Force',
    }),
    makeRepoOp('worktree_prune', 'write', 'Prune stale worktrees', (path, p: object, ctx) => ctx.git.worktree(path, { ...p, mode: 'prune' } as never), {
      dryRun: "git's own --dry-run for prune", verbose: 'Detailed output',
    }),

    // ---- History inspection ----
    repoRead('blame', 'Blame a file', (path, p, ctx) => ctx.git.blame(path, p as never), {
      file: 'File to blame (required)', startLine: 'Start line', endLine: 'End line', ignoreWhitespace: 'Ignore whitespace',
    }),
    repoRead('reflog', 'Show reflog', (path, p, ctx) => ctx.git.reflog(path, p as never), {
      maxCount: 'Max entries (default 50)', ref: 'Ref to read (default HEAD)',
    }),

    // ---- lmprobe-style structured reads (byte-preserving) ----
    schemaOp(
      'lm_status',
      'read',
      'Structured status (porcelain v1, byte-preserving, independent index/worktree)',
      LM_STATUS_SCHEMA,
      async (p) => lmStatus((p['path'] as string) ?? '.', p['ignored'] === true),
    ),
    repoRead('lm_diff', 'Structured unified diff with hunks and byte-preserving content',
      (path, p) => lmDiff(path, p as never) as never,
      { from: 'From revision', to: 'To revision', staged: 'Diff index vs HEAD (cannot combine with `to`)', paths: 'Limit to paths (JSON array)' }),
    repoRead('lm_log', 'Structured commit log with authors/committers/parents',
      (path, p) => lmLog(path, (p['revision'] as string | undefined) ?? 'HEAD', (p['maxCount'] as number | undefined) ?? 20) as never,
      { revision: 'Starting revision (default HEAD)', maxCount: 'Max commits (default 20)' }),
    repoRead('lm_show', 'Show a commit with metadata, or a file from its tree',
      (path, p) => lmShow(path, (p['revision'] as string | undefined) ?? 'HEAD', p['file'] as string | undefined) as never,
      { revision: 'Revision (default HEAD)', file: 'Show this file from the revision instead of the commit metadata' }),
    repoRead('lm_branch', 'Branches with upstream and ahead/behind',
      (path, p) => lmBranch(path, p['all'] === true) as never,
      { all: 'Include remote branches' }),
    repoRead('lm_remote', 'Remotes with credentials redacted from URLs',
      (path) => lmRemote(path) as never),
    repoRead('lm_rev_parse', 'Resolve a revision and peel to commit',
      (path, p) => lmRevParse(path, (p['revision'] as string | undefined) ?? 'HEAD') as never,
      { revision: 'Revision (default HEAD)' }),
    repoRead('lm_ls_files', 'List index entries with mode/stage',
      (path, p) => lmLsFiles(path, (p['paths'] as string[] | undefined) ?? []) as never,
      { paths: 'Limit to paths (JSON array)' }),
    repoRead('lm_blame', 'Per-line blame with author metadata',
      (path, p) => lmBlame(path, p['file'] as string, (p['revision'] as string | undefined) ?? 'HEAD') as never,
      { file: 'File to blame (required)', revision: 'Revision (default HEAD)' }),
  ];
}

async function main(): Promise<number> {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: string };
  return runCli<Git2Ctx>(
    {
      toolName: 'git2',
      version: pkg.version ?? 'unknown',
      description:
        'Structured git CLI via the git binary, with dry-run and read-only policy enforcement.',
      ops: makeOps(),
      buildContext: (policy: Policy): Git2Ctx => ({ git: new Git2({ policy }) }),
      product: {
        name: 'git',
        supported: '>=2.43.0 <3.0.0',
        detect: {
          argv: ['git', '--version'],
          pattern: 'git version (\\d+\\.\\d+\\.\\d+)',
        },
      },
    },
    process.argv.slice(2),
  );
}

void main().then((code) => process.exit(code));
