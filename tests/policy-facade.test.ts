/**
 * @fileoverview Policy gates on the Git2 facade (src/index.ts): every write
 * method returns a simulated DryRunResult under dryRun without touching the
 * repo, throws READONLY_VIOLATION under readOnly, and read methods (incl.
 * the read modes of branch/remote/tag/stash/worktree) still execute.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCode, isDryRunResult } from '@lmctl-ai/lmts/server';

import * as api from '../src/index.js';
import { Git2 } from '../src/index.js';
import { useSandbox, type Sandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('policy');

/** Snapshot of everything observable about a repo's state. */
function snapshot(sb: Sandbox, repo: string): string {
  return [
    sb.git(repo, ['rev-parse', 'HEAD']).stdout,
    sb.git(repo, ['for-each-ref']).stdout,
    sb.git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
    sb.git(repo, ['stash', 'list']).stdout,
    sb.git(repo, ['remote', '-v']).stdout,
    sb.git(repo, ['worktree', 'list', '--porcelain']).stdout,
    sb.git(repo, ['config', '--local', '--list']).stdout,
  ].join('\n--\n');
}

type WriteCall = [name: string, run: (g: Git2, repo: string, scratch: string) => Promise<unknown>];

const writeCalls: WriteCall[] = [
  ['git_init', (g, _r, s) => g.init({ path: join(s, 'new-repo') })],
  ['git_clone', (g, r, s) => g.clone({ remoteUrl: r, localPath: join(s, 'clone') })],
  ['git_clean', (g, r) => g.clean(r, { force: true, directories: true })],
  ['git_add', (g, r) => g.add(r, { paths: ['untracked.txt'] })],
  ['git_reset', (g, r) => g.reset(r, { mode: 'hard', commit: 'HEAD~1' })],
  ['git_commit', (g, r) => g.commit(r, { message: 'nope', allowEmpty: true })],
  ['git_branch:create', (g, r) => g.branch(r, { mode: 'create', branchName: 'x' })],
  ['git_branch:delete', (g, r) => g.branch(r, { mode: 'delete', branchName: 'side', force: true })],
  ['git_branch:rename', (g, r) => g.branch(r, { mode: 'rename', branchName: 'side', newBranchName: 'y' })],
  ['git_checkout', (g, r) => g.checkout(r, { target: 'side' })],
  ['git_merge', (g, r) => g.merge(r, { branch: 'side' })],
  ['git_rebase', (g, r) => g.rebase(r, { upstream: 'side' })],
  ['git_cherry_pick', (g, r) => g.cherryPick(r, { commits: ['side'] })],
  ['git_remote:add', (g, r) => g.remote(r, { mode: 'add', name: 'up', url: 'https://example.test/x.git' })],
  ['git_remote:remove', (g, r) => g.remote(r, { mode: 'remove', name: 'origin' })],
  ['git_remote:set-url', (g, r) => g.remote(r, { mode: 'set-url', name: 'origin', url: '/elsewhere' })],
  ['git_fetch', (g, r) => g.fetch(r)],
  ['git_push', (g, r) => g.push(r, { branch: 'main', force: true })],
  ['git_pull', (g, r) => g.pull(r)],
  ['git_tag:create', (g, r) => g.tag(r, { mode: 'create', tagName: 'v9' })],
  ['git_tag:delete', (g, r) => g.tag(r, { mode: 'delete', tagName: 'v1' })],
  ['git_stash:push', (g, r) => g.stash(r, { mode: 'push', includeUntracked: true })],
  ['git_stash:pop', (g, r) => g.stash(r, { mode: 'pop' })],
  ['git_stash:clear', (g, r) => g.stash(r, { mode: 'clear' })],
  ['git_worktree:add', (g, r, s) => g.worktree(r, { mode: 'add', path: join(s, 'wt') })],
  ['git_worktree:prune', (g, r) => g.worktree(r, { mode: 'prune' })],
];

/** Repo with history, a side branch, a tag, a stash, an origin remote and dirt. */
function richRepo(name: string): string {
  const sb = sandbox();
  const remote = sb.dir(`${name}-remote`);
  sb.git(remote, ['init', '-q', '--bare', '-b', 'main']);
  const repo = sb.repo(name, { 'a.txt': '1\n' });
  sb.write(repo, 'a.txt', '2\n');
  sb.commitAll(repo, 'second');
  sb.git(repo, ['branch', 'side', 'HEAD~1']);
  sb.git(repo, ['tag', 'v1']);
  sb.git(repo, ['remote', 'add', 'origin', remote]);
  sb.write(repo, 'a.txt', 'stashed\n');
  sb.git(repo, ['stash', 'push', '-q']);
  sb.write(repo, 'untracked.txt', 'u\n');
  return repo;
}

