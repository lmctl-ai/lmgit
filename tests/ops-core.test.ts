/**
 * @fileoverview Real-git tests (in temp repos) for the repository, staging,
 * commit and history operations exposed through the Git2 facade: init,
 * clone, status, clean, add, reset, commit (incl. signing fallback), log,
 * show, diff, blame, reflog. Also covers argv construction via a recording
 * exec stub for branches that real git cannot reach deterministically.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import {
  executeClone,
  executeCommit,
  executeDiff,
  executeLog,
  executeShow,
  Git2,
  type GitOperationContext,
} from '../src/index.js';
import { real, stubExec } from './helpers/narrow.js';
import { AUTHOR_NAME, FIXED_EPOCH, setEnv, useSandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('core');
const git = new Git2();
const ctx = (dir: string, signCommits = false): GitOperationContext => ({
  workingDirectory: dir,
  signCommits,
});

// ---------------------------------------------------------------------------
// init / clone
// ---------------------------------------------------------------------------

describe('init', () => {
  test('creates missing directory, default branch main', async () => {
    const target = join(sandbox().root, 'init', 'nested', 'repo');
    const r = real(await git.init({ path: target }));
    expect(r).toEqual({ success: true, path: target, initialBranch: 'main', bare: false });
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(sandbox().git(target, ['symbolic-ref', 'HEAD']).stdout.trim()).toBe('refs/heads/main');
  });

  test('bare repo with custom initial branch', async () => {
    const target = join(sandbox().dir('init-bare'), 'b.git');
    const r = real(await git.init({ path: target, bare: true, initialBranch: 'trunk' }));
    expect(r).toMatchObject({ bare: true, initialBranch: 'trunk' });
    expect(sandbox().git(target, ['rev-parse', '--is-bare-repository']).stdout.trim()).toBe('true');
    expect(sandbox().git(target, ['symbolic-ref', 'HEAD']).stdout.trim()).toBe('refs/heads/trunk');
  });

  test('unusable target (parent is a file): mkdir error is swallowed, cwd check reports it', async () => {
    const file = join(sandbox().dir('init-file'), 'plain-file');
    writeFileSync(file, 'x');
    await expect(git.init({ path: join(file, 'sub') })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining('Working directory does not exist'),
    });
  });

  test('invalid branch name maps to a CliError', async () => {
    const target = sandbox().dir('init-bad');
    await expect(git.init({ path: target, initialBranch: 'bad..name' })).rejects.toBeInstanceOf(CliError);
  });
});

describe('clone (local bare remote)', () => {
  test('clones a file path remote and reports HEAD + branch', async () => {
    const src = sandbox().repo('clone-src', { 'a.txt': 'a\n' });
    sandbox().git(src, ['branch', 'dev']);
    const dest = join(sandbox().dir('clone-dest'), 'copy');
    const r = real(await git.clone({ remoteUrl: src, localPath: dest }));
    expect(r.success).toBe(true);
    expect(r.localPath).toBe(dest);
    expect(r.branch).toBe('main');
    expect(r.commitHash).toBe(sandbox().git(src, ['rev-parse', 'HEAD']).stdout.trim());
    expect(readFileSync(join(dest, 'a.txt'), 'utf-8')).toBe('a\n');
  });

  test('branch + depth (file:// URL)', async () => {
    const src = sandbox().repo('clone-src2', { 'a.txt': 'a\n' });
    sandbox().write(src, 'b.txt', 'b\n');
    sandbox().commitAll(src, 'second');
    sandbox().git(src, ['branch', 'dev']);
    const parent = sandbox().dir('clone-dest2');
    // Absolute localPath only: Git2.clone() uses localPath itself as the
    // context dir, so a relative path would resolve against process.cwd().
    const r = real(
      await git.clone({ remoteUrl: `file://${src}`, localPath: join(parent, 'shallow'), branch: 'dev', depth: 1 }),
    );
    expect(r.branch).toBe('dev');
    const dest = r.localPath;
    expect(sandbox().git(dest, ['rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('true');
  });

  test('bare and mirror clones of an empty repo (no HEAD) still succeed', async () => {
    const empty = sandbox().dir('clone-empty');
    sandbox().git(empty, ['init', '-q', '--bare', '-b', 'main']);
    const out = sandbox().dir('clone-empty-out');
    // Non-bare clone of an empty repo: rev-parse HEAD fails -> no commitHash.
    const plain = real(await git.clone({ remoteUrl: empty, localPath: join(out, 'plain') }));
    expect(plain.commitHash).toBeUndefined();
    expect(plain.branch).toBe('main');
    const bare = real(await git.clone({ remoteUrl: empty, localPath: join(out, 'bare.git'), bare: true }));
    expect(bare.success).toBe(true);
    const mirror = real(await git.clone({ remoteUrl: empty, localPath: join(out, 'mirror.git'), mirror: true }));
    expect(mirror.success).toBe(true);
  });

  test('argv: flags, --end-of-options, then url + absolute path; recurse submodules', async () => {
    const { fn, calls } = stubExec([{}, new Error('no HEAD'), new Error('no HEAD')]);
    const r = await executeClone(
      {
        remoteUrl: '--config=core.sshCommand=evil',
        localPath: 'rel/dir',
        branch: 'b',
        depth: 3,
        bare: true,
        mirror: true,
        recurseSubmodules: true,
      },
      ctx('/work'),
      fn,
    );
    expect(calls[0]!.args).toEqual([
      'clone',
      '--branch',
      'b',
      '--depth',
      '3',
      '--bare',
      '--mirror',
      '--recurse-submodules',
      '--end-of-options',
      '--config=core.sshCommand=evil',
      '/work/rel/dir',
    ]);
    expect(calls[0]!.cwd).toBe('/work/rel');
    expect(r).toEqual({ success: true, localPath: '/work/rel/dir', remoteUrl: '--config=core.sshCommand=evil', branch: 'b' });
  });

  test('missing remote => mapped CliError', async () => {
    const dest = join(sandbox().dir('clone-missing'), 'x');
    await expect(git.clone({ remoteUrl: join(sandbox().root, 'nope.git'), localPath: dest })).rejects.toBeInstanceOf(
      CliError,
    );
  });
});

// ---------------------------------------------------------------------------
// status / clean / add / reset / commit
// ---------------------------------------------------------------------------

describe('status', () => {
  test('clean, then staged/unstaged/untracked with unicode + space names', async () => {
    const repo = sandbox().repo('status', { 'tracked.txt': '1\n', 'del.txt': 'x\n' });
    expect(await git.status(repo)).toMatchObject({ currentBranch: 'main', isClean: true });

    sandbox().write(repo, 'tracked.txt', '2\n');
    sandbox().write(repo, 'new file λ.txt', 'n\n');
    sandbox().write(repo, 'staged.txt', 's\n');
    sandbox().git(repo, ['add', 'staged.txt']);
    sandbox().git(repo, ['rm', '-q', 'del.txt']);
    const s = await git.status(repo);
    expect(s.isClean).toBe(false);
    expect(s.stagedChanges.added).toEqual(['staged.txt']);
    expect(s.stagedChanges.deleted).toEqual(['del.txt']);
    expect(s.unstagedChanges.modified).toEqual(['tracked.txt']);
    expect(s.untrackedFiles.length).toBe(1);

    const noUntracked = await git.status(repo, { includeUntracked: false, ignoreSubmodules: true });
    expect(noUntracked.untrackedFiles).toEqual([]);
  });

  test('conflicted files after a failed merge; detached HEAD', async () => {
    const repo = sandbox().repo('status-conflict', { 'c.txt': 'base\n' });
    sandbox().git(repo, ['checkout', '-q', '-b', 'other']);
    sandbox().write(repo, 'c.txt', 'other\n');
    sandbox().commitAll(repo, 'other');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    sandbox().write(repo, 'c.txt', 'main\n');
    sandbox().commitAll(repo, 'main');
    sandbox().git(repo, ['merge', 'other'], { allowFail: true });
    const s = await git.status(repo);
    expect(s.conflictedFiles).toEqual(['c.txt']);

    sandbox().git(repo, ['merge', '--abort']);
    sandbox().git(repo, ['checkout', '-q', '--detach', 'HEAD']);
    expect((await git.status(repo)).currentBranch).toBeNull();
  });

  test('upstream ahead/behind is reported', async () => {
    const remote = sandbox().repo('status-up-remote');
    const clone = join(sandbox().dir('status-up'), 'c');
    sandbox().git(sandbox().root, ['clone', '-q', remote, clone]);
    sandbox().write(clone, 'x.txt', 'x\n');
    sandbox().commitAll(clone, 'ahead');
    const s = await git.status(clone);
    expect(s.upstream).toBe('origin/main');
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
  });
});

describe('clean', () => {
  test('dryRun lists, force removes files, directories, ignored', async () => {
    const repo = sandbox().repo('clean', { '.gitignore': '*.log\n' });
    sandbox().write(repo, 'junk.txt', 'j');
    sandbox().write(repo, 'dir/inner.txt', 'i');
    sandbox().write(repo, 'x.log', 'l');

    const preview = await git.clean(repo, { force: false, dryRun: true, directories: true });
    // NB: a real clean -n result carries dryRun:true, which lmts'
    // isDryRunResult() also treats as a policy dry-run (false positive).
    expect(preview).toMatchObject({ success: true, dryRun: true, filesRemoved: ['junk.txt'], directoriesRemoved: ['dir/'] });
    expect(existsSync(join(repo, 'junk.txt'))).toBe(true);

    const r = real(await git.clean(repo, { force: true, directories: true, ignored: true }));
    expect(r.filesRemoved.sort()).toEqual(['junk.txt', 'x.log']);
    expect(r.directoriesRemoved).toEqual(['dir/']);
    expect(r.dryRun).toBe(false);
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false);
    expect(existsSync(join(repo, 'dir'))).toBe(false);
  });

  test('without force git refuses (clean.requireForce) => CliError', async () => {
    const repo = sandbox().repo('clean-noforce');
    sandbox().write(repo, 'junk.txt', 'j');
    await expect(git.clean(repo, { force: false })).rejects.toBeInstanceOf(CliError);
    expect(existsSync(join(repo, 'junk.txt'))).toBe(true);
  });
});

describe('add', () => {
  test('explicit paths, --all, --update, --force for ignored', async () => {
    const repo = sandbox().repo('add', { '.gitignore': 'ign.txt\n', 't.txt': '1\n' });
    sandbox().write(repo, 'a b.txt', 'a');
    expect(real(await git.add(repo, { paths: ['a b.txt'] }))).toEqual({ success: true, stagedFiles: ['a b.txt'] });

    sandbox().write(repo, 't.txt', '2\n');
    sandbox().write(repo, 'u.txt', 'u');
    expect(real(await git.add(repo, { paths: [], update: true })).stagedFiles).toEqual([]);
    let s = await git.status(repo);
    expect(s.stagedChanges.modified).toEqual(['t.txt']);
    expect(s.untrackedFiles).toEqual(['u.txt']);

    expect(real(await git.add(repo, { paths: [], all: true })).stagedFiles).toEqual([]);
    s = await git.status(repo);
    expect(s.untrackedFiles).toEqual([]);

    sandbox().write(repo, 'ign.txt', 'i');
    await expect(git.add(repo, { paths: ['ign.txt'] })).rejects.toBeInstanceOf(CliError);
    await git.add(repo, { paths: ['ign.txt'], force: true });
    expect((await git.status(repo)).stagedChanges.added).toContain('ign.txt');

    // empty paths without all/update => git add with no pathspec (no-op).
    expect(real(await git.add(repo, { paths: [] })).stagedFiles).toEqual([]);
  });

  test('missing path => "File not found" via pathspec transform', async () => {
    const repo = sandbox().repo('add-missing');
    await expect(git.add(repo, { paths: ['nope.txt'] })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: 'File not found: nope.txt',
    });
  });
});

describe('reset', () => {
  test('soft/mixed/hard/keep/merge and path reset report affected files', async () => {
    const repo = sandbox().repo('reset', { 'a.txt': '1\n' });
    const base = sandbox().git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    sandbox().write(repo, 'b.txt', 'b\n');
    const second = sandbox().commitAll(repo, 'second');

    const soft = real(await git.reset(repo, { mode: 'soft', commit: base }));
    expect(soft).toEqual({ success: true, mode: 'soft', commit: base, filesReset: ['b.txt'], previousCommit: second });
    expect((await git.status(repo)).stagedChanges.added).toEqual(['b.txt']);

    const paths = real(await git.reset(repo, { mode: 'mixed', paths: ['b.txt'] }));
    expect(paths.filesReset).toEqual(['b.txt']);
    expect(paths.previousCommit).toBeUndefined();

    const mixed = real(await git.reset(repo, { mode: 'mixed' }));
    expect(mixed.filesReset).toEqual([]);

    sandbox().git(repo, ['add', 'b.txt']);
    sandbox().commitAll(repo, 'again');
    sandbox().write(repo, 'a.txt', 'dirty\n');
    const hard = real(await git.reset(repo, { mode: 'hard', commit: 'HEAD~1' }));
    expect(hard.filesReset.sort()).toEqual(['a.txt', 'b.txt']);
    expect(readFileSync(join(repo, 'a.txt'), 'utf-8')).toBe('1\n');

    const keep = real(await git.reset(repo, { mode: 'keep', commit: 'HEAD' }));
    expect(keep.filesReset).toEqual([]);
    const merge = real(await git.reset(repo, { mode: 'merge', commit: 'HEAD' }));
    expect(merge.mode).toBe('merge');
  });

  test('unborn repo: no previous commit, path reset', async () => {
    const repo = sandbox().dir('reset-unborn');
    sandbox().git(repo, ['init', '-q', '-b', 'main']);
    sandbox().write(repo, 'x.txt', 'x');
    sandbox().git(repo, ['add', 'x.txt']);
    const r = real(await git.reset(repo, { mode: 'mixed', paths: ['x.txt'] }));
    expect(r).toEqual({ success: true, mode: 'mixed', commit: '', filesReset: ['x.txt'] });
  });

  test('bad commit => CliError', async () => {
    const repo = sandbox().repo('reset-bad');
    await expect(git.reset(repo, { mode: 'hard', commit: 'no-such-commit' })).rejects.toBeInstanceOf(CliError);
  });
});

describe('commit', () => {
  test('basic, filesToStage, author override, amend, allowEmpty, noVerify', async () => {
    const repo = sandbox().repo('commit');
    sandbox().write(repo, 'f.txt', 'f\n');
    const c1 = real(await git.commit(repo, { message: 'add f', filesToStage: ['f.txt'] }));
    expect(c1).toMatchObject({
      success: true,
      message: 'add f',
      author: AUTHOR_NAME,
      timestamp: FIXED_EPOCH,
      filesChanged: ['f.txt'],
      signed: false,
    });
    expect(c1.commitHash).toMatch(/^[0-9a-f]{40}$/);

    const c2 = real(
      await git.commit(repo, {
        message: '-leading dash message',
        allowEmpty: true,
        noVerify: true,
        author: { name: 'Other Person', email: 'other@example.test' },
      }),
    );
    expect(c2.author).toBe('Other Person');
    expect(c2.filesChanged).toEqual([]);
    expect(sandbox().git(repo, ['log', '-1', '--format=%s']).stdout.trim()).toBe('-leading dash message');

    const c3 = real(await git.commit(repo, { message: 'amended', amend: true, allowEmpty: true }));
    expect(c3.commitHash).not.toBe(c2.commitHash);
    expect(sandbox().git(repo, ['rev-list', '--count', 'HEAD']).stdout.trim()).toBe('3');
  });

  test('nothing to commit => INVALID_REQUEST', async () => {
    const repo = sandbox().repo('commit-empty');
    await expect(git.commit(repo, { message: 'nothing' })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  test('GIT_SIGN_COMMITS: signs via gpg.program when it works', async () => {
    const repo = sandbox().repo('commit-sign');
    sandbox().setGpgMode('good');
    const restore = setEnv({ GIT_SIGN_COMMITS: 'true' });
    try {
      const r = real(await new Git2().commit(repo, { message: 'signed', allowEmpty: true }));
      expect(r.signed).toBe(true);
      expect(r.signingWarning).toBeUndefined();
      expect(sandbox().git(repo, ['cat-file', 'commit', 'HEAD']).stdout).toContain('gpgsig');
    } finally {
      restore();
    }
  });

  test('GIT_SIGN_COMMITS: falls back to unsigned with a warning when signing fails', async () => {
    const repo = sandbox().repo('commit-sign-fail');
    sandbox().setGpgMode('sign-fail');
    const restore = setEnv({ GIT_SIGN_COMMITS: '1' });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = real(await new Git2().commit(repo, { message: 'fallback', allowEmpty: true }));
      expect(r.signed).toBe(false);
      expect(r.signingWarning).toContain('signing failed');
      expect(stderr).toHaveBeenCalled();
      expect(sandbox().git(repo, ['cat-file', 'commit', 'HEAD']).stdout).not.toContain('gpgsig');
    } finally {
      stderr.mockRestore();
      restore();
      sandbox().setGpgMode('good');
    }
  });

  test('signing failure path with non-Error rejection (stub)', async () => {
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let n = 0;
      const calls: string[][] = [];
      const exec = async (args: string[]) => {
        calls.push(args);
        n++;
        if (n === 1) throw 'gpg exploded';
        if (args[0] === 'rev-parse') return { stdout: 'abc\n', stderr: '' };
        if (args[0] === 'show') return { stdout: `Me\x1F12\x1E\nfile.txt\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      };
      const r = await executeCommit({ message: 'm' }, ctx('/w', true), exec);
      expect(calls[0]).toContain('--gpg-sign');
      expect(calls[1]).not.toContain('--gpg-sign');
      expect(r).toMatchObject({ commitHash: 'abc', author: 'Me', timestamp: 12, filesChanged: ['file.txt'], signed: false });
      expect(r.signingWarning).toContain('gpg exploded');
    } finally {
      stderr.mockRestore();
    }
  });

  test('stub: empty show output degrades to defaults', async () => {
    const { fn } = stubExec([{}, { stdout: 'h\n' }, { stdout: '' }]);
    const r = await executeCommit({ message: 'm' }, ctx('/w'), fn);
    expect(r).toMatchObject({ commitHash: 'h', author: '', timestamp: 0, filesChanged: [] });
  });
});

// ---------------------------------------------------------------------------
// log / show / diff / blame / reflog
// ---------------------------------------------------------------------------

describe('log', () => {
  test('full format, filters, skip, branch, path', async () => {
    const repo = sandbox().repo('log', { 'a.txt': '1\n' });
    sandbox().write(repo, 'b.txt', 'b\n');
    sandbox().git(repo, ['add', 'b.txt']);
    sandbox().git(repo, ['commit', '-q', '-m', 'add b', '-m', 'body line']);
    sandbox().git(repo, ['checkout', '-q', '-b', 'side']);
    sandbox().commitAll(repo, 'side commit');
    sandbox().git(repo, ['checkout', '-q', 'main']);

    const all = await git.log(repo);
    expect(all.totalCount).toBe(2);
    const head = all.commits[0]!;
    expect(head).toMatchObject({ subject: 'add b', body: 'body line\n', author: AUTHOR_NAME, timestamp: FIXED_EPOCH });
    expect(head.parents?.length).toBe(1);
    expect(all.commits[1]!.parents).toEqual([]);

    expect((await git.log(repo, { maxCount: 1 })).commits.map((c) => c.subject)).toEqual(['add b']);
    expect((await git.log(repo, { skip: 1 })).commits.map((c) => c.subject)).toEqual(['initial']);
    expect((await git.log(repo, { grep: 'add' })).totalCount).toBe(1);
    expect((await git.log(repo, { author: 'Nobody Matches' })).totalCount).toBe(0);
    expect((await git.log(repo, { since: '2024-01-01', until: '2024-01-03' })).totalCount).toBe(2);
    expect((await git.log(repo, { until: '2023-01-01' })).totalCount).toBe(0);
    expect((await git.log(repo, { branch: 'side' })).commits[0]!.subject).toBe('side commit');
    expect((await git.log(repo, { path: 'b.txt' })).commits.map((c) => c.subject)).toEqual(['add b']);
  });

  test('oneline, stat, patch and stat+patch', async () => {
    const repo = sandbox().repo('log-extra', { 'a.txt': '1\n' });
    sandbox().write(repo, 'a.txt', '2\n');
    sandbox().commitAll(repo, 'change a');

    const one = await git.log(repo, { oneline: true, maxCount: 1 });
    expect(one.commits[0]).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{40}$/),
      shortHash: expect.any(String),
      subject: 'change a',
    });

    const stat = await git.log(repo, { stat: true, maxCount: 1 });
    expect(stat.commits[0]!.stat).toContain('a.txt');
    expect(stat.commits[0]!.patch).toBeUndefined();

    const patch = await git.log(repo, { patch: true, maxCount: 1 });
    expect(patch.commits[0]!.patch).toContain('diff --git a/a.txt b/a.txt');

    const both = await git.log(repo, { stat: true, patch: true, maxCount: 1 });
    expect(both.commits[0]!.stat).toContain('a.txt |');
    expect(both.commits[0]!.patch).toMatch(/^diff --git/);
  });

  test('stub: stat+patch without a diff header puts everything in stat; malformed sections skipped', async () => {
    const S = '<<<COMMIT_START>>>';
    const E = '<<<COMMIT_END>>>';
    const F = '\x1F';
    const { fn, calls } = stubExec([
      {
        stdout: `${S}h${F}s${F}A${F}e${F}1${F}subj${F}${F}${E}\n only-stat | 1 +\n${S}no end marker`,
      },
    ]);
    const r = await executeLog({ stat: true, patch: true }, ctx('/w'), fn);
    expect(calls[0]!.args).toContain('--stat');
    expect(calls[0]!.args).toContain('-p');
    expect(r.commits).toHaveLength(1);
    expect(r.commits[0]!.stat).toBe('only-stat | 1 +');
    expect(r.commits[0]!.body).toBeUndefined();
  });

  test('unknown branch => INVALID_REQUEST (ambiguous argument)', async () => {
    const repo = sandbox().repo('log-bad');
    await expect(git.log(repo, { branch: 'no-such-branch' })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });
});

describe('show', () => {
  test('commit with metadata, stat, raw format, file at ref, tree, blob, tag', async () => {
    const repo = sandbox().repo('show', { 'dir/f.txt': 'hello\n' });
    sandbox().git(repo, ['tag', '-a', 'v1', '-m', 'annotated']);

    const c = await git.show(repo, { object: 'HEAD' });
    expect(c.type).toBe('commit');
    expect(c.content).toContain('initial');
    // See the test.failing below: metadata is currently always {}.
    expect(c.metadata).toEqual({});

    expect((await git.show(repo, { object: 'HEAD', stat: true })).content).toContain('dir/f.txt');
    expect((await git.show(repo, { object: 'HEAD', format: 'raw' })).content).toMatch(/^commit [0-9a-f]{40}\ntree /);

    const file = await git.show(repo, { object: 'HEAD', filePath: 'dir/f.txt' });
    expect(file.content).toBe('hello\n');

    expect((await git.show(repo, { object: 'HEAD^{tree}' })).type).toBe('tree');
    expect((await git.show(repo, { object: 'HEAD:dir/f.txt' })).type).toBe('blob');
    const tag = await git.show(repo, { object: 'v1' });
    expect(tag.type).toBe('tag');
    expect(tag.metadata).toEqual({});
  });

  // KNOWN BUG (src/operations/commits/show.ts): COMMIT_META_FORMAT is joined
  // with NUL, and validateGitArgs() rejects any argv containing '\0', so the
  // best-effort metadata `git log -1 --format=...` call always fails and
  // `metadata` is always {} against real git.
  test.failing('commit metadata is populated from real git (currently broken)', async () => {
    const repo = sandbox().repo('show-meta');
    const c = await git.show(repo, { object: 'HEAD' });
    expect(c.metadata).toMatchObject({ subject: 'initial', parents: [] });
  });

  test('stub: commit metadata parsing (NUL-separated fields)', async () => {
    const meta = ['H', 'h', 'An', 'a@x', '2024', 'Cn', 'c@x', '2025', 'p1 p2 ', 'subj', 'body\n\n'].join('\0');
    const { fn, calls } = stubExec((args) =>
      args[0] === 'cat-file' ? { stdout: 'commit\n' } : args[0] === 'show' ? { stdout: 'C' } : { stdout: meta },
    );
    const r = await executeShow({ object: 'HEAD' }, ctx('/w'), fn);
    expect(calls.map((c) => c.args[0])).toEqual(['cat-file', 'show', 'log']);
    expect(r.metadata).toEqual({
      hash: 'H',
      shortHash: 'h',
      author: { name: 'An', email: 'a@x', date: '2024' },
      committer: { name: 'Cn', email: 'c@x', date: '2025' },
      parents: ['p1', 'p2'],
      subject: 'subj',
      body: 'body',
    });
  });

  test('missing object => INVALID_REQUEST', async () => {
    const repo = sandbox().repo('show-bad');
    await expect(git.show(repo, { object: 'deadbeefdeadbeef' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: unknown type falls back to commit, short metadata ignored, content failure rethrown', async () => {
    const { fn } = stubExec((args) =>
      args[0] === 'cat-file' ? { stdout: 'weird\n' } : args[0] === 'show' ? { stdout: 'body' } : { stdout: 'a\0b' },
    );
    const r = await executeShow({ object: 'X' }, ctx('/w'), fn);
    expect(r).toEqual({ object: 'X', type: 'commit', content: 'body', metadata: {} });

    const failing = stubExec((args) => (args[0] === 'show' ? new Error('boom') : { stdout: 'commit' }));
    await expect(executeShow({ object: 'X' }, ctx('/w'), failing.fn)).rejects.toBeInstanceOf(CliError);
  });
});

describe('diff', () => {
  const setup = () => {
    const repo = sandbox().repo('diff', { 'a.txt': '1\n2\n3\n', 'bun.lock': 'v1\n', 'img.bin': '\0\x01' });
    sandbox().write(repo, 'a.txt', '1\nTWO\n3\n');
    sandbox().write(repo, 'bun.lock', 'v2\n');
    sandbox().write(repo, 'img.bin', '\0\x02\x03');
    sandbox().write(repo, 'untracked.txt', 'u1\nu2\n');
    sandbox().write(repo, 'skip-me.txt', 'zzz\n');
    return repo;
  };

  test('working tree diff, counts, binary, unified context', async () => {
    const repo = setup();
    const d = await git.diff(repo);
    expect(d.diff).toContain('-2\n+TWO');
    // Quirk: parseGitDiffStat ignores "Bin a -> b bytes" lines, so binary
    // files are not counted in filesChanged (totals come from the summary).
    expect(d.filesChanged).toBe(2);
    expect(d.insertions).toBe(2);
    expect(d.deletions).toBe(2);
    expect(d.binary).toBe(true);
    const u0 = await git.diff(repo, { unified: 0, paths: ['a.txt'] });
    expect(u0.diff).toContain('@@ -2 +2 @@');
    expect(u0.filesChanged).toBe(1);
  });

  test('staged, commit1/commit2, nameOnly, stat', async () => {
    const repo = setup();
    expect((await git.diff(repo, { staged: true })).filesChanged).toBe(0);
    sandbox().git(repo, ['add', 'a.txt']);
    expect((await git.diff(repo, { staged: true, nameOnly: true })).diff.trim()).toBe('a.txt');
    const second = sandbox().commitAll(repo, 'second');
    const range = await git.diff(repo, { commit1: 'HEAD~1', commit2: second, stat: true });
    expect(range.filesChanged).toBe(4); // 5 files, binary one not counted
    expect(range.diff).toContain('files changed');
  });

  test('includeUntracked + excludePatterns in full, nameOnly and stat modes', async () => {
    const repo = setup();
    const full = await git.diff(repo, { includeUntracked: true, excludePatterns: ['bun.lock', 'skip-me.txt'] });
    expect(full.diff).toContain('untracked.txt');
    expect(full.diff).not.toContain('bun.lock');
    expect(full.excludedFiles).toEqual(['bun.lock', 'skip-me.txt']);
    expect(full.filesChanged).toBe(2);
    expect(full.insertions).toBe(1 + 2);

    const names = await git.diff(repo, { includeUntracked: true, nameOnly: true });
    expect(names.diff.split('\n').filter(Boolean).sort()).toEqual([
      'a.txt',
      'bun.lock',
      'img.bin',
      'skip-me.txt',
      'untracked.txt',
    ]);
    expect(names.filesChanged).toBe(5);

    const stat = await git.diff(repo, { stat: true, includeUntracked: true, excludePatterns: ['skip-me.txt'] });
    expect(stat.filesChanged).toBe(3);
    expect(stat.excludedFiles).toEqual(['skip-me.txt']);
    expect(stat.insertions).toBe(1 + 1 + 2);

    const statNoMatch = await git.diff(repo, { stat: true, includeUntracked: true, excludePatterns: ['nothing-here'] });
    expect(statNoMatch.excludedFiles).toBeUndefined();
  });

  test('stub: untracked file whose --no-index diff yields no output is skipped', async () => {
    const reply = (args: string[]) => {
      if (args[0] === 'ls-files') return { stdout: 'ghost.txt\n' };
      if (args.includes('--no-index')) return new Error('could not read ghost.txt');
      return { stdout: '' };
    };
    const full = await executeDiff({ includeUntracked: true }, ctx('/w'), stubExec(reply).fn);
    expect(full).toMatchObject({ diff: '', filesChanged: 1, insertions: 0 });
    const stat = await executeDiff({ includeUntracked: true, stat: true }, ctx('/w'), stubExec(reply).fn);
    expect(stat).toMatchObject({ diff: '', filesChanged: 0 });
  });

  test('bad revision => INVALID_REQUEST', async () => {
    const repo = sandbox().repo('diff-bad');
    await expect(git.diff(repo, { commit1: 'nope' })).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });
});

describe('blame', () => {
  test('per-line porcelain with ranges and whitespace option', async () => {
    const repo = sandbox().repo('blame', { 'b.txt': 'one\ntwo\nthree\n' });
    sandbox().write(repo, 'b.txt', 'one\nTWO\nthree\n');
    const second = sandbox().commitAll(repo, 'edit');
    const all = await git.blame(repo, { file: 'b.txt' });
    // See test.failing below: 'three' (second line from the initial commit)
    // is dropped because --porcelain only emits author info once per commit.
    expect(all.lines.map((l) => l.content)).toEqual(['one', 'TWO']);
    expect(all.lines[1]).toMatchObject({ commitHash: second, author: AUTHOR_NAME, lineNumber: 2, timestamp: FIXED_EPOCH });

    const range = await git.blame(repo, { file: 'b.txt', startLine: 2, endLine: 3, ignoreWhitespace: true });
    expect(range.lines.map((l) => l.lineNumber)).toEqual([2, 3]);
    const from = await git.blame(repo, { file: 'b.txt', startLine: 3 });
    expect(from.lines.map((l) => l.content)).toEqual(['three']);
  });

  // KNOWN BUG (src/operations/history/blame.ts): `git blame --porcelain`
  // prints author/author-time only the first time a commit appears; later
  // lines from the same commit carry just the header + content, so the
  // parser's completeness check drops them. (--line-porcelain would fix it.)
  test.failing('every line is reported even when a commit repeats (currently broken)', async () => {
    const repo = sandbox().repo('blame-repeat', { 'r.txt': 'a\nb\nc\n' });
    const r = await git.blame(repo, { file: 'r.txt' });
    expect(r.totalLines).toBe(3);
  });

  test('missing file => CliError', async () => {
    const repo = sandbox().repo('blame-bad');
    await expect(git.blame(repo, { file: 'nope.txt' })).rejects.toBeInstanceOf(CliError);
  });
});

describe('reflog', () => {
  test('entries with action parsing, ref + maxCount', async () => {
    const repo = sandbox().repo('reflog');
    sandbox().git(repo, ['checkout', '-q', '-b', 'feat']);
    sandbox().commitAll(repo, 'feat work');
    const r = await git.reflog(repo);
    expect(r.ref).toBe('HEAD');
    expect(r.entries.map((e) => e.action)).toEqual(['commit', 'checkout', 'commit (initial)']);
    expect(r.entries[0]).toMatchObject({ refName: 'HEAD@{0}', message: 'commit: feat work', timestamp: FIXED_EPOCH });
    const limited = await git.reflog(repo, { ref: 'feat', maxCount: 1 });
    expect(limited.totalEntries).toBe(1);
    expect(limited.entries[0]!.refName).toBe('feat@{0}');
  });

  test('unknown ref => CliError', async () => {
    const repo = sandbox().repo('reflog-bad');
    await expect(git.reflog(repo, { ref: 'nope' })).rejects.toBeInstanceOf(CliError);
  });
});
