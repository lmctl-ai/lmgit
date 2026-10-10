/**
 * @fileoverview Declarative input schemas for all git2 operations.
 * @module git2/schemas
 */

import type { OperationSchema } from '@lmctl-ai/lmts';

const pathParam = {
  name: 'path',
  type: 'string' as const,
  occurs: '?' as const,
  default: '.',
  description: 'Working directory (defaults to process.cwd())',
};

const repoParam = {
  name: 'repo',
  type: 'string' as const,
  occurs: '?' as const,
  description: 'Working directory (repo)',
};

// ---------------------------------------------------------------------------
// lmprobe-style structured reads
// ---------------------------------------------------------------------------

export const LM_STATUS_SCHEMA: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  description: 'Structured git status (porcelain v1, byte-preserving paths)',
  params: [
    pathParam,
    {
      name: 'ignored',
      type: 'boolean',
      occurs: '?',
      default: false,
      description: 'Include ignored files',
    },
  ],
};

export const LM_DIFF_SCHEMA: OperationSchema = {
  name: 'lm_diff',
  access: 'read',
  description: 'Structured unified diff with hunks and byte-preserving content',
  params: [
    pathParam,
    { name: 'from', type: 'string', occurs: '?', description: 'From revision' },
    { name: 'to', type: 'string', occurs: '?', description: 'To revision' },
    {
      name: 'staged',
      type: 'boolean',
      occurs: '?',
      description: 'Diff index vs HEAD (cannot combine with `to`)',
    },
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Limit to paths',
    },
  ],
};

export const LM_LOG_SCHEMA: OperationSchema = {
  name: 'lm_log',
  access: 'read',
  description: 'Structured commit log with author/committer metadata',
  params: [
    pathParam,
    {
      name: 'revision',
      type: 'string',
      occurs: '?',
      default: 'HEAD',
      description: 'Starting revision (default HEAD)',
    },
    {
      name: 'maxCount',
      type: 'number',
      occurs: '?',
      default: 20,
      description: 'Maximum commits to return (default 20)',
    },
  ],
};

export const LM_SHOW_SCHEMA: OperationSchema = {
  name: 'lm_show',
  access: 'read',
  description: 'Show a commit with metadata, or a file from its tree',
  params: [
    pathParam,
    {
      name: 'revision',
      type: 'string',
      occurs: '?',
      default: 'HEAD',
      description: 'Revision (default HEAD)',
    },
    {
      name: 'file',
      type: 'string',
      occurs: '?',
      description: 'Show this file from the revision instead of the commit metadata',
    },
  ],
};

export const LM_BRANCH_SCHEMA: OperationSchema = {
  name: 'lm_branch',
  access: 'read',
  description: 'Branches with upstream and ahead/behind',
  params: [
    pathParam,
    {
      name: 'all',
      type: 'boolean',
      occurs: '?',
      default: false,
      description: 'Include remote branches',
    },
  ],
};

export const LM_REMOTE_SCHEMA: OperationSchema = {
  name: 'lm_remote',
  access: 'read',
  description: 'Remotes with credentials redacted from URLs',
  params: [pathParam],
};

export const LM_REV_PARSE_SCHEMA: OperationSchema = {
  name: 'lm_rev_parse',
  access: 'read',
  description: 'Resolve a revision and peel to commit',
  params: [
    pathParam,
    {
      name: 'revision',
      type: 'string',
      occurs: '?',
      default: 'HEAD',
      description: 'Revision (default HEAD)',
    },
  ],
};

export const LM_LS_FILES_SCHEMA: OperationSchema = {
  name: 'lm_ls_files',
  access: 'read',
  description: 'List index entries with mode/stage',
  params: [
    pathParam,
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Limit to paths',
    },
  ],
};

export const LM_BLAME_SCHEMA: OperationSchema = {
  name: 'lm_blame',
  access: 'read',
  description: 'Per-line blame with author metadata',
  params: [
    pathParam,
    {
      name: 'file',
      type: 'string',
      description: 'File to blame (required)',
    },
    {
      name: 'revision',
      type: 'string',
      occurs: '?',
      default: 'HEAD',
      description: 'Revision to attribute against',
    },
  ],
};

// ---------------------------------------------------------------------------
// Standard git operations
// ---------------------------------------------------------------------------

