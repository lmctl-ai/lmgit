/**
 * @fileoverview Real-git tests for branch, checkout, merge, rebase,
 * cherry-pick, remote, fetch/push/pull (against a local bare repo used as
 * the remote), tag (incl. signature verification via a fake gpg.program),
 * stash and worktree operations. Argv construction for signing and other
 * hard-to-reach branches is asserted through a recording exec stub.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

import {
  executeBranch,
  executeCheckout,
  executeCherryPick,
  executeFetch,
  executeMerge,
  executePull,
  executePush,
  executeRebase,
  executeRemote,
  executeStash,
  executeTag,
  executeWorktree,
  Git2,
  type GitBranchOptions,
  type GitOperationContext,
  type GitRemoteOptions,
  type GitStashOptions,
  type GitTagOptions,
  type GitWorktreeOptions,
} from '../src/index.js';
import { mode, real, stubExec } from './helpers/narrow.js';
import { setEnv, useSandbox, type GpgMode } from './helpers/sandbox.js';

const sandbox = useSandbox('refs');
const git = new Git2();
const ctx = (dir: string, signCommits = false): GitOperationContext => ({ workingDirectory: dir, signCommits });

/** main + `other` branches that both edit c.txt (conflict on merge). */
function divergent(name: string): string {
  const sb = sandbox();
  const repo = sb.repo(name, { 'c.txt': 'base\n', 'keep.txt': 'k\n' });
  sb.git(repo, ['checkout', '-q', '-b', 'other']);
  sb.write(repo, 'c.txt', 'other\n');
  sb.commitAll(repo, 'other edit');
  sb.git(repo, ['checkout', '-q', 'main']);
  sb.write(repo, 'c.txt', 'main\n');
  sb.commitAll(repo, 'main edit');
  return repo;
}

// ---------------------------------------------------------------------------
// branch / checkout
// ---------------------------------------------------------------------------

describe('branch', () => {
  test('create/list/show-current/rename/delete incl. filters and limit', async () => {
    const repo = sandbox().repo('branch');
    expect(mode(await git.branch(repo, { mode: 'create', branchName: 'feat' }), 'create').created).toBe('feat');
    await git.branch(repo, { mode: 'create', branchName: 'from-start', startPoint: 'HEAD' });
    await git.branch(repo, { mode: 'create', branchName: 'feat', force: true });

    const list = mode(await git.branch(repo, { mode: 'list' }), 'list');
    expect(list.branches.map((b) => b.name)).toEqual(['feat', 'from-start', 'main']);
    expect(list.branches.find((b) => b.current)?.name).toBe('main');

    expect(mode(await git.branch(repo, { mode: 'list', limit: 1 }), 'list').branches).toHaveLength(1);
    expect(mode(await git.branch(repo, { mode: 'list', merged: true }), 'list').branches).toHaveLength(3);
    expect(mode(await git.branch(repo, { mode: 'list', merged: 'main', noMerged: false }), 'list').branches).toHaveLength(3);
    sandbox().git(repo, ['checkout', '-q', 'feat']);
    sandbox().commitAll(repo, 'feat only');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    expect(mode(await git.branch(repo, { mode: 'list', noMerged: true }), 'list').branches.map((b) => b.name)).toEqual([
      'feat',
    ]);
    expect(mode(await git.branch(repo, { mode: 'list', noMerged: 'main' }), 'list').branches).toHaveLength(1);
    expect(mode(await git.branch(repo, { mode: 'list', remote: true }), 'list').branches).toEqual([]);
    expect(mode(await git.branch(repo, { mode: 'list', all: true }), 'list').branches).toHaveLength(3);

    expect(mode(await git.branch(repo, { mode: 'show-current' }), 'show-current').current).toBe('main');

    const renamed = mode(await git.branch(repo, { mode: 'rename', branchName: 'from-start', newBranchName: 'renamed' }), 'rename');
    expect(renamed.renamed).toEqual({ from: 'from-start', to: 'renamed' });
    await git.branch(repo, { mode: 'rename', branchName: 'renamed', newBranchName: 'feat', force: true });

    await expect(git.branch(repo, { mode: 'delete', branchName: 'nope' })).rejects.toBeInstanceOf(CliError);
    expect(mode(await git.branch(repo, { mode: 'delete', branchName: 'feat', force: true }), 'delete').deleted).toBe('feat');
  });

  test('show-current on detached HEAD is null; duplicate create is mapped', async () => {
    const repo = sandbox().repo('branch-detached');
    // Quirk: real git says "a branch named 'main' already exists", which the
    // mapper's /branch '(.+)' already exists/ pattern does not match, so it
    // falls through to the generic INTERNAL_ERROR mapping.
    await expect(git.branch(repo, { mode: 'create', branchName: 'main' })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("a branch named 'main' already exists"),
    });
    sandbox().git(repo, ['checkout', '-q', '--detach']);
    expect(mode(await git.branch(repo, { mode: 'show-current' }), 'show-current').current).toBeNull();
  });

  test('stub: missing names and unknown mode throw mapped errors', async () => {
    const { fn } = stubExec([]);
    const bad: GitBranchOptions[] = [
      { mode: 'create' },
      { mode: 'delete' },
      { mode: 'rename', branchName: 'a' },
      { mode: 'bogus' as GitBranchOptions['mode'] },
    ];
    for (const o of bad) await expect(executeBranch(o, ctx('/w'), fn)).rejects.toBeInstanceOf(CliError);
  });
});

