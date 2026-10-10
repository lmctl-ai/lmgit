/**
 * @fileoverview Unit tests for src/utils: argv construction + allow-list
 * validation, output parsers (porcelain v2 status incl. renames/conflicts,
 * diff --stat, for-each-ref, legacy branch/remote/tag/log parsers), the
 * error mapper, and the executor (cwd pre-flight, env, exit-code handling).
 */

import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import {
  buildGitCommand,
  buildGitEnv,
  validateGitArgs,
} from '../src/utils/command-builder.js';
import {
  extractGitErrorMessage,
  isGitNotFoundError,
  mapGitError,
} from '../src/utils/error-mapper.js';
import { execGitCommandSafe, executeGitCommand } from '../src/utils/git-executor.js';
import {
  GIT_FIELD_DELIMITER as F,
  GIT_RECORD_DELIMITER as R,
  parseBranchRef,
  parseGitBranch,
  parseGitBranchList,
  parseGitDiffStat,
  parseGitLog,
  parseGitRemote,
  parseGitStatus,
  parseGitTag,
  parsePorcelainOutput,
} from '../src/utils/output-parser.js';
import * as utilsBarrel from '../src/utils/index.js';
import { AUTHOR_EMAIL, AUTHOR_NAME, setEnv, useSandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('utils');

// ---------------------------------------------------------------------------
// command-builder
// ---------------------------------------------------------------------------

describe('buildGitCommand', () => {
  test('command only', () => {
    expect(buildGitCommand({ command: 'status' })).toEqual(['status']);
  });
  test('command + args (empty args array is ignored)', () => {
    expect(buildGitCommand({ command: 'log', args: [] })).toEqual(['log']);
    expect(buildGitCommand({ command: 'log', args: ['--oneline', '-n5'] })).toEqual([
      'log',
      '--oneline',
      '-n5',
    ]);
  });
});

describe('buildGitEnv', () => {
  test('forces non-interactive UTF-8 git and keeps PATH', () => {
    const env = buildGitEnv();
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['LC_ALL']).toBe('en_US.UTF-8');
    expect(env['LANG']).toBe('en_US.UTF-8');
    expect(env['PATH']).toBe(process.env['PATH']!);
  });
  test('additional env overrides defaults', () => {
    const env = buildGitEnv({ LC_ALL: 'C', EXTRA_VAR: 'x' });
    expect(env['LC_ALL']).toBe('C');
    expect(env['EXTRA_VAR']).toBe('x');
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
  });
});

describe('validateGitArgs', () => {
  test('accepts positionals, allow-listed long flags, short flags and attached-value shorts', () => {
    expect(() =>
      validateGitArgs([
        'main',
        '--format=%H',
        '--end-of-options',
        '--',
        '-x',
        '-n25',
        '-L3,7',
        '-L3,',
        '--pretty=format:%s',
        '--message=-starts-with-dash',
      ]),
    ).not.toThrow();
  });

  test.each([
    '--upload-pack=touch /tmp/pwned',
    '--config=core.sshCommand=evil',
    '--exec=sh',
    '--receive-pack',
    '-nabc',
    '-Lfoo',
    '--output=/tmp/x',
  ])('rejects unsafe flag %p', (flag) => {
    expect(() => validateGitArgs(['clone', flag])).toThrow(/Unsafe git flag rejected/);
  });

  test('rejects NUL bytes anywhere', () => {
    expect(() => validateGitArgs(['show', 'HEAD\0:evil'])).toThrow(/Null byte/);
  });
});

// ---------------------------------------------------------------------------
// output-parser
// ---------------------------------------------------------------------------

describe('parsePorcelainOutput', () => {
  test('splits records and fields with default control delimiters', () => {
    const out = `a${F}b${F}c${R}\nd${F}e${R}  ${R}`;
    expect(parsePorcelainOutput(out)).toEqual([
      ['a', 'b', 'c'],
      ['d', 'e'],
    ]);
  });
  test('custom delimiters', () => {
    expect(parsePorcelainOutput('1,2;3,4;', ',', ';')).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });
});