export const INIT_SCHEMA: OperationSchema = {
  name: 'init',
  access: 'write',
  description: 'Initialize a new git repository',
  params: [
    {
      name: 'path',
      type: 'string',
      occurs: '?',
      description: 'Directory to initialize (created if needed)',
    },
    {
      name: 'initialBranch',
      type: 'string',
      occurs: '?',
      description: 'Initial branch name (default: main)',
    },
    {
      name: 'bare',
      type: 'boolean',
      occurs: '?',
      description: 'Create a bare repository',
    },
  ],
};

export const CLONE_SCHEMA: OperationSchema = {
  name: 'clone',
  access: 'write',
  description: 'Clone a remote repository',
  params: [
    { name: 'remoteUrl', type: 'string', description: 'Remote repository URL' },
    { name: 'localPath', type: 'string', description: 'Local path for the clone' },
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch to checkout' },
    { name: 'depth', type: 'number', occurs: '?', description: 'Shallow clone depth' },
    { name: 'bare', type: 'boolean', occurs: '?', description: 'Clone as bare repository' },
    { name: 'mirror', type: 'boolean', occurs: '?', description: 'Clone as mirror (implies bare)' },
  ],
};

export const STATUS_SCHEMA: OperationSchema = {
  name: 'status',
  access: 'read',
  description: 'Show working tree status',
  params: [
    pathParam,
    {
      name: 'includeUntracked',
      type: 'boolean',
      occurs: '?',
      description: 'Include untracked files (default true)',
    },
    {
      name: 'ignoreSubmodules',
      type: 'boolean',
      occurs: '?',
      description: 'Ignore submodules',
    },
  ],
};

export const CLEAN_SCHEMA: OperationSchema = {
  name: 'clean',
  access: 'write',
  description: 'Remove untracked files / directories',
  params: [
    pathParam,
    { name: 'force', type: 'boolean', occurs: '?', description: 'Actually delete (git -f)' },
    {
      name: 'dryRun',
      type: 'boolean',
      occurs: '?',
      description: "git's own -n: show what would be removed",
    },
    {
      name: 'directories',
      type: 'boolean',
      occurs: '?',
      description: 'Include untracked directories (git -d)',
    },
    {
      name: 'ignored',
      type: 'boolean',
      occurs: '?',
      description: 'Include ignored files (git -x)',
    },
  ],
};

export const ADD_SCHEMA: OperationSchema = {
  name: 'add',
  access: 'write',
  description: 'Stage files',
  params: [
    pathParam,
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Array of paths to stage',
    },
    { name: 'all', type: 'boolean', occurs: '?', description: 'Stage all changes' },
    { name: 'update', type: 'boolean', occurs: '?', description: 'Update tracked files only' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force add ignored files' },
  ],
};

export const RESET_SCHEMA: OperationSchema = {
  name: 'reset',
  access: 'write',
  description: 'Reset HEAD / unstage paths',
  params: [
    pathParam,
    {
      name: 'mode',
      type: 'string',
      occurs: '?',
      enum: ['soft', 'mixed', 'hard', 'merge', 'keep'],
      description: 'Reset mode (soft|mixed|hard|merge|keep)',
    },
    { name: 'commit', type: 'string', occurs: '?', description: 'Commit to reset to' },
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Paths to unstage',
    },
  ],
};

export const COMMIT_SCHEMA: OperationSchema = {
  name: 'commit',
  access: 'write',
  description: 'Create a commit',
  params: [
    pathParam,
    { name: 'message', type: 'string', description: 'Commit message' },
    { name: 'amend', type: 'boolean', occurs: '?', description: 'Amend previous commit' },
    { name: 'allowEmpty', type: 'boolean', occurs: '?', description: 'Allow empty commit' },
    { name: 'noVerify', type: 'boolean', occurs: '?', description: 'Skip hooks' },
    { name: 'author', type: 'object', occurs: '?', description: 'Author {name,email} object' },
  ],
};

export const LOG_SCHEMA: OperationSchema = {
  name: 'log',
  access: 'read',
  description: 'Commit history',
  params: [
    pathParam,
    { name: 'maxCount', type: 'number', occurs: '?', description: 'Maximum commits (default 10)' },
    { name: 'skip', type: 'number', occurs: '?', description: 'Commits to skip' },
    { name: 'author', type: 'string', occurs: '?', description: 'Filter by author' },
    { name: 'since', type: 'string', occurs: '?', description: 'Filter by date (from)' },
    { name: 'until', type: 'string', occurs: '?', description: 'Filter by date (until)' },
    { name: 'grep', type: 'string', occurs: '?', description: 'Filter by message' },
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch/ref to read' },
    { name: 'file', type: 'string', occurs: '?', description: 'Filter by file' },
    { name: 'follow', type: 'boolean', occurs: '?', description: 'Follow file renames' },
  ],
};