describe('checkout', () => {
  test('switch, create (-b) with --track, force, paths', async () => {
    const remote = sandbox().repo('checkout-remote');
    const repo = join(sandbox().dir('checkout'), 'c');
    sandbox().git(sandbox().root, ['clone', '-q', remote, repo]);

    const created = real(await git.checkout(repo, { target: 'tracked', createBranch: true, track: true }));
    expect(created).toMatchObject({ success: true, target: 'tracked', branchCreated: true });
    expect(real(await git.checkout(repo, { target: 'main' })).branchCreated).toBe(false);

    sandbox().write(repo, 'README.md', 'dirty\n');
    // carrying a local modification across a switch lists it as modified
    const carried = real(await git.checkout(repo, { target: 'tracked' }));
    expect(carried.filesModified).toEqual(['README.md']);
    await git.checkout(repo, { target: 'HEAD', paths: ['README.md'] });
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('# repo\n');
    sandbox().write(repo, 'README.md', 'dirty again\n');
    await git.checkout(repo, { target: 'main', force: true });
    expect(readFileSync(join(repo, 'README.md'), 'utf-8')).toBe('# repo\n');
  });

  test('unknown target => CliError', async () => {
    const repo = sandbox().repo('checkout-bad');
    await expect(git.checkout(repo, { target: 'no-such' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: output parsing strips porcelain prefixes and info lines', async () => {
    const { fn, calls } = stubExec([{ stdout: "M\tsrc/a.ts\nSwitched to branch 'x'\nYour branch is up to date\nweird line\n" }]);
    const r = await executeCheckout({ target: 'x', createBranch: true, track: true, force: true, paths: ['p'] }, ctx('/w'), fn);
    expect(calls[0]!.args).toEqual(['checkout', '-b', 'x', '--track', '--force', '--', 'p']);
    expect(r.filesModified).toEqual(['src/a.ts', 'weird line']);
  });
});

// ---------------------------------------------------------------------------
// merge / rebase / cherry-pick
// ---------------------------------------------------------------------------

describe('merge', () => {
  test('fast-forward, no-ff with message, squash', async () => {
    const repo = sandbox().repo('merge');
    sandbox().git(repo, ['checkout', '-q', '-b', 'ff']);
    sandbox().write(repo, 'ff.txt', 'ff\n');
    sandbox().commitAll(repo, 'ff');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    const ff = real(await git.merge(repo, { branch: 'ff' }));
    expect(ff).toMatchObject({ success: true, fastForward: true, conflicts: false, strategy: 'ort' });
    expect(ff.mergedFiles).toEqual(['ff.txt']);

    sandbox().git(repo, ['checkout', '-q', '-b', 'nf']);
    sandbox().write(repo, 'nf.txt', 'nf\n');
    sandbox().commitAll(repo, 'nf');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    const noff = real(await git.merge(repo, { branch: 'nf', noFastForward: true, message: 'merge nf', strategy: 'ort' }));
    expect(noff).toMatchObject({ fastForward: false, message: 'merge nf' });
    expect(sandbox().git(repo, ['log', '-1', '--format=%s']).stdout.trim()).toBe('merge nf');

    sandbox().git(repo, ['checkout', '-q', '-b', 'sq']);
    sandbox().write(repo, 'sq.txt', 'sq\n');
    sandbox().commitAll(repo, 'sq');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    const sq = real(await git.merge(repo, { branch: 'sq', squash: true }));
    expect(sq.conflicts).toBe(false);
    expect((await git.status(repo)).stagedChanges.added).toEqual(['sq.txt']);
  });

  test('conflict is a structured result; abort restores', async () => {
    const repo = divergent('merge-conflict');
    const r = real(await git.merge(repo, { branch: 'other' }));
    expect(r.conflicts).toBe(true);
    expect(r.conflictedFiles).toEqual(['c.txt']);
    expect(r.message).toContain('produced conflicts in 1 file(s)');
    const aborted = real(await git.merge(repo, { branch: '', abort: true }));
    expect(aborted).toMatchObject({ success: true, message: 'Merge aborted.' });
    expect((await git.status(repo)).isClean).toBe(true);
  });

  test('real failure (unknown branch) throws', async () => {
    const repo = sandbox().repo('merge-bad');
    await expect(git.merge(repo, { branch: 'no-such-branch' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: signing flag and binary diffstat lines', async () => {
    const { fn, calls } = stubExec([{ stdout: 'Merge made\n img.png | Bin 0 -> 12 bytes\n a.txt | 2 +-\n' }]);
    const r = await executeMerge({ branch: 'x' }, ctx('/w', true), fn);
    expect(calls[0]!.args).toEqual(['merge', '-S', 'x']);
    expect(calls[0]!.allowNonZeroExit).toBe(true);
    expect(r.mergedFiles).toEqual(['img.png', 'a.txt']);
    expect(r.message).toContain('Merge made');
  });
});

describe('rebase', () => {
  test('start (clean), onto + branch, conflict -> abort, conflict -> skip, continue', async () => {
    const repo = sandbox().repo('rebase', { 'a.txt': 'a\n' });
    sandbox().git(repo, ['checkout', '-q', '-b', 'topic']);
    sandbox().write(repo, 't.txt', 't\n');
    sandbox().commitAll(repo, 'topic');
    sandbox().git(repo, ['checkout', '-q', 'main']);
    sandbox().write(repo, 'm.txt', 'm\n');
    sandbox().commitAll(repo, 'main moves');

    const r = real(await git.rebase(repo, { upstream: 'main', branch: 'topic' }));
    expect(r).toMatchObject({ success: true, conflicts: false, rebasedCommits: 1 });
    expect(sandbox().git(repo, ['rev-parse', 'topic~1']).stdout).toBe(sandbox().git(repo, ['rev-parse', 'main']).stdout);

    const onto = real(await git.rebase(repo, { upstream: 'main', onto: 'main~1', branch: 'topic' }));
    expect(onto.success).toBe(true);
    const ontoNoBranch = real(await git.rebase(repo, { upstream: 'main~1', onto: 'main' }));
    expect(ontoNoBranch.success).toBe(true);

    const dv = divergent('rebase-conflict');
    sandbox().git(dv, ['checkout', '-q', 'other']);
    const c = real(await git.rebase(dv, { upstream: 'main' }));
    expect(c.conflicts).toBe(true);
    expect(c.conflictedFiles).toEqual(['c.txt']);
    expect(real(await git.rebase(dv, { mode: 'abort' })).conflicts).toBe(false);

    real(await git.rebase(dv, { upstream: 'main' }));
    expect(real(await git.rebase(dv, { mode: 'skip' })).success).toBe(true);

    // continue after resolving a conflict
    sandbox().git(dv, ['reset', '-q', '--hard', 'other@{1}'], { allowFail: true });
    const dv2 = divergent('rebase-continue');
    sandbox().git(dv2, ['checkout', '-q', 'other']);
    real(await git.rebase(dv2, { upstream: 'main' }));
    sandbox().write(dv2, 'c.txt', 'resolved\n');
    sandbox().git(dv2, ['add', 'c.txt']);
    const cont = real(await git.rebase(dv2, { mode: 'continue' }));
    expect(cont).toMatchObject({ success: true, conflicts: false, rebasedCommits: 0 });
  });

  test('errors: no upstream, nothing to continue, bad upstream', async () => {
    const repo = sandbox().repo('rebase-bad');
    await expect(git.rebase(repo, {})).rejects.toBeInstanceOf(CliError);
    await expect(git.rebase(repo, { mode: 'continue' })).rejects.toBeInstanceOf(CliError);
    await expect(git.rebase(repo, { upstream: 'no-such' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: flags, legacy Applying: output, continue with conflicts', async () => {
    const { fn, calls } = stubExec([{ stdout: 'Applying: one\nApplying: two\n' }]);
    const r = await executeRebase({ upstream: 'u', interactive: true, preserve: true }, ctx('/w', true), fn);
    expect(calls[0]!.args).toEqual(['rebase', '--interactive', '--preserve-merges', '--gpg-sign', 'u']);
    expect(r.rebasedCommits).toBe(2);

    const cont = stubExec([{ stderr: 'CONFLICT (content): Merge conflict in z.txt', exitCode: 1 }]);
    const c = await executeRebase({ mode: 'continue' }, ctx('/w'), cont.fn);
    expect(c).toEqual({ success: true, conflicts: true, conflictedFiles: ['z.txt'], rebasedCommits: 0 });
  });
});

describe('cherry-pick', () => {
  test('pick, no-commit + signoff, conflict, abort; mainline/strategy argv', async () => {
    const repo = sandbox().repo('cp', { 'a.txt': 'a\n' });
    sandbox().git(repo, ['checkout', '-q', '-b', 'src']);
    sandbox().write(repo, 'p.txt', 'p\n');
    const pick = sandbox().commitAll(repo, 'to pick');
    sandbox().write(repo, 'q.txt', 'q\n');
    const pick2 = sandbox().commitAll(repo, 'to pick 2');
    sandbox().git(repo, ['checkout', '-q', 'main']);

    const r = real(await git.cherryPick(repo, { commits: [pick] }));
    expect(r).toEqual({ success: true, pickedCommits: [pick], conflicts: false, conflictedFiles: [] });
    const nc = real(await git.cherryPick(repo, { commits: [pick2], noCommit: true, signoff: true, strategy: 'ort' }));
    expect(nc.conflicts).toBe(false);
    expect((await git.status(repo)).stagedChanges.added).toEqual(['q.txt']);
    sandbox().git(repo, ['reset', '-q', '--hard']);

    const dv = divergent('cp-conflict');
    const otherTip = sandbox().git(dv, ['rev-parse', 'other']).stdout.trim();
    const c = real(await git.cherryPick(dv, { commits: [otherTip] }));
    expect(c.conflicts).toBe(true);
    expect(c.conflictedFiles).toEqual(['c.txt']);
    expect(real(await git.cherryPick(dv, { commits: [], abort: true })).pickedCommits).toEqual([]);
    expect((await git.status(dv)).isClean).toBe(true);
  });

  test('failure without conflict throws; stub argv for mainline/continue/sign', async () => {
    const repo = sandbox().repo('cp-bad');
    await expect(git.cherryPick(repo, { commits: ['no-such-commit'] })).rejects.toBeInstanceOf(CliError);

    const { fn, calls } = stubExec([{}, {}]);
    await executeCherryPick({ commits: ['m'], mainline: 1, strategy: 'ort' }, ctx('/w', true), fn);
    expect(calls[0]!.args).toEqual(['cherry-pick', '--mainline', '1', '--strategy', 'ort', '--gpg-sign', 'm']);
    const cont = await executeCherryPick({ commits: ['m'], continueOperation: true }, ctx('/w'), fn);
    expect(calls[1]!.args).toEqual(['cherry-pick', '--continue']);
    expect(cont.pickedCommits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// remotes: remote / fetch / push / pull against a local bare repo
// ---------------------------------------------------------------------------

describe('remote', () => {
  test('add/list/get-url/set-url (push)/rename/remove', async () => {
    const repo = sandbox().repo('remote');
    const added = mode(await git.remote(repo, { mode: 'add', name: 'origin', url: 'https://example.test/r.git' }), 'add');
    expect(added.added).toEqual({ name: 'origin', url: 'https://example.test/r.git' });
    await git.remote(repo, { mode: 'set-url', name: 'origin', url: 'https://example.test/push.git', push: true });
    expect(mode(await git.remote(repo, { mode: 'list' }), 'list').remotes).toEqual([
      { name: 'origin', fetchUrl: 'https://example.test/r.git', pushUrl: 'https://example.test/push.git' },
    ]);
    expect(mode(await git.remote(repo, { mode: 'get-url', name: 'origin' }), 'get-url').url).toBe('https://example.test/r.git');
    expect(mode(await git.remote(repo, { mode: 'get-url', name: 'origin', push: true }), 'get-url').url).toBe(
      'https://example.test/push.git',
    );
    await git.remote(repo, { mode: 'set-url', name: 'origin', url: 'https://example.test/r2.git' });
    expect(mode(await git.remote(repo, { mode: 'rename', name: 'origin', newName: 'up' }), 'rename').renamed).toEqual({
      from: 'origin',
      to: 'up',
    });
    expect(mode(await git.remote(repo, { mode: 'remove', name: 'up' }), 'remove').removed).toBe('up');
    expect(mode(await git.remote(repo, { mode: 'list' }), 'list').remotes).toEqual([]);
    await expect(git.remote(repo, { mode: 'get-url', name: 'gone' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: required-arg validation and unknown mode; push-only remote lines', async () => {
    const { fn } = stubExec([]);
    const bad: GitRemoteOptions[] = [
      { mode: 'add', name: 'x' },
      { mode: 'remove' },
      { mode: 'rename', name: 'x' },
      { mode: 'get-url' },
      { mode: 'set-url', name: 'x' },
      { mode: 'bogus' as GitRemoteOptions['mode'] },
    ];
    for (const o of bad) await expect(executeRemote(o, ctx('/w'), fn)).rejects.toBeInstanceOf(CliError);
    const pushOnly = stubExec([{ stdout: 'p\thttps://h/p (push)\n' }]);
    expect(await executeRemote({ mode: 'list' }, ctx('/w'), pushOnly.fn)).toEqual({
      mode: 'list',
      remotes: [{ name: 'p', fetchUrl: '', pushUrl: 'https://h/p' }],
    });
  });
});

describe('fetch / push / pull (bare repo remote)', () => {
  /** bare remote + two clones (a: writer, b: reader). */
  function topology(name: string) {
    const sb = sandbox();
    const base = sb.dir(name);
    const bare = join(base, 'remote.git');
    sb.git(base, ['init', '-q', '--bare', '-b', 'main', bare]);
    const a = join(base, 'a');
    sb.git(base, ['clone', '-q', bare, a]);
    sb.write(a, 'f.txt', 'one\n');
    sb.commitAll(a, 'first');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    const b = join(base, 'b');
    sb.git(base, ['clone', '-q', bare, b]);
    return { bare, a, b };
  }

  test('push new branch with upstream, tags, normal push, dry-run, delete', async () => {
    const { bare, a } = topology('push');
    const sb = sandbox();
    sb.git(a, ['checkout', '-q', '-b', 'feature']);
    sb.write(a, 'g.txt', 'g\n');
    sb.commitAll(a, 'feature');
    const p = real(await git.push(a, { branch: 'feature', setUpstream: true }));
    expect(p).toMatchObject({ success: true, remote: 'origin', branch: 'feature', upstreamSet: true, rejectedRefs: [] });
    expect(p.pushedRefs).toEqual(['feature']);
    expect(sb.git(bare, ['rev-parse', 'feature']).stdout).toBe(sb.git(a, ['rev-parse', 'feature']).stdout);

    sb.git(a, ['tag', 'v1']);
    const t = real(await git.push(a, { tags: true }));
    expect(t.pushedRefs).toEqual(['v1']);

    const renamed = real(await git.push(a, { branch: 'feature', remoteBranch: 'renamed', dryRun: true }));
    expect(renamed.pushedRefs).toEqual(['renamed']);
    expect(sb.git(bare, ['rev-parse', '--verify', 'renamed'], { allowFail: true }).status).not.toBe(0);

    real(await git.push(a, { remoteBranch: 'via-head' }));
    expect(sb.git(bare, ['rev-parse', '--verify', 'via-head']).status).toBe(0);

    const del = real(await git.push(a, { delete: true, branch: 'via-head' }));
    expect(del.success).toBe(true);
    expect(sb.git(bare, ['rev-parse', '--verify', 'via-head'], { allowFail: true }).status).not.toBe(0);
    await expect(git.push(a, { delete: true })).rejects.toBeInstanceOf(CliError);
  });

  test('non-fast-forward rejection throws; --force / --force-with-lease succeed', async () => {
    const { bare, a, b } = topology('push-force');
    const sb = sandbox();
    sb.write(a, 'f.txt', 'two\n');
    sb.commitAll(a, 'second');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    sb.write(b, 'f.txt', 'diverged\n');
    sb.commitAll(b, 'diverged');
    await expect(git.push(b, { branch: 'main' })).rejects.toBeInstanceOf(CliError);
    sb.git(b, ['fetch', '-q']);
    const lease = real(await git.push(b, { branch: 'main', forceWithLease: true }));
    expect(lease.success).toBe(true);
    sb.write(a, 'f.txt', 'three\n');
    sb.commitAll(a, 'third');
    const forced = real(await git.push(a, { branch: 'main', force: true }));
    expect(forced.success).toBe(true);
    expect(sb.git(bare, ['rev-parse', 'main']).stdout).toBe(sb.git(a, ['rev-parse', 'HEAD']).stdout);
  });

  test('fetch: new refs, tags, updated refs, prune, depth', async () => {
    const { a, b } = topology('fetch');
    const sb = sandbox();
    sb.git(a, ['push', '-q', 'origin', 'main:extra']);
    sb.git(a, ['tag', 't1']);
    sb.git(a, ['push', '-q', 'origin', 't1']);
    const f = real(await git.fetch(b));
    expect(f.remote).toBe('origin');
    expect(f.fetchedRefs).toEqual(expect.arrayContaining(['origin/extra', 't1']));

    sb.write(a, 'f.txt', 'two\n');
    sb.commitAll(a, 'second');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    sb.git(a, ['push', '-q', 'origin', ':extra']);
    const upd = real(await git.fetch(b, { remote: 'origin', prune: true, tags: true }));
    expect(upd.fetchedRefs).toContain('origin/main');
    // See test.failing below: git marks pruned refs with '-', the parser
    // only recognises 'x', so prunedRefs stays empty (ref is still pruned).
    expect(upd.prunedRefs).toEqual([]);
    expect(sb.git(b, ['rev-parse', '--verify', 'origin/extra'], { allowFail: true }).status).not.toBe(0);

    const shallow = real(await git.fetch(b, { depth: 1 }));
    expect(shallow.success).toBe(true);
    await expect(git.fetch(b, { remote: 'nowhere' })).rejects.toBeInstanceOf(CliError);
  });

  // KNOWN BUG (src/operations/remotes/fetch.ts): `git fetch --prune` prints
  // " - [deleted] (none) -> origin/x"; the parser only matches "x [deleted]".
  test.failing('fetch --prune reports pruned refs (currently broken)', async () => {
    const { a, b } = topology('fetch-prune');
    sandbox().git(a, ['push', '-q', 'origin', 'main:extra']);
    sandbox().git(b, ['fetch', '-q']);
    sandbox().git(a, ['push', '-q', 'origin', ':extra']);
    const r = real(await git.fetch(b, { prune: true }));
    expect(r.prunedRefs).toEqual(['origin/extra']);
  });

  test('pull: fast-forward, merge, rebase, ff-only failure, conflict', async () => {
    const { a, b } = topology('pull');
    const sb = sandbox();
    sb.write(a, 'f.txt', 'two\n');
    sb.commitAll(a, 'second');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    const ff = real(await git.pull(b));
    expect(ff).toMatchObject({ success: true, remote: 'origin', branch: 'HEAD', strategy: 'fast-forward', conflicts: false });
    expect(ff.filesChanged).toEqual(['f.txt']);

    sb.write(a, 'a-only.txt', 'a\n');
    sb.commitAll(a, 'a only');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    sb.write(b, 'b-only.txt', 'b\n');
    sb.commitAll(b, 'b only');
    await expect(git.pull(b, { fastForwardOnly: true })).rejects.toBeInstanceOf(CliError);
    const merged = real(await git.pull(b, { remote: 'origin', branch: 'main' }));
    expect(merged.strategy).toBe('merge');
    expect(merged.branch).toBe('main');

    sb.write(a, 'a2.txt', 'a\n');
    sb.commitAll(a, 'a2');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    sb.write(b, 'b2.txt', 'b\n');
    sb.commitAll(b, 'b2');
    expect(real(await git.pull(b, { rebase: true })).strategy).toBe('rebase');

    sb.git(b, ['push', '-q', 'origin', 'main']);
    sb.git(a, ['pull', '-q']);
    sb.write(a, 'f.txt', 'from a\n');
    sb.commitAll(a, 'a edit');
    sb.git(a, ['push', '-q', 'origin', 'main']);
    sb.write(b, 'f.txt', 'from b\n');
    sb.commitAll(b, 'b edit');
    const conflict = real(await git.pull(b));
    expect(conflict.conflicts).toBe(true);
    expect(conflict.conflictedFiles).toEqual(['f.txt']);
  });

  test('stub: fetch/push/pull argv and output parsing', async () => {
    const f = stubExec([
      {
        stderr: [
          ' * [new branch]      main       -> origin/main',
          ' + abc1234...def5678 dev        -> origin/dev  (forced update)',
          '   1111111..2222222  rel        -> origin/rel',
          ' - [deleted]         (none)     -> origin/old',
          ' x [deleted]         (none)     -> origin/gone',
        ].join('\n'),
      },
    ]);
    const fr = await executeFetch({ remote: 'up', prune: true, tags: true, depth: 2 }, ctx('/w'), f.fn);
    expect(f.calls[0]!.args).toEqual(['fetch', 'up', '--prune', '--tags', '--depth=2']);
    expect(fr.fetchedRefs).toEqual(['origin/main', 'origin/dev', 'origin/rel']);
    expect(fr.prunedRefs).toEqual(['origin/gone']);

    const p = stubExec([{ stderr: ' ! [rejected]        main -> main (fetch first)\n' }]);
    const pr = await executePush(
      { remote: 'up', branch: 'main', remoteBranch: 'main', forceWithLease: true, setUpstream: true, tags: true, dryRun: true },
      ctx('/w'),
      p.fn,
    );
    expect(p.calls[0]!.args).toEqual(['push', 'up', 'main', '--force-with-lease', '--set-upstream', '--tags', '--dry-run']);
    expect(pr.success).toBe(false);
    expect(pr.rejectedRefs).toEqual(['main']);

    const del = stubExec([{}]);
    await executePush({ delete: true, remoteBranch: 'gone' }, ctx('/w'), del.fn);
    expect(del.calls[0]!.args).toEqual(['push', '--delete', 'origin', 'HEAD:gone']);

    const pl = stubExec([{ stdout: 'Updating\n img.png | Bin 0 -> 3 bytes\n' }]);
    const plr = await executePull({ rebase: true, fastForwardOnly: true }, ctx('/w', true), pl.fn);
    expect(pl.calls[0]!.args).toEqual(['pull', 'origin', '--rebase', '--ff-only', '-S']);
    expect(plr.filesChanged).toEqual(['img.png']);
  });
});

// ---------------------------------------------------------------------------
// tags (incl. verify via fake gpg)
// ---------------------------------------------------------------------------

describe('tag', () => {
  test('create lightweight/annotated/message/at commit/force; list with metadata + limit; delete', async () => {
    const repo = sandbox().repo('tag');
    const first = sandbox().git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    sandbox().commitAll(repo, 'second');
    expect(mode(await git.tag(repo, { mode: 'create', tagName: 'light' }), 'create')).toEqual({
      mode: 'create',
      created: 'light',
      signed: false,
    });
    await git.tag(repo, { mode: 'create', tagName: 'ann', annotated: true });
    await git.tag(repo, { mode: 'create', tagName: 'v0.7.0', message: 'Release\n\nBody line', commit: first });
    await git.tag(repo, { mode: 'create', tagName: 'v0.10.0' });
    await expect(git.tag(repo, { mode: 'create', tagName: 'light' })).rejects.toBeInstanceOf(CliError);
    await git.tag(repo, { mode: 'create', tagName: 'light', commit: first, force: true });

    const list = mode(await git.tag(repo, { mode: 'list' }), 'list');
    const names = (list.tags ?? []).map((t) => t.name);
    expect(names.indexOf('v0.10.0')).toBeLessThan(names.indexOf('v0.7.0'));
    const v07 = list.tags?.find((t) => t.name === 'v0.7.0');
    expect(v07).toMatchObject({ message: 'Release', annotationBody: 'Body line', tagger: expect.stringContaining('Test Author') });
    expect(v07?.commit).toBe(first.slice(0, v07?.commit.length));
    const ann = list.tags?.find((t) => t.name === 'ann');
    expect(ann?.message).toBe('Tag ann');
    expect(list.tags?.find((t) => t.name === 'light')?.timestamp).toBeGreaterThan(0);

    expect(mode(await git.tag(repo, { mode: 'list', limit: 2 }), 'list').tags).toHaveLength(2);
    expect(mode(await git.tag(repo, { mode: 'delete', tagName: 'light' }), 'delete').deleted).toBe('light');
  });

  test('verify: not found throws; unsigned reports no signature', async () => {
    const repo = sandbox().repo('tag-verify');
    sandbox().git(repo, ['tag', '-a', 'unsigned', '-m', 'x']);
    await expect(git.tag(repo, { mode: 'verify', tagName: 'missing' })).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: 'Tag not found: missing',
    });
    const v = mode(await git.tag(repo, { mode: 'verify', tagName: 'unsigned' }), 'verify');
    expect(v).toMatchObject({ verifiedTag: 'unsigned', verified: false, warning: expect.stringContaining('no signature') });
  });

  const verifyCases: Array<[GpgMode, Record<string, unknown>]> = [
    ['good', { verified: true, signatureType: 'gpg', signerIdentity: 'Test Signer <s@example.test>', signerKey: 'ABCDEF0123456789' }],
    ['bad', { verified: false, signatureType: 'gpg', signerIdentity: 'Test Signer <s@example.test>' }],
    ['x509-good', { verified: true, signatureType: 'x509', signerIdentity: 'CN=Test Signer' }],
    ['ssh-unconfigured', { verified: false, signatureType: 'ssh', warning: expect.stringContaining('allowedSignersFile') }],
    ['ssh-bad', { verified: false, signatureType: 'ssh', signerIdentity: 'signer@example.test' }],
    ['ssh-good', { verified: true, signatureType: 'ssh', signerIdentity: 'signer@example.test', signerKey: 'SHA256:AbCdEf0123' }],
    ['unknown-ok', { verified: true }],
    ['unknown-fail', { verified: false, warning: expect.stringContaining('not recognized') }],
  ];

  test('signed tag via GIT_SIGN_COMMITS, then verify outcomes for every verifier output shape', async () => {
    const repo = sandbox().repo('tag-signed');
    sandbox().setGpgMode('good');
    const restore = setEnv({ GIT_SIGN_COMMITS: 'yes' });
    try {
      const created = mode(await new Git2().tag(repo, { mode: 'create', tagName: 'signed' }), 'create');
      expect(created.signed).toBe(true);
      await new Git2().tag(repo, { mode: 'create', tagName: 'signed-msg', message: 'custom' });
    } finally {
      restore();
    }
    try {
      for (const [gpgMode, expected] of verifyCases) {
        sandbox().setGpgMode(gpgMode);
        const v = mode(await git.tag(repo, { mode: 'verify', tagName: 'signed' }), 'verify');
        expect({ gpgMode, ...v }).toMatchObject({ gpgMode, ...expected });
      }
    } finally {
      sandbox().setGpgMode('good');
    }
  });

  test('signing failure falls back to an unsigned annotated tag with a warning', async () => {
    const repo = sandbox().repo('tag-sign-fail');
    sandbox().setGpgMode('sign-fail');
    const restore = setEnv({ GIT_SIGN_COMMITS: 'on' });
    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const t = mode(await new Git2().tag(repo, { mode: 'create', tagName: 'fallback', message: 'm' }), 'create');
      expect(t.signed).toBe(false);
      expect(t.signingWarning).toContain('signing failed');
    } finally {
      stderr.mockRestore();
      restore();
      sandbox().setGpgMode('good');
    }
  });

  test('stub: missing tag names, unknown mode, non-Error signing failure, ssh-bad without identity', async () => {
    const { fn } = stubExec([]);
    const bad: GitTagOptions[] = [
      { mode: 'create' },
      { mode: 'delete' },
      { mode: 'verify' },
      { mode: 'bogus' as GitTagOptions['mode'] },
    ];
    for (const o of bad) await expect(executeTag(o, ctx('/w'), fn)).rejects.toBeInstanceOf(CliError);

    const stderr = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      let n = 0;
      const calls: string[][] = [];
      const exec = async (args: string[]) => {
        calls.push(args);
        if (n++ === 0) throw 'no key';
        return { stdout: '', stderr: '' };
      };
      const r = await executeTag({ mode: 'create', tagName: 't', annotated: true }, ctx('/w', true), exec);
      expect(calls[0]).toEqual(['tag', 't', '-s', '--message=Tag t']);
      expect(calls[1]).toEqual(['-c', 'tag.gpgSign=false', 'tag', 't', '-a', '--message=Tag t']);
      expect(r.signingWarning).toContain('no key');
    } finally {
      stderr.mockRestore();
    }

    const v = stubExec([{ stderr: 'Could not verify signature.', exitCode: 1 }]);
    const res = await executeTag({ mode: 'verify', tagName: 't' }, ctx('/w'), v.fn);
    expect(res).toMatchObject({ verified: false, signatureType: 'ssh' });
    expect(res.signerIdentity).toBeUndefined();

    const gpgsmBad = stubExec([{ stderr: 'gpgsm: BAD signature from "CN=x"', exitCode: 1 }]);
    expect(await executeTag({ mode: 'verify', tagName: 't' }, ctx('/w'), gpgsmBad.fn)).toMatchObject({
      signatureType: 'x509',
      signerIdentity: 'CN=x',
    });
    const goodNoKey = stubExec([{ stderr: 'gpg: Good signature from "X"' }]);
    const gnk = await executeTag({ mode: 'verify', tagName: 't' }, ctx('/w'), goodNoKey.fn);
    expect(gnk.signerKey).toBeUndefined();

    const odd = stubExec([{ stdout: `\x1F\x1E\nonly${'\x1F'}\x1E` }]);
    const list = await executeTag({ mode: 'list' }, ctx('/w'), odd.fn);
    expect(list.tags).toEqual([{ name: 'only', commit: '' }]);
  });
});

// ---------------------------------------------------------------------------
// stash
// ---------------------------------------------------------------------------

describe('stash', () => {
  test('push (message/untracked/keep-index), list (+limit), apply, pop, drop, clear', async () => {
    const repo = sandbox().repo('stash', { 'a.txt': '1\n' });
    sandbox().write(repo, 'a.txt', '2\n');
    expect(mode(await git.stash(repo, { mode: 'push', message: 'first stash' }), 'push').created).toBe('stash@{0}');
    sandbox().write(repo, 'a.txt', '3\n');
    sandbox().write(repo, 'u.txt', 'u\n');
    sandbox().git(repo, ['add', 'a.txt']);
    await git.stash(repo, { mode: 'push', includeUntracked: true, keepIndex: true });
    expect(existsSync(join(repo, 'u.txt'))).toBe(false);

    const list = mode(await git.stash(repo, { mode: 'list' }), 'list');
    expect(list.stashes).toHaveLength(2);
    expect(list.stashes?.[1]).toMatchObject({ ref: 'stash@{1}', index: 1, branch: 'main', description: 'first stash' });
    expect(list.stashes?.[0]?.timestamp).toBeGreaterThan(0);
    expect(mode(await git.stash(repo, { mode: 'list', limit: 1 }), 'list').stashes).toHaveLength(1);

    sandbox().git(repo, ['reset', '-q', '--hard']);
    const applied = mode(await git.stash(repo, { mode: 'apply', stashRef: 'stash@{1}' }), 'apply');
    expect(applied).toMatchObject({ applied: 'stash@{1}', conflicts: false });
    sandbox().git(repo, ['reset', '-q', '--hard']);
    sandbox().git(repo, ['clean', '-qfd']);
    expect(mode(await git.stash(repo, { mode: 'pop' }), 'pop').applied).toBe('stash@{0}');
    expect(existsSync(join(repo, 'u.txt'))).toBe(true);

    expect(mode(await git.stash(repo, { mode: 'drop', stashRef: 'stash@{0}' }), 'drop').dropped).toBe('stash@{0}');
    sandbox().write(repo, 'a.txt', '9\n');
    await git.stash(repo, { mode: 'push' });
    expect(mode(await git.stash(repo, { mode: 'clear' }), 'clear').mode).toBe('clear');
    expect(mode(await git.stash(repo, { mode: 'list' }), 'list').stashes).toEqual([]);
    await expect(git.stash(repo, { mode: 'pop' })).rejects.toBeInstanceOf(CliError);
  });

  test('stub: drop without ref, unknown mode, odd list lines, conflict flag', async () => {
    const { fn } = stubExec([]);
    for (const o of [{ mode: 'drop' }, { mode: 'bogus' }] as GitStashOptions[]) {
      await expect(executeStash(o, ctx('/w'), fn)).rejects.toBeInstanceOf(CliError);
    }
    const l = stubExec([{ stdout: 'weird line\nnobrace\t5\tcustom subject\n' }]);
    expect(mode(await executeStash({ mode: 'list' }, ctx('/w'), l.fn), 'list').stashes).toEqual([
      { ref: 'stash@{0}', index: 0, branch: '', description: 'weird line', timestamp: 0 },
      { ref: 'stash@{1}', index: 1, branch: '', description: 'custom subject', timestamp: 5 },
    ]);
    const c = stubExec([{ stdout: 'CONFLICT (content): Merge conflict in a' }]);
    expect(await executeStash({ mode: 'apply' }, ctx('/w'), c.fn)).toMatchObject({ conflicts: true });
  });
});

// ---------------------------------------------------------------------------
// worktree
// ---------------------------------------------------------------------------

describe('worktree', () => {
  test('add (branch / detach / commitish), list, remove (force), prune', async () => {
    const repo = sandbox().repo('wt');
    const base = sandbox().dir('wt-trees');
    const wt1 = join(base, 'one');
    const wt2 = join(base, 'two');
    expect(mode(await git.worktree(repo, { mode: 'add', path: wt1, branch: 'wt-branch' }), 'add').added).toBe(wt1);
    await git.worktree(repo, { mode: 'add', path: wt2, detach: true, commitish: 'HEAD', force: true });

    const list = mode(await git.worktree(repo, { mode: 'list' }), 'list');
    expect(list.worktrees).toHaveLength(3);
    expect(list.worktrees?.[1]).toMatchObject({ path: wt1, branch: 'refs/heads/wt-branch', detached: false });
    expect(list.worktrees?.[2]).toMatchObject({ path: wt2, detached: true });

    sandbox().write(wt2, 'dirty.txt', 'x');
    await expect(git.worktree(repo, { mode: 'remove', path: wt2 })).rejects.toBeInstanceOf(CliError);
    expect(mode(await git.worktree(repo, { mode: 'remove', path: wt2, force: true }), 'remove').removed).toBe(wt2);
    expect(mode(await git.worktree(repo, { mode: 'prune', dryRun: true, verbose: true }), 'prune').pruned).toEqual([]);
    await git.worktree(repo, { mode: 'prune' });
  });

  test('move, missing args, unknown mode (stub) + porcelain flags parsing', async () => {
    const repo = sandbox().repo('wt-move');
    const base = sandbox().dir('wt-move-trees');
    await git.worktree(repo, { mode: 'add', path: join(base, 'a'), branch: 'mv' });
    const moved = mode(await git.worktree(repo, { mode: 'move', path: join(base, 'a'), newPath: join(base, 'b') }), 'move');
    expect(moved.moved).toEqual({ from: join(base, 'a'), to: join(base, 'b') });

    const { fn } = stubExec([]);
    const bad: GitWorktreeOptions[] = [
      { mode: 'add' },
      { mode: 'remove' },
      { mode: 'move', path: 'x' },
      { mode: 'bogus' as GitWorktreeOptions['mode'] },
    ];
    for (const o of bad) await expect(executeWorktree(o, ctx('/w'), fn)).rejects.toBeInstanceOf(CliError);

    const porcelain = stubExec([
      { stdout: 'worktree /bare\nbare\n\nworktree /locked\nHEAD abc\ndetached\nlocked reason\nprunable gone\n\nnot-a-key\n' },
    ]);
    expect(mode(await executeWorktree({ mode: 'list' }, ctx('/w'), porcelain.fn), 'list').worktrees).toEqual([
      { path: '/bare', head: '', bare: true, detached: false, locked: false, prunable: false },
      { path: '/locked', head: 'abc', bare: false, detached: true, locked: true, prunable: true },
    ]);
  });
});
