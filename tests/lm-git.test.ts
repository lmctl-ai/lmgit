/**
 * @fileoverview Tests for the lmprobe-ported structured git reads: byte
 * preservation, URL redaction, status classification, ahead/behind branches,
 * ls-files stages, and blame.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Git2 } from '../src/index.js';
import {
  bytesText,
  lmBlame,
  lmBranch,
  lmDiff,
  lmLog,
  lmLsFiles,
  lmRemote,
  lmRevParse,
  lmShow,
  lmStatus,
  redactUrlBytes,
} from '../src/lm-git.js';
import { useSandbox } from './helpers/sandbox.js';

// Isolated HOME / git config / identity for every in-process git call.
useSandbox('lmgit-base');

let dir: string;
let repo: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'git2-lm-'));
  repo = join(dir, 'repo');
  const git = new Git2();
  await git.init({ path: repo });
  writeFileSync(join(repo, 'a.txt'), 'hello\nmore\n');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  await git.add(repo, { paths: ['a.txt', 'README.md'] });
  await git.commit(repo, { message: 'initial' });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('byte preservation', () => {
  test('bytesText passes through valid UTF-8', () => {
    expect(bytesText(Buffer.from('hello'))).toBe('hello');
    // Unicode
    expect(bytesText(Buffer.from('λ', 'utf-8'))).toBe('λ');
  });
  test('bytesText wraps non-UTF8 as bytes_hex', () => {
    const raw = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0xff]);
    expect(bytesText(raw)).toEqual({ bytes_hex: '6e616d65ff' });
  });
});

describe('URL redaction (mirrors lmprobe redact_url_bytes)', () => {
  test('strips userinfo and query/fragment from https', () => {
    expect(
      redactUrlBytes(Buffer.from('https://user:password@example.com/repo.git?token=s#frag')),
    ).toBe('https://example.com/repo.git');
  });
  test('preserves IPv6 host with port', () => {
    expect(
      redactUrlBytes(Buffer.from('https://user:p$ss@[2001:db8::1]:8443/repo.git?token=x')),
    ).toBe('https://[2001:db8::1]:8443/repo.git');
  });
  test('leaves local and scp-style paths alone', () => {
    expect(redactUrlBytes(Buffer.from('/tmp/repo?x'))).toBe('/tmp/repo?x');
    expect(redactUrlBytes(Buffer.from('user@example.com:repo.git'))).toBe('user@example.com:repo.git');
  });
  test('non-UTF8 fallback uses bytes_hex', () => {
    const raw = Buffer.from('https://user@example.com/repo/\xff', 'latin1');
    expect(redactUrlBytes(raw)).toEqual({
      bytes_hex: Buffer.from('https://example.com/repo/\xff', 'latin1').toString('hex'),
    });
  });
});

describe('lm_status', () => {
  test('clean on a fresh committed tree', async () => {
    const result = await lmStatus(repo);
    // Initial commit done above; after it the worktree should be clean
    expect(result.clean).toBe(true);
    expect(result.unborn).toBe(false);
    expect(result.workdir).toBe(repo);
    expect(result.detached).toBe(false);
  });

  test('detects modified + untracked with independent index/worktree', async () => {
    writeFileSync(join(repo, 'a.txt'), 'hello\nmore\nchanged\n');
    writeFileSync(join(repo, 'newfile.txt'), 'new\n');
    const result = await lmStatus(repo);
    expect(result.clean).toBe(false);
    const row = result.rows.find((r) => (typeof r.path === 'string' ? r.path : '') === 'a.txt');
    expect(row).toBeDefined();
    expect(row?.worktree_status).toBe('modified');
    expect(row?.index_status).toBe('clean');
    const untracked = result.rows.some((r) => r.untracked === true);
    expect(untracked).toBe(true);
  });

  test('staged and worktree state diverge correctly', async () => {
    const git = new Git2();
    writeFileSync(join(repo, 'split.txt'), 'v1\n');
    await git.add(repo, { paths: ['split.txt'] });
    writeFileSync(join(repo, 'split.txt'), 'v1\nworktree-change\n'); // worktree divergence
    const result = await lmStatus(repo);
    const row = result.rows.find(
      (r) => (typeof r.path === 'string' ? r.path : '') === 'split.txt',
    );
    expect(row?.index_status).toBe('added');
    expect(row?.worktree_status).toBe('modified');
  });
});

describe('lm_log', () => {
  test('returns commits newest-first with full metadata', async () => {
    const result = await lmLog(repo, 'HEAD', 10);
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    const first = result.rows[0]!;
    expect(first.id).toMatch(/^[0-9a-f]{40}$/u);
    expect(first.summary).toBe('initial');
    expect(first.author).toBeDefined();
    expect(first.committer).toBeDefined();
    expect(first.parents).toEqual([]);
  });

  test('unborn HEAD returns empty rows (not an error)', async () => {
    const newRepo = join(dir, 'unborn-repo');
    const git = new Git2();
    await git.init({ path: newRepo });
    const result = await lmLog(newRepo, 'HEAD', 10);
    expect(result.rows).toEqual([]);
  });
});

describe('lm_diff', () => {
  test('unstaged diff returns rows with hunks and byte-preserving lines', async () => {
    const result = await lmDiff(repo, {});
    expect(result.stats.files).toBeGreaterThan(0);
    const row = result.rows[0]!;
    expect(typeof row['path']).toBeDefined();
    const hunks = row['hunks'] as Array<Record<string, unknown>>;
    expect(hunks.length).toBeGreaterThan(0);
    const lines = hunks[0]!['lines'] as Array<{ origin: string; content: string }>;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => ['+', '-', ' ', '\\'].includes(l.origin))).toBe(true);
  });

  test('--staged cannot combine with `to` (mirrors lmprobe)', async () => {
    await expect(lmDiff(repo, { staged: true, to: 'HEAD' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

describe('lm_show', () => {
  test('shows a commit', async () => {
    const result = (await lmShow(repo, 'HEAD')) as { commit?: { id?: string; summary?: string } };
    expect(result.commit?.id).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.commit?.summary).toBe('initial');
  });

  test('shows a file from a revision', async () => {
    const result = await lmShow(repo, 'HEAD', 'a.txt');
    expect((result as { content?: unknown }).content).toBeDefined();
  });
});

describe('lm_branch', () => {
  test('returns current branch with no upstream', async () => {
    const result = await lmBranch(repo, false);
    const main = result.rows.find((r) => r.current === true);
    expect(main).toBeDefined();
    expect(main?.name).toBe('main');
    expect(main?.upstream).toBeNull();
  });
});

describe('lm_remote', () => {
  test('empty when no remotes', async () => {
    const result = await lmRemote(repo);
    expect(result.rows).toEqual([]);
  });
});

describe('lm_rev_parse', () => {
  test('resolves HEAD', async () => {
    const result = await lmRevParse(repo, 'HEAD');
    expect(result.oid).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.kind).toBe('commit');
    expect(result.commit).toBe(result.oid);
  });
});

describe('lm_ls_files', () => {
  test('returns index entries with mode and stage', async () => {
    const result = await lmLsFiles(repo, []);
    expect(result.rows.length).toBeGreaterThan(0);
    const a = result.rows.find((r) => r['path'] === 'a.txt');
    expect(a?.['mode']).toBe('100644');
    expect(a?.['stage']).toBe(0);
  });
});

describe('lm_blame', () => {
  test('blames a single-line file with author metadata', async () => {
    const result = await lmBlame(repo, 'README.md', 'HEAD');
    expect(result.rows.length).toBe(1);
    const row = result.rows[0]!;
    expect(row['line']).toBe(1);
    expect(row['author']).toBeDefined();
    expect((row['author'] as { name: string }).name).toBeDefined();
    expect(row['commit']).toMatch(/^[0-9a-f]{40}$/u);
  });
});