export const SHOW_SCHEMA: OperationSchema = {
  name: 'show',
  access: 'read',
  description: 'Show a git object (commit, tree, blob, tag)',
  params: [
    pathParam,
    { name: 'object', type: 'string', description: 'Object to show' },
    { name: 'format', type: 'string', occurs: '?', description: "'raw' for raw output" },
    { name: 'stat', type: 'boolean', occurs: '?', description: 'Include diffstat' },
    { name: 'filePath', type: 'string', occurs: '?', description: 'View specific file at the ref' },
  ],
};

export const DIFF_SCHEMA: OperationSchema = {
  name: 'diff',
  access: 'read',
  description: 'Show diffs',
  params: [
    pathParam,
    { name: 'commit1', type: 'string', occurs: '?', description: 'First commit (default HEAD)' },
    {
      name: 'commit2',
      type: 'string',
      occurs: '?',
      description: 'Second commit (default working tree)',
    },
    { name: 'staged', type: 'boolean', occurs: '?', description: 'Diff staged changes' },
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Limit diff to paths',
    },
    { name: 'unified', type: 'number', occurs: '?', description: 'Context lines' },
    {
      name: 'includeUntracked',
      type: 'boolean',
      occurs: '?',
      description: 'Diff untracked files too',
    },
    { name: 'stat', type: 'boolean', occurs: '?', description: 'Summary only (diffstat)' },
    { name: 'nameOnly', type: 'boolean', occurs: '?', description: 'Show only changed file names' },
    {
      name: 'excludePatterns',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Patterns to exclude (e.g. lock files)',
    },
  ],
};

export const BRANCH_LIST_SCHEMA: OperationSchema = {
  name: 'branch_list',
  access: 'read',
  description: 'List branches',
  params: [
    pathParam,
    { name: 'remote', type: 'boolean', occurs: '?', description: 'Remote only' },
    { name: 'all', type: 'boolean', occurs: '?', description: 'Local+remote' },
    { name: 'merged', type: 'boolean', occurs: '?', description: 'Filter merged' },
    { name: 'noMerged', type: 'boolean', occurs: '?', description: 'Filter not-merged' },
    { name: 'limit', type: 'number', occurs: '?', description: 'Cap results' },
  ],
};

export const BRANCH_CURRENT_SCHEMA: OperationSchema = {
  name: 'branch_current',
  access: 'read',
  description: 'Show current branch',
  params: [pathParam],
};