describe('parseGitStatus (porcelain v2)', () => {
  const H = '0000000000000000000000000000000000000000';
  test('headers only => clean, with upstream and ahead/behind', () => {
    const s = parseGitStatus(
      ['# branch.oid abc', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +3 -1', ''].join('\n'),
    );
    expect(s.currentBranch).toBe('main');
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(3);
    expect(s.behind).toBe(1);
    expect(s.isClean).toBe(true);
  });

  test('detached head maps to null; non-numeric ab ignored', () => {
    const s = parseGitStatus('# branch.head (detached)\n# branch.ab +x -y\n');
    expect(s.currentBranch).toBeNull();
    expect(s.ahead).toBeUndefined();
    expect(s.behind).toBeUndefined();
  });

  test('ordinary entries: every staged/unstaged code, paths with spaces', () => {
    const line = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${H} ${H} ${path}`;
    const s = parseGitStatus(
      [
        '# branch.head main',
        line('A.', 'added file.txt'),
        line('M.', 'mod.txt'),
        line('D.', 'gone.txt'),
        line('R.', 'r.txt'),
        line('C.', 'c.txt'),
        line('.M', 'wt mod.txt'),
        line('.D', 'wt-gone.txt'),
        line('MM', 'both.txt'),
      ].join('\n'),
    );
    expect(s.isClean).toBe(false);
    expect(s.stagedChanges.added).toEqual(['added file.txt']);
    expect(s.stagedChanges.modified).toEqual(['mod.txt', 'both.txt']);
    expect(s.stagedChanges.deleted).toEqual(['gone.txt']);
    expect(s.stagedChanges.renamed).toEqual(['r.txt']);
    expect(s.stagedChanges.copied).toEqual(['c.txt']);
    expect(s.unstagedChanges.modified).toEqual(['wt mod.txt', 'both.txt']);
    expect(s.unstagedChanges.deleted).toEqual(['wt-gone.txt']);
  });

  const two = (xy: string, score: string, path: string, orig: string) =>
    `2 ${xy} N... 100644 100644 100644 ${H} ${H} ${score} ${path}\t${orig}`;
  const renameFixture = [
    two('R.', 'R100', 'new name.txt', 'old name.txt'),
    two('C.', 'C75', 'copy.txt', 'src.txt'),
    two('RM', 'R90', 'moved.txt', 'orig.txt'),
    two('RD', 'R90', 'moved2.txt', 'orig2.txt'),
    two('.R', 'R90', 'wt-renamed.txt', 'wt-orig.txt'),
  ].join('\n');

  // KNOWN BUG (src/utils/output-parser.ts parseGitStatus, type-2 branch):
  // in non -z porcelain v2 the line is "... <score> <path>\t<origPath>", but
  // the parser only looks at the text *after* the tab, so it sees the orig
  // path as "newPath" and has no oldPath. Expected-correct behaviour below.
  test.failing('rename/copy entries report "old -> new" (currently broken)', () => {
    const s = parseGitStatus(renameFixture);
    expect(s.stagedChanges.renamed).toEqual([
      'old name.txt -> new name.txt',
      'orig.txt -> moved.txt',
      'orig2.txt -> moved2.txt',
    ]);
  });

  test('rename/copy entries: current (buggy) behaviour is pinned', () => {
    const s = parseGitStatus(renameFixture);
    expect(s.stagedChanges.renamed).toEqual([
      'undefined -> old name.txt',
      'undefined -> orig.txt',
      'undefined -> orig2.txt',
    ]);
    expect(s.stagedChanges.copied).toEqual(['undefined -> src.txt']);
    expect(s.unstagedChanges.modified).toEqual(['orig.txt', 'wt-orig.txt']);
    expect(s.unstagedChanges.deleted).toEqual(['orig2.txt']);
  });

  test('rename entry without a tab still parses without throwing', () => {
    const s = parseGitStatus(`2 R. N... 100644 100644 100644 ${H} ${H} R100 broken`);
    expect(s.stagedChanges.renamed).toEqual(['undefined -> ']);
  });

  test('unmerged, untracked and unknown entries', () => {
    const s = parseGitStatus(
      [
        `u UU N... 100644 100644 100644 100644 ${H} ${H} ${H} conflict file.txt`,
        '? new file.txt',
        '! ignored.log',
      ].join('\n'),
    );
    expect(s.conflictedFiles).toEqual(['conflict file.txt']);
    expect(s.untrackedFiles).toEqual(['new file.txt']);
    expect(s.isClean).toBe(false);
  });

  test('empty output is clean with no branch', () => {
    const s = parseGitStatus('');
    expect(s).toMatchObject({ currentBranch: null, isClean: true, untrackedFiles: [] });
  });
});

describe('parseGitLog', () => {
  test('parses 5-field records and skips short ones', () => {
    const out = `h1${F}Ann${F}a@x${F}2024${F}subject one${R}\nh2${F}Bob${F}b@x${F}2023${F}two${R}short${F}rec${R}`;
    expect(parseGitLog(out)).toEqual([
      { hash: 'h1', authorName: 'Ann', authorEmail: 'a@x', date: '2024', subject: 'subject one' },
      { hash: 'h2', authorName: 'Bob', authorEmail: 'b@x', date: '2023', subject: 'two' },
    ]);
  });
  test('empty fields default to empty strings', () => {
    expect(parseGitLog(`${F}${F}${F}${F}x${R}`)).toEqual([
      { hash: '', authorName: '', authorEmail: '', date: '', subject: 'x' },
    ]);
  });
});

describe('parseGitDiffStat', () => {
  test('per-file symbols plus summary totals override', () => {
    const out = [
      ' src/a.ts | 4 +++-',
      ' docs/file with space.md | 2 --',
      ' 2 files changed, 30 insertions(+), 12 deletions(-)',
    ].join('\n');
    const r = parseGitDiffStat(out);
    expect(r.files).toEqual([
      { path: 'src/a.ts', additions: 3, deletions: 1 },
      { path: 'docs/file with space.md', additions: 0, deletions: 2 },
    ]);
    expect(r.totalAdditions).toBe(30);
    expect(r.totalDeletions).toBe(12);
  });
  test('summary with only insertions or only deletions', () => {
    expect(parseGitDiffStat(' a | 1 +\n 1 file changed, 1 insertion(+)\n')).toMatchObject({
      totalAdditions: 1,
      totalDeletions: 0,
    });
    expect(parseGitDiffStat(' a | 2 --\n 1 file changed, 2 deletions(-)\n')).toMatchObject({
      totalAdditions: 0,
      totalDeletions: 2,
    });
  });
  test('summary without counts keeps symbol totals; empty input', () => {
    expect(parseGitDiffStat(' a | 2 ++\n 1 file changed\n')).toMatchObject({ totalAdditions: 2 });
    expect(parseGitDiffStat('')).toEqual({ files: [], totalAdditions: 0, totalDeletions: 0 });
  });
});

describe('parseGitBranch / parseGitRemote / parseGitTag', () => {
  test('parseGitBranch handles current marker and symbolic upstream arrows', () => {
    expect(parseGitBranch('* main\n  dev\n  remotes/origin/HEAD -> origin/main\n\n')).toEqual([
      { name: 'main', current: true },
      { name: 'dev', current: false },
      { name: 'remotes/origin/HEAD', current: false, upstream: 'origin/main' },
    ]);
  });
  test('parseGitRemote parses -v output and skips junk', () => {
    expect(
      parseGitRemote('origin\thttps://h/r.git (fetch)\norigin\thttps://h/p.git (push)\ngarbage\n'),
    ).toEqual([
      { name: 'origin', url: 'https://h/r.git', type: 'fetch' },
      { name: 'origin', url: 'https://h/p.git', type: 'push' },
    ]);
  });
  test('parseGitTag drops blank lines', () => {
    expect(parseGitTag('v1\n\nv2\n')).toEqual(['v1', 'v2']);
  });
});

describe('parseBranchRef', () => {
  test('local + remote refs, tracking info, current marker; skips empty refname', () => {
    const out = [
      ['refs/heads/main', 'aaa', 'origin/main', '[ahead 2, behind 1]', '*'].join(F),
      ['refs/heads/feature', 'bbb', '', '', ' '].join(F),
      ['refs/heads/ahead-only', 'ccc', 'origin/x', '[ahead 5]', ''].join(F),
      ['refs/remotes/origin/main', 'ddd', '', '', ''].join(F),
      ['', 'eee'].join(F),
    ].join('\n');
    expect(parseBranchRef(out)).toEqual([
      { name: 'main', commitHash: 'aaa', current: true, ahead: 2, behind: 1, upstream: 'origin/main' },
      { name: 'feature', commitHash: 'bbb', current: false, ahead: 0, behind: 0 },
      { name: 'ahead-only', commitHash: 'ccc', current: false, ahead: 5, behind: 0, upstream: 'origin/x' },
      { name: 'origin/main', commitHash: 'ddd', current: false, ahead: 0, behind: 0 },
    ]);
  });
  test('missing objectname defaults to empty string', () => {
    expect(parseBranchRef('refs/heads/x')).toEqual([
      { name: 'x', commitHash: '', current: false, ahead: 0, behind: 0 },
    ]);
  });
});

describe('parseGitBranchList (deprecated -v parser)', () => {
  test('parses tracking with and without ahead/behind', () => {
    const out = [
      '* main    1111111 [origin/main: ahead 1, behind 2] msg',
      '  dev     2222222 [origin/dev] msg',
      '  lone    3333333 msg',
      '',
    ].join('\n');
    expect(parseGitBranchList(out)).toEqual([
      { name: 'main', current: true, commitHash: '1111111', upstream: 'origin/main', ahead: 1, behind: 2 },
      { name: 'dev', current: false, commitHash: '2222222', upstream: 'origin/dev' },
      { name: 'lone', current: false, commitHash: '3333333' },
    ]);
  });
  test('status without counts yields zeros; odd lines degrade gracefully', () => {
    expect(parseGitBranchList('  x 4444 [origin/x: gone]')).toEqual([
      { name: 'x', current: false, commitHash: '4444', upstream: 'origin/x', ahead: 0, behind: 0 },
    ]);
    expect(parseGitBranchList('* ')).toEqual([{ name: '', current: true, commitHash: '' }]);
    expect(parseGitBranchList('*  [: ahead 1]')).toEqual([
      { name: '[:', current: true, commitHash: 'ahead', ahead: 1, behind: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// error-mapper
// ---------------------------------------------------------------------------

describe('mapGitError', () => {
  test('passes CliError through untouched', () => {
    const e = new CliError(ErrorCode.NotFound, 'x');
    expect(mapGitError(e, 'op')).toBe(e);
  });

  test.each([
    ['fatal: not a git repository (or any of the parent directories): .git', ErrorCode.InvalidRequest],
    ["remote: Repository 'x' not found", ErrorCode.InvalidRequest],
    ['fatal: could not create work tree dir: Permission denied', ErrorCode.InternalError],
    ['spawn EACCES', ErrorCode.InternalError],
    ['error: open("x"): No such file or directory', ErrorCode.InvalidRequest],
    ['CONFLICT (content): Merge conflict in a.txt', ErrorCode.InvalidRequest],
    ['error: cannot pull with rebase: You have unstaged changes.', ErrorCode.InvalidRequest],
    ['error: Your local changes would be overwritten by checkout', ErrorCode.InvalidRequest],
    ['error: failed to merge in the changes.', ErrorCode.InvalidRequest],
    ['fatal: Could not read from remote repository.', ErrorCode.InternalError],
    ['fatal: unable to access: Failed to connect to host', ErrorCode.InternalError],
    ["fatal: Authentication failed for 'https://h/'", ErrorCode.InvalidRequest],
    ["fatal: remote origin does not exist", ErrorCode.InvalidRequest],
    ['fatal: network is unreachable', ErrorCode.InternalError],
    ['ssh: connection refused', ErrorCode.InternalError],
    ['operation timeout', ErrorCode.InternalError],
    ['nothing to commit, working tree clean', ErrorCode.InvalidRequest],
    ['no changes added to commit (use "git add")', ErrorCode.InvalidRequest],
    ['fatal: reference is not a tree: deadbeef', ErrorCode.InvalidRequest],
    ["fatal: ambiguous argument 'nope'", ErrorCode.InvalidRequest],
    ['fatal: bad revision: unknown revision nope', ErrorCode.InvalidRequest],
  ])('maps %p -> %p', (message, code) => {
    const mapped = mapGitError(new Error(message), 'op');
    expect(mapped).toBeInstanceOf(CliError);
    expect(mapped.code).toBe(code);
    expect(mapped.message).toContain('Git op failed:');
    // NB: the mapper passes { cause } as CliError *data* (3rd arg), not as
    // ErrorOptions, so the original error lands in data.cause.
    expect(mapped.data?.['cause']).toBeInstanceOf(Error);
  });

  test('message transforms for pathspec / branch errors', () => {
    expect(mapGitError(new Error("fatal: pathspec 'nope.txt' did not match any files"), 'add').message).toBe(
      'File not found: nope.txt',
    );
    expect(mapGitError(new Error("fatal: a branch named 'x' already exists... branch 'x' already exists"), 'b').message).toBe(
      'Branch already exists: x',
    );
    expect(mapGitError(new Error("error: branch 'gone' not found."), 'b').message).toBe('Branch not found: gone');
  });

  test('git binary missing', () => {
    for (const msg of ['spawn git ENOENT', 'Executable not found in $PATH: "git"', 'git: command not found']) {
      const mapped = mapGitError(new Error(msg), 'status');
      expect(mapped.code).toBe(ErrorCode.InternalError);
      expect(mapped.message).toMatch(/Git command not found/);
    }
  });

  test('default mapping, including non-Error values (no cause)', () => {
    const m1 = mapGitError(new Error('something odd'), 'log');
    expect(m1.code).toBe(ErrorCode.InternalError);
    expect(m1.message).toBe('Git log failed: something odd');
    const m2 = mapGitError('plain string', 'log');
    expect(m2.message).toBe('Git log failed: plain string');
    expect(m2.data?.['cause']).toBeUndefined();
    expect(mapGitError('fatal: not a git repository', 'x').data?.['cause']).toBeUndefined();
    expect(mapGitError('git ENOENT', 'x').data?.['cause']).toBeUndefined();
  });
});

describe('isGitNotFoundError / extractGitErrorMessage', () => {
  test('isGitNotFoundError', () => {
    expect(isGitNotFoundError(new Error('spawn git ENOENT'))).toBe(true);
    expect(isGitNotFoundError('git: command not found')).toBe(true);
    expect(isGitNotFoundError('git not found')).toBe(true);
    expect(isGitNotFoundError(new Error('file not found'))).toBe(false);
    expect(isGitNotFoundError('git exploded')).toBe(false);
  });
  test('extractGitErrorMessage strips prefixes and keeps the first line', () => {
    expect(extractGitErrorMessage('fatal: bad thing\nerror: second\n')).toBe('bad thing');
    expect(extractGitErrorMessage('\n\nwarning: careful\n')).toBe('careful');
    expect(extractGitErrorMessage('')).toBe('');
  });
});

test('sandbox helper: git() throws on failure unless allowFail', () => {
  expect(() => sandbox().git(sandbox().root, ['no-such-subcommand'])).toThrow(/failed/);
  expect(sandbox().git(sandbox().root, ['no-such-subcommand'], { allowFail: true }).status).not.toBe(0);
});

test('utils barrel re-exports every module', () => {
  expect(typeof utilsBarrel.buildGitCommand).toBe('function');
  expect(typeof utilsBarrel.mapGitError).toBe('function');
  expect(typeof utilsBarrel.executeGitCommand).toBe('function');
  expect(typeof utilsBarrel.parseGitStatus).toBe('function');
});

// ---------------------------------------------------------------------------
// git-executor (real git in the sandbox)
// ---------------------------------------------------------------------------

describe('executeGitCommand', () => {
  test('runs git and returns stdout/stderr/exitCode', async () => {
    const res = await executeGitCommand(['--version'], sandbox().root);
    expect(res.stdout).toMatch(/^git version \d+\.\d+/);
    expect(res.exitCode).toBe(0);
  });

  test('passes the (isolated) process env through to git', async () => {
    const repo = sandbox().repo('exec-env');
    const res = await executeGitCommand(['var', 'GIT_AUTHOR_IDENT'], repo);
    expect(res.stdout).toContain(`${AUTHOR_NAME} <${AUTHOR_EMAIL}>`);
  });

  test('missing cwd => INVALID_REQUEST (not "git not found")', async () => {
    const missing = join(sandbox().root, 'does-not-exist');
    const err = await executeGitCommand(['status'], missing).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).code).toBe(ErrorCode.InvalidRequest);
    expect((err as CliError).message).toContain('Working directory does not exist');
  });

  test('cwd that is a file => INVALID_REQUEST', async () => {
    const file = join(sandbox().dir('exec-file'), 'f.txt');
    writeFileSync(file, 'x');
    await expect(executeGitCommand(['status'], file)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('not a directory'),
    });
  });

  test('unsafe flag is rejected before spawning', async () => {
    await expect(
      executeGitCommand(['ls-remote', '--upload-pack=touch pwned', 'x'], sandbox().root),
    ).rejects.toMatchObject({ code: ErrorCode.InternalError, message: expect.stringContaining('Unsafe git flag') });
  });

  test('non-zero exit throws mapped error; allowNonZeroExit returns the code', async () => {
    const repo = sandbox().repo('exec-fail');
    await expect(executeGitCommand(['show', 'no-such-ref'], repo)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('unknown revision'),
    });
    const soft = await executeGitCommand(['show', 'no-such-ref'], repo, { allowNonZeroExit: true });
    expect(soft.exitCode).toBe(128);
    const safe = await execGitCommandSafe(['rev-parse', '--verify', 'nope'], repo);
    expect(safe.exitCode).not.toBe(0);
  });

  test('not a git repository => INVALID_REQUEST', async () => {
    const plain = sandbox().dir('exec-plain');
    await expect(executeGitCommand(['status'], plain)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('not a git repository'),
    });
  });

  test('git binary missing from PATH maps to INTERNAL_ERROR', async () => {
    const emptyBin = sandbox().dir('empty-bin');
    const restore = setEnv({ PATH: emptyBin });
    try {
      const err = await executeGitCommand(['--version'], sandbox().root).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).code).toBe(ErrorCode.InternalError);
    } finally {
      restore();
    }
  });
});
