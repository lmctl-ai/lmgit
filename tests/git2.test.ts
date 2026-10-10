/**
 * @fileoverview Tests for git2: dry-run/readonly policy, real git operations
 * on a temporary repository, and output shape.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CliError, ErrorCode, isDryRunResult } from '@lmctl-ai/lmts/server';

import { Git2 } from '../src/index.js';
import { useSandbox } from './helpers/sandbox.js';

// Isolated HOME / git config / identity for every in-process git call.
useSandbox('git2');

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'git2-test-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('policy: dry-run', () => {
  test('write ops are simulated and do not execute', async () => {
    const git = new Git2({ policy: { dryRun: true } });
    const result = await git.init({ path: join(dir, 'dryrun-repo') });
    expect(isDryRunResult(result)).toBe(true);
    expect((result as { simulated?: string }).simulated).toBe('git_init');
    // The repo must NOT exist.
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, 'dryrun-repo', '.git'))).toBe(false);
  });

  test('read ops still execute under dry-run', async () => {
    // Create a real repo first (no policy).
    const real = new Git2();
    await real.init({ path: join(dir, 'real-repo') });
    const git = new Git2({ policy: { dryRun: true } });
    const status = await git.status(join(dir, 'real-repo'));
    expect(status.currentBranch).toBeDefined();
    expect(isDryRunResult(status)).toBe(false);
  });
});

describe('policy: read-only', () => {
  test('write ops throw ReadOnlyViolation', async () => {
    const git = new Git2({ policy: { readOnly: true } });
    await expect(git.init({ path: join(dir, 'ro-repo') })).rejects.toMatchObject({
      code: ErrorCode.ReadOnlyViolation,
    });
  });

  test('read ops still work under read-only', async () => {
    const git = new Git2({ policy: { readOnly: true } });
    const status = await git.status(join(dir, 'real-repo'));
    expect(status.isClean).toBe(true);
  });
});

describe('full workflow on a temp repo', () => {
  const repoDir = () => join(dir, 'flow');

  test('init -> add -> commit -> log -> branch -> checkout -> status', async () => {
    const git = new Git2({});

    const initResult = await git.init({ path: repoDir() });
    expect(isDryRunResult(initResult)).toBe(false);
    if (!isDryRunResult(initResult)) {
      expect(initResult.success).toBe(true);
      expect(initResult.path).toBe(repoDir());
    }

    writeFileSync(join(repoDir(), 'hello.txt'), 'hello world\n');

    const addResult = await git.add(repoDir(), { paths: ['hello.txt'] });
    expect(isDryRunResult(addResult)).toBe(false);

    const commitResult = await git.commit(repoDir(), { message: 'initial commit' });
    if (!isDryRunResult(commitResult)) {
      expect(commitResult.commitHash).toMatch(/^[0-9a-f]{40}$/u);
    }

    const logResult = await git.log(repoDir(), { maxCount: 5 });
    expect(logResult.commits.length).toBe(1);
    expect(logResult.commits[0]?.subject).toBe('initial commit');

    const branchResult = await git.branch(repoDir(), { mode: 'create', branchName: 'feature-x' });
    expect(isDryRunResult(branchResult)).toBe(false);

    const listResult = await git.branch(repoDir(), { mode: 'list' });
    if (!isDryRunResult(listResult) && listResult.mode === 'list') {
      const names = listResult.branches.map((b) => b.name);
      expect(names).toContain('feature-x');
    } else {
      throw new Error('expected list mode result');
    }

    const checkoutResult = await git.checkout(repoDir(), { target: 'feature-x' });
    expect(isDryRunResult(checkoutResult)).toBe(false);

    const statusAfter = await git.status(repoDir());
    expect(statusAfter.currentBranch).toBe('feature-x');
    expect(statusAfter.isClean).toBe(true);

    const tagResult = await git.tag(repoDir(), { mode: 'create', tagName: 'v0.1.0' });
    expect(isDryRunResult(tagResult)).toBe(false);

    const tagList = await git.tag(repoDir(), { mode: 'list' });
    if (!isDryRunResult(tagList) && tagList.mode === 'list') {
      expect(tagList.tags?.map((t) => t.name)).toContain('v0.1.0');
    }

    const blame = await git.blame(repoDir(), { file: 'hello.txt' });
    expect(blame.lines.length).toBeGreaterThan(0);

    const reflog = await git.reflog(repoDir(), { maxCount: 20 });
    expect(reflog.entries.length).toBeGreaterThan(0);

    const show = await git.show(repoDir(), { object: 'HEAD' });
    expect(show.object).toBe('HEAD');
    expect(show.type).toBe('commit');

    const diff = await git.diff(repoDir(), {});
    expect(typeof diff.diff).toBe('string');
    expect(diff.filesChanged ?? 0).toBe(0);
  });
});

describe('errors', () => {
  test('status on a non-repo path raises CliError', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'git2-notrepo-'));
    try {
      const git = new Git2();
      await expect(git.status(notRepo)).rejects.toBeInstanceOf(CliError);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