export const BRANCH_CREATE_SCHEMA: OperationSchema = {
  name: 'branch_create',
  access: 'write',
  description: 'Create a branch',
  params: [
    pathParam,
    { name: 'branchName', type: 'string', description: 'New branch name' },
    { name: 'startPoint', type: 'string', occurs: '?', description: 'Start point' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Overwrite existing' },
  ],
};

export const BRANCH_DELETE_SCHEMA: OperationSchema = {
  name: 'branch_delete',
  access: 'write',
  description: 'Delete a branch',
  params: [
    pathParam,
    { name: 'branchName', type: 'string', description: 'Branch to delete' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force delete (-D)' },
  ],
};

export const BRANCH_RENAME_SCHEMA: OperationSchema = {
  name: 'branch_rename',
  access: 'write',
  description: 'Rename a branch',
  params: [
    pathParam,
    { name: 'branchName', type: 'string', description: 'Current name' },
    { name: 'newBranchName', type: 'string', description: 'New name' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force' },
  ],
};

export const CHECKOUT_SCHEMA: OperationSchema = {
  name: 'checkout',
  access: 'write',
  description: 'Checkout a branch/commit/paths',
  params: [
    pathParam,
    { name: 'target', type: 'string', positional: true, description: 'Branch/commit to checkout' },
    { name: 'createBranch', type: 'boolean', occurs: '?', description: 'Create new branch' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Discard changes' },
    {
      name: 'paths',
      type: 'array',
      items: 'string',
      occurs: '*',
      description: 'Checkout specific paths',
    },
    { name: 'track', type: 'boolean', occurs: '?', description: 'Set upstream tracking' },
  ],
};

export const MERGE_SCHEMA: OperationSchema = {
  name: 'merge',
  access: 'write',
  description: 'Merge a branch',
  params: [
    pathParam,
    { name: 'branch', type: 'string', description: 'Branch to merge' },
    { name: 'strategy', type: 'string', occurs: '?', description: 'Merge strategy' },
    { name: 'noFastForward', type: 'boolean', occurs: '?', description: 'No fast-forward' },
    { name: 'squash', type: 'boolean', occurs: '?', description: 'Squash' },
    { name: 'message', type: 'string', occurs: '?', description: 'Merge message' },
    { name: 'abort', type: 'boolean', occurs: '?', description: 'Abort in-progress merge' },
  ],
};

export const REBASE_SCHEMA: OperationSchema = {
  name: 'rebase',
  access: 'write',
  description: 'Rebase current branch',
  params: [
    pathParam,
    { name: 'branch', type: 'string', description: 'Upstream branch' },
    { name: 'onto', type: 'string', occurs: '?', description: 'Rebase onto' },
    { name: 'interactive', type: 'boolean', occurs: '?', description: 'Interactive' },
    { name: 'abort', type: 'boolean', occurs: '?', description: 'Abort in-progress rebase' },
    { name: 'continueOp', type: 'boolean', occurs: '?', description: 'Continue' },
    { name: 'preserveMerges', type: 'boolean', occurs: '?', description: 'Preserve merges' },
  ],
};

export const CHERRY_PICK_SCHEMA: OperationSchema = {
  name: 'cherry_pick',
  access: 'write',
  description: 'Apply commits on top',
  params: [
    pathParam,
    {
      name: 'commits',
      type: 'array',
      items: 'string',
      occurs: '+',
      description: 'Commits to pick (array)',
    },
    { name: 'noCommit', type: 'boolean', occurs: '?', description: 'Apply without committing' },
    { name: 'mainline', type: 'number', occurs: '?', description: 'Parent number for merges' },
    { name: 'strategy', type: 'string', occurs: '?', description: 'Merge strategy' },
    { name: 'signoff', type: 'boolean', occurs: '?', description: 'Add Signed-off-by' },
  ],
};

export const REMOTE_LIST_SCHEMA: OperationSchema = {
  name: 'remote_list',
  access: 'read',
  description: 'List remotes',
  params: [pathParam],
};

export const REMOTE_GET_URL_SCHEMA: OperationSchema = {
  name: 'remote_get_url',
  access: 'read',
  description: 'Get remote URL',
  params: [
    pathParam,
    { name: 'name', type: 'string', description: 'Remote name' },
  ],
};

export const REMOTE_ADD_SCHEMA: OperationSchema = {
  name: 'remote_add',
  access: 'write',
  description: 'Add a remote',
  params: [
    pathParam,
    { name: 'name', type: 'string', description: 'Remote name' },
    { name: 'url', type: 'string', description: 'Remote URL' },
  ],
};

export const REMOTE_REMOVE_SCHEMA: OperationSchema = {
  name: 'remote_remove',
  access: 'write',
  description: 'Remove a remote',
  params: [
    pathParam,
    { name: 'name', type: 'string', description: 'Remote name' },
  ],
};

export const REMOTE_SET_URL_SCHEMA: OperationSchema = {
  name: 'remote_set_url',
  access: 'write',
  description: 'Set remote URL',
  params: [
    pathParam,
    { name: 'name', type: 'string', description: 'Remote name' },
    { name: 'url', type: 'string', description: 'New URL' },
    { name: 'push', type: 'boolean', occurs: '?', description: 'Set push URL separately' },
  ],
};

export const FETCH_SCHEMA: OperationSchema = {
  name: 'fetch',
  access: 'write',
  description: 'Fetch from a remote',
  params: [
    pathParam,
    { name: 'remote', type: 'string', occurs: '?', description: 'Remote (default origin)' },
    { name: 'prune', type: 'boolean', occurs: '?', description: 'Prune stale refs' },
    { name: 'tags', type: 'boolean', occurs: '?', description: 'Fetch tags' },
    { name: 'depth', type: 'number', occurs: '?', description: 'Shallow fetch depth' },
  ],
};

export const PUSH_SCHEMA: OperationSchema = {
  name: 'push',
  access: 'write',
  description: 'Push to a remote',
  params: [
    pathParam,
    { name: 'remote', type: 'string', occurs: '?', description: 'Remote (default origin)' },
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch (default current)' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force push' },
    { name: 'forceWithLease', type: 'boolean', occurs: '?', description: 'Safer force push' },
    { name: 'setUpstream', type: 'boolean', occurs: '?', description: 'Set upstream' },
    { name: 'tags', type: 'boolean', occurs: '?', description: 'Push tags' },
    { name: 'delete', type: 'boolean', occurs: '?', description: 'Delete remote branch' },
    { name: 'dryRun', type: 'boolean', occurs: '?', description: "git's own --dry-run" },
  ],
};

export const PULL_SCHEMA: OperationSchema = {
  name: 'pull',
  access: 'write',
  description: 'Pull from a remote',
  params: [
    pathParam,
    { name: 'remote', type: 'string', occurs: '?', description: 'Remote (default origin)' },
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch (default current)' },
    { name: 'rebase', type: 'boolean', occurs: '?', description: 'Rebase instead of merge' },
    { name: 'ffOnly', type: 'boolean', occurs: '?', description: 'Fast-forward only' },
  ],
};

export const TAG_LIST_SCHEMA: OperationSchema = {
  name: 'tag_list',
  access: 'read',
  description: 'List tags',
  params: [
    pathParam,
    { name: 'limit', type: 'number', occurs: '?', description: 'Cap results' },
  ],
};

export const TAG_VERIFY_SCHEMA: OperationSchema = {
  name: 'tag_verify',
  access: 'read',
  description: 'Verify a tag',
  params: [
    pathParam,
    { name: 'tagName', type: 'string', description: 'Tag name' },
  ],
};

export const TAG_CREATE_SCHEMA: OperationSchema = {
  name: 'tag_create',
  access: 'write',
  description: 'Create a tag',
  params: [
    pathParam,
    { name: 'tagName', type: 'string', description: 'Tag name' },
    { name: 'commit', type: 'string', occurs: '?', description: 'Commit to tag' },
    { name: 'message', type: 'string', occurs: '?', description: 'Annotation message' },
    { name: 'annotated', type: 'boolean', occurs: '?', description: 'Create annotated tag' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Overwrite existing' },
  ],
};

export const TAG_DELETE_SCHEMA: OperationSchema = {
  name: 'tag_delete',
  access: 'write',
  description: 'Delete a tag',
  params: [
    pathParam,
    { name: 'tagName', type: 'string', description: 'Tag name' },
  ],
};

export const STASH_LIST_SCHEMA: OperationSchema = {
  name: 'stash_list',
  access: 'read',
  description: 'List stashes',
  params: [
    pathParam,
    { name: 'limit', type: 'number', occurs: '?', description: 'Cap results' },
  ],
};

export const STASH_PUSH_SCHEMA: OperationSchema = {
  name: 'stash_push',
  access: 'write',
  description: 'Stash changes',
  params: [
    pathParam,
    { name: 'message', type: 'string', occurs: '?', description: 'Stash message' },
    {
      name: 'includeUntracked',
      type: 'boolean',
      occurs: '?',
      description: 'Include untracked files',
    },
    { name: 'keepIndex', type: 'boolean', occurs: '?', description: 'Keep staged changes' },
  ],
};

export const STASH_POP_SCHEMA: OperationSchema = {
  name: 'stash_pop',
  access: 'write',
  description: 'Pop a stash',
  params: [pathParam],
};

export const STASH_APPLY_SCHEMA: OperationSchema = {
  name: 'stash_apply',
  access: 'write',
  description: 'Apply a stash',
  params: [pathParam],
};

export const STASH_DROP_SCHEMA: OperationSchema = {
  name: 'stash_drop',
  access: 'write',
  description: 'Drop a stash',
  params: [
    pathParam,
    { name: 'stashRef', type: 'string', occurs: '?', description: 'Stash ref (e.g. stash@{0})' },
  ],
};

export const STASH_CLEAR_SCHEMA: OperationSchema = {
  name: 'stash_clear',
  access: 'write',
  description: 'Clear all stashes',
  params: [pathParam],
};

export const WORKTREE_LIST_SCHEMA: OperationSchema = {
  name: 'worktree_list',
  access: 'read',
  description: 'List worktrees',
  params: [repoParam],
};

export const WORKTREE_ADD_SCHEMA: OperationSchema = {
  name: 'worktree_add',
  access: 'write',
  description: 'Add a worktree',
  params: [
    repoParam,
    { name: 'path', type: 'string', description: 'Worktree path' },
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch name' },
    { name: 'commitish', type: 'string', occurs: '?', description: 'Commit to checkout' },
    { name: 'detach', type: 'boolean', occurs: '?', description: 'Detached HEAD' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force' },
  ],
};

export const WORKTREE_REMOVE_SCHEMA: OperationSchema = {
  name: 'worktree_remove',
  access: 'write',
  description: 'Remove a worktree',
  params: [
    repoParam,
    { name: 'path', type: 'string', description: 'Worktree path' },
    { name: 'force', type: 'boolean', occurs: '?', description: 'Force' },
  ],
};

export const WORKTREE_PRUNE_SCHEMA: OperationSchema = {
  name: 'worktree_prune',
  access: 'write',
  description: 'Prune stale worktrees',
  params: [
    repoParam,
    {
      name: 'dryRun',
      type: 'boolean',
      occurs: '?',
      description: "git's own --dry-run for prune",
    },
    { name: 'verbose', type: 'boolean', occurs: '?', description: 'Detailed output' },
  ],
};

export const BLAME_SCHEMA: OperationSchema = {
  name: 'blame',
  access: 'read',
  description: 'Blame a file',
  params: [
    pathParam,
    { name: 'file', type: 'string', description: 'File to blame' },
    { name: 'startLine', type: 'number', occurs: '?', description: 'Start line' },
    { name: 'endLine', type: 'number', occurs: '?', description: 'End line' },
    {
      name: 'ignoreWhitespace',
      type: 'boolean',
      occurs: '?',
      description: 'Ignore whitespace',
    },
  ],
};

export const REFLOG_SCHEMA: OperationSchema = {
  name: 'reflog',
  access: 'read',
  description: 'Show reflog',
  params: [
    pathParam,
    { name: 'maxCount', type: 'number', occurs: '?', description: 'Max entries (default 50)' },
    { name: 'ref', type: 'string', occurs: '?', description: 'Ref to read (default HEAD)' },
  ],
};

export const ALL_GIT2_SCHEMAS: OperationSchema[] = [
  INIT_SCHEMA,
  CLONE_SCHEMA,
  STATUS_SCHEMA,
  CLEAN_SCHEMA,
  ADD_SCHEMA,
  RESET_SCHEMA,
  COMMIT_SCHEMA,
  LOG_SCHEMA,
  SHOW_SCHEMA,
  DIFF_SCHEMA,
  BRANCH_LIST_SCHEMA,
  BRANCH_CURRENT_SCHEMA,
  BRANCH_CREATE_SCHEMA,
  BRANCH_DELETE_SCHEMA,
  BRANCH_RENAME_SCHEMA,
  CHECKOUT_SCHEMA,
  MERGE_SCHEMA,
  REBASE_SCHEMA,
  CHERRY_PICK_SCHEMA,
  REMOTE_LIST_SCHEMA,
  REMOTE_GET_URL_SCHEMA,
  REMOTE_ADD_SCHEMA,
  REMOTE_REMOVE_SCHEMA,
  REMOTE_SET_URL_SCHEMA,
  FETCH_SCHEMA,
  PUSH_SCHEMA,
  PULL_SCHEMA,
  TAG_LIST_SCHEMA,
  TAG_VERIFY_SCHEMA,
  TAG_CREATE_SCHEMA,
  TAG_DELETE_SCHEMA,
  STASH_LIST_SCHEMA,
  STASH_PUSH_SCHEMA,
  STASH_POP_SCHEMA,
  STASH_APPLY_SCHEMA,
  STASH_DROP_SCHEMA,
  STASH_CLEAR_SCHEMA,
  WORKTREE_LIST_SCHEMA,
  WORKTREE_ADD_SCHEMA,
  WORKTREE_REMOVE_SCHEMA,
  WORKTREE_PRUNE_SCHEMA,
  BLAME_SCHEMA,
  REFLOG_SCHEMA,
  LM_STATUS_SCHEMA,
  LM_DIFF_SCHEMA,
  LM_LOG_SCHEMA,
  LM_SHOW_SCHEMA,
  LM_BRANCH_SCHEMA,
  LM_REMOTE_SCHEMA,
  LM_REV_PARSE_SCHEMA,
  LM_LS_FILES_SCHEMA,
  LM_BLAME_SCHEMA,
];