describe('dry-run policy', () => {
  test('constructor defaults and explicit policy', () => {
    expect(new Git2().policy).toEqual({ dryRun: false, readOnly: false });
    expect(new Git2({ policy: { dryRun: true } }).policy).toEqual({ dryRun: true, readOnly: false });
    expect(new Git2({ policy: { readOnly: true } }).policy).toEqual({ dryRun: false, readOnly: true });
  });

  test('every write method is simulated and leaves the repo byte-for-byte unchanged', async () => {
    const sb = sandbox();
    const repo = richRepo('dry');
    const scratch = sb.dir('dry-scratch');
    const before = snapshot(sb, repo);
    const g = new Git2({ policy: { dryRun: true } });
    for (const [name, run] of writeCalls) {
      const r = await run(g, repo, scratch);
      expect(isDryRunResult(r)).toBe(true);
      expect(r).toMatchObject({ success: true, dryRun: true, simulated: name });
    }
    expect(snapshot(sb, repo)).toBe(before);
    expect(existsSync(join(scratch, 'new-repo'))).toBe(false);
    expect(existsSync(join(scratch, 'clone'))).toBe(false);
    expect(existsSync(join(scratch, 'wt'))).toBe(false);
  });

  test('init/clone dry-run results carry the argv + working directory', async () => {
    const g = new Git2({ policy: { dryRun: true } });
    const simulated: unknown = await g.init({ path: '/nowhere/x' });
    expect(simulated).toEqual({
      success: true,
      dryRun: true,
      simulated: 'git_init',
      workingDirectory: '/nowhere/x',
      command: ['git2', 'init'],
    });
    expect(await g.clone({ remoteUrl: 'x', localPath: '/nowhere/y' })).toMatchObject({
      command: ['git2', 'clone'],
      workingDirectory: '/nowhere/y',
    });
  });
});

describe('read-only policy', () => {
  test('every write method throws READONLY_VIOLATION (exit 6) and changes nothing', async () => {
    const sb = sandbox();
    const repo = richRepo('ro');
    const scratch = sb.dir('ro-scratch');
    const before = snapshot(sb, repo);
    const g = new Git2({ policy: { readOnly: true } });
    for (const [name, run] of writeCalls) {
      const err = await run(g, repo, scratch).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: ErrorCode.ReadOnlyViolation, exitCode: 6 });
      expect((err as Error).message).toContain(`"${name}"`);
    }
    expect(snapshot(sb, repo)).toBe(before);
  });

  test('read-only takes precedence over dry-run', async () => {
    const g = new Git2({ policy: { readOnly: true, dryRun: true } });
    await expect(g.init({ path: '/nowhere' })).rejects.toMatchObject({ code: ErrorCode.ReadOnlyViolation });
  });

  test('read methods and read modes still execute under read-only and dry-run', async () => {
    const repo = richRepo('ro-reads');
    for (const policy of [{ readOnly: true }, { dryRun: true }]) {
      const g = new Git2({ policy });
      expect((await g.status(repo)).currentBranch).toBe('main');
      expect((await g.log(repo)).totalCount).toBe(2);
      expect((await g.show(repo, { object: 'HEAD' })).type).toBe('commit');
      expect(typeof (await g.diff(repo)).diff).toBe('string');
      expect((await g.blame(repo, { file: 'a.txt' })).totalLines).toBe(1);
      expect((await g.reflog(repo)).totalEntries).toBeGreaterThan(0);
      for (const r of [
        await g.branch(repo, { mode: 'list' }),
        await g.branch(repo, { mode: 'show-current' }),
        await g.remote(repo, { mode: 'list' }),
        await g.remote(repo, { mode: 'get-url', name: 'origin' }),
        await g.tag(repo, { mode: 'list' }),
        await g.tag(repo, { mode: 'verify', tagName: 'v1' }),
        await g.stash(repo, { mode: 'list' }),
        await g.worktree(repo, { mode: 'list' }),
      ]) {
        expect(isDryRunResult(r)).toBe(false);
      }
    }
  });
});

test('public API surface re-exports operations, executor and isDryRunResult', () => {
  expect(typeof api.executeGitCommand).toBe('function');
  expect(typeof api.executeStatus).toBe('function');
  expect(api.isDryRunResult({ dryRun: true })).toBe(true);
  expect(api.isDryRunResult({})).toBe(false);
});
