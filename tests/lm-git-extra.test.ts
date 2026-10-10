/**
 * @fileoverview Deeper coverage for the lmprobe-style read-only inspection
 * ops in src/lm-git.ts against real repos: status classification (renames,
 * conflicts, typechanges, ignored, unicode / space / non-UTF8 names), the
 * repo envelope (bare / detached / shallow / unborn), diff parsing (renames,
 * modes, binary, no-newline markers, revision ranges), log/show/rev-parse
 * edge cases, branch upstream tracking, remote credential redaction from
 * real git config, ls-files stages and blame groups.
 */

import { describe, expect, test } from 'bun:test';
import { chmodSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ErrorCode } from '@lmctl-ai/lmts/server';

import {
  __bytesTextAsString__,
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
  pathText,
  redactUrlBytes,
} from '../src/lm-git.js';
import { AUTHOR_EMAIL, AUTHOR_NAME, FIXED_EPOCH, recs, useSandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('lmgit');

type Row = Record<string, unknown>;
const byPath = (rows: Row[], p: string) => rows.filter((r) => r['path'] === p);

describe('byte helpers', () => {
  test('pathText / __bytesTextAsString__', () => {
    expect(pathText('plain λ')).toBe('plain λ');
    expect(__bytesTextAsString__(undefined)).toBeUndefined();
    expect(__bytesTextAsString__('s')).toBe('s');
    expect(__bytesTextAsString__({ bytes_hex: 'ff' })).toBe('ff');
    expect(bytesText(Buffer.alloc(0))).toBe('');
  });

  test('redactUrlBytes: scheme-only authority, ssh:// userinfo, fragment-only', () => {
    expect(redactUrlBytes(Buffer.from('https://tok@host'))).toBe('https://host');
    expect(redactUrlBytes(Buffer.from('ssh://git:secret@host:22/r.git'))).toBe('ssh://host:22/r.git');
    expect(redactUrlBytes(Buffer.from('https://host/p#frag'))).toBe('https://host/p');
    expect(redactUrlBytes(Buffer.from('https://a@b@host/p?q'))).toBe('https://host/p');
  });
});

describe('lm_status classification', () => {
  test('modified/added/deleted/untracked/ignored + unicode and space names', async () => {
    const sb = sandbox();
    const repo = sb.repo('st', { '.gitignore': '*.log\n', 'mod.txt': '1\n', 'del.txt': 'd\n', 'wt-del.txt': 'w\n' });
    sb.write(repo, 'mod.txt', '2\n');
    sb.git(repo, ['rm', '-q', 'del.txt']);
    unlinkSync(join(repo, 'wt-del.txt'));
    sb.write(repo, 'ünï cødé file.txt', 'u\n');
    sb.write(repo, 'added.txt', 'a\n');
    sb.git(repo, ['add', 'added.txt']);
    sb.write(repo, 'x.log', 'l\n');

    const r = await lmStatus(repo);
    expect(r.clean).toBe(false);
    const rows = r.rows as unknown as Row[];
    expect(byPath(rows, 'mod.txt')[0]).toMatchObject({ index_status: 'clean', worktree_status: 'modified' });
    expect(byPath(rows, 'del.txt')[0]).toMatchObject({ index_status: 'deleted', worktree_status: 'clean' });
    expect(byPath(rows, 'wt-del.txt')[0]).toMatchObject({ worktree_status: 'deleted' });
    expect(byPath(rows, 'added.txt')[0]).toMatchObject({ index_status: 'added' });
    expect(byPath(rows, 'ünï cødé file.txt')[0]).toMatchObject({
      untracked: true,
      index_status: 'untracked',
      worktree_status: 'untracked',
    });
    expect(byPath(rows, 'x.log')).toEqual([]);

    const withIgnored = await lmStatus(repo, true);
    expect(byPath(withIgnored.rows as unknown as Row[], 'x.log')[0]).toMatchObject({
      ignored: true,
      index_status: 'ignored',
    });
  });

  test('ignored-only tree is not clean when ignored files are requested', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-ign', { '.gitignore': '*.log\n' });
    sb.write(repo, 'x.log', 'l\n');
    expect((await lmStatus(repo)).clean).toBe(true);
    expect((await lmStatus(repo, true)).clean).toBe(false);
  });

  test('typechange (file -> symlink)', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-type', { 'link.txt': 'file\n' });
    unlinkSync(join(repo, 'link.txt'));
    symlinkSync('README.md', join(repo, 'link.txt'));
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    expect(byPath(rows, 'link.txt')[0]).toMatchObject({ worktree_status: 'typechanged' });
  });

  test('conflicts: UU and AA are flagged conflicted', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-conflict', { 'c.txt': 'base\n' });
    sb.git(repo, ['checkout', '-q', '-b', 'other']);
    sb.write(repo, 'c.txt', 'other\n');
    sb.write(repo, 'both.txt', 'other\n');
    sb.commitAll(repo, 'other');
    sb.git(repo, ['checkout', '-q', 'main']);
    sb.write(repo, 'c.txt', 'main\n');
    sb.write(repo, 'both.txt', 'main\n');
    sb.commitAll(repo, 'main');
    sb.git(repo, ['merge', 'other'], { allowFail: true });
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    expect(byPath(rows, 'c.txt')[0]).toMatchObject({ conflicted: true, index_status: 'conflicted', worktree_status: 'conflicted' });
    expect(byPath(rows, 'both.txt')[0]).toMatchObject({ conflicted: true, index_status: 'added', worktree_status: 'added' });

    // ls-files exposes the conflict stages 1/2/3
    const ls = (await lmLsFiles(repo, ['c.txt'])).rows;
    expect(ls.map((r) => r['stage'])).toEqual([1, 2, 3]);
  });

  // KNOWN BUG (src/lm-git.ts lmStatus): with `--porcelain=v1 -z`, a rename is
  // emitted as "R  <new>\0<old>\0" (no " -> "), so the old path becomes a
  // separate bogus entry and index_old_path is never set.
  test.failing('staged rename yields one row with old/new paths (currently broken)', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-rename-ok', { 'old-name.txt': 'content\n' });
    sb.git(repo, ['mv', 'old-name.txt', 'new-name.txt']);
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ index_status: 'renamed', index_old_path: 'old-name.txt' });
  });

  test('staged rename: current behaviour (old path parsed as a bogus extra row)', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-rename', { 'old-name.txt': 'content\n' });
    sb.git(repo, ['mv', 'old-name.txt', 'new-name.txt']);
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    expect(rows[0]).toMatchObject({ path: 'new-name.txt', index_status: 'renamed' });
    expect(rows[0]!['index_old_path']).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  test('" -> " rename splitting branch (only reachable when the new name contains " -> ")', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-arrow', { 'src.txt': 'content\n' });
    sb.git(repo, ['mv', 'src.txt', 'a -> b.txt']);
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    expect(rows[0]).toMatchObject({ index_status: 'renamed', index_old_path: 'a', index_new_path: 'b.txt', path: 'b.txt' });
  });

  test('non-UTF8 filename: bytes are lost to U+FFFD before lm-git sees them', async () => {
    const sb = sandbox();
    const repo = sb.repo('st-bytes');
    const raw = Buffer.concat([Buffer.from(join(repo, 'bad-')), Buffer.from([0xff, 0xfe]), Buffer.from('.txt')]);
    writeFileSync(raw, 'x');
    const rows = (await lmStatus(repo)).rows as unknown as Row[];
    // The executor decodes git's stdout as UTF-8 text, so invalid bytes become
    // U+FFFD and pathText() round-trips them as a plain string. The
    // {bytes_hex} wrapping is therefore only reachable via bytesText() on raw
    // Buffers (see lm-git.test.ts), not through real git output.
    expect(rows[0]!['path']).toBe('bad-��.txt');
  });
});

describe('repo envelope', () => {
  test('unborn, detached, bare and shallow repos', async () => {
    const sb = sandbox();
    const unborn = sb.dir('env-unborn');
    sb.git(unborn, ['init', '-q', '-b', 'main']);
    expect(await lmStatus(unborn)).toMatchObject({ unborn: true, head: null, detached: false, headName: 'main', clean: true });

    const repo = sb.repo('env-detached');
    sb.git(repo, ['checkout', '-q', '--detach']);
    const det = await lmStatus(repo);
    expect(det.detached).toBe(true);
    expect(det.headName).toBeUndefined();
    expect(det.head).toMatch(/^[0-9a-f]{40}$/);

    const bare = sb.dir('env-bare');
    sb.git(bare, ['init', '-q', '--bare', '-b', 'main']);
    expect(await lmStatus(bare)).toMatchObject({ bare: true, workdir: null, rows: [] });

    const src = sb.repo('env-src');
    sb.commitAll(src, 'two');
    const shallow = join(sb.dir('env-shallow'), 's');
    sb.git(sb.root, ['clone', '-q', '--depth', '1', `file://${src}`, shallow]);
    expect((await lmStatus(shallow)).shallow).toBe(true);
  });
});

describe('lm_diff', () => {
  test('added/deleted/renamed/mode/binary/no-newline with hunk details', async () => {
    const sb = sandbox();
    const repo = sb.repo('diff', {
      'keep.txt': 'line1\nline2\n',
      'gone.txt': 'bye\n',
      'move-me.txt': 'stable content that survives the rename\n'.repeat(5),
      'script.sh': 'echo hi\n',
      'img.bin': '\0\x01\x02',
      'func.c': 'int main() {\n  int a = 1;\n  int b = 2;\n  int c = 3;\n  int d = 4;\n  return 0;\n}\n',
    });
    sb.write(repo, 'keep.txt', 'line1\nline2 changed');
    sb.git(repo, ['rm', '-q', 'gone.txt']);
    sb.git(repo, ['mv', 'move-me.txt', 'moved.txt']);
    chmodSync(join(repo, 'script.sh'), 0o755);
    sb.write(repo, 'img.bin', '\0\x09\x09');
    sb.write(repo, 'func.c', 'int main() {\n  int a = 1;\n  int b = 2;\n  int c = 3;\n  int d = 4;\n  return 1;\n}\n');
    sb.write(repo, 'fresh.txt', 'new\n');
    sb.git(repo, ['add', '-A']);

    const d = await lmDiff(repo, { staged: true });
    const rows = d.rows;
    const find = (p: string) => rows.find((r) => r['path'] === p)!;
    expect(find('fresh.txt')).toMatchObject({ status: 'added', new_mode: '100644', additions: 1 });
    expect(find('gone.txt')).toMatchObject({ status: 'deleted', old_mode: '100644', deletions: 1 });
    expect(find('moved.txt')).toMatchObject({ status: 'renamed', old_path: 'move-me.txt', new_path: 'moved.txt' });
    expect(find('script.sh')).toMatchObject({ old_mode: '100644', new_mode: '100755' });
    expect(find('img.bin')).toMatchObject({ binary: true });

    const keep = find('keep.txt');
    expect(keep['old_oid']).toMatch(/^[0-9a-f]+$/);
    const hunk = recs(keep['hunks'])[0]!;
    expect(hunk).toMatchObject({ old_start: 1, old_lines: 2, new_start: 1, new_lines: 2 });
    const lines = recs(hunk['lines']);
    expect(lines.map((l) => l['origin'])).toEqual([' ', '-', '+', '\\']);
    expect(lines[3]!['content']).toBe(' No newline at end of file');

    const fn = recs(find('func.c')['hunks'])[0]!;
    expect(fn['header']).toBe('int main() {');
    expect(d.stats.files).toBe(rows.length);
    expect(d.stats.insertions).toBeGreaterThan(0);
  });

  test('revision forms: from, from+to, staged+from, paths; single-line hunks', async () => {
    const sb = sandbox();
    const repo = sb.repo('diff-revs', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    sb.write(repo, 'a.txt', 'A\n');
    sb.write(repo, 'b.txt', 'B\n');
    sb.commitAll(repo, 'second');

    const range = await lmDiff(repo, { from: 'HEAD~1', to: 'HEAD' });
    expect(range.rows.map((r) => r['path'])).toEqual(['a.txt', 'b.txt']);
    const h = recs(range.rows[0]!['hunks'])[0]!;
    expect(h).toMatchObject({ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1 });

    const onlyB = await lmDiff(repo, { from: 'HEAD~1', paths: ['b.txt'] });
    expect(onlyB.rows.map((r) => r['path'])).toEqual(['b.txt']);

    sb.write(repo, 'a.txt', 'staged\n');
    sb.git(repo, ['add', 'a.txt']);
    const stagedFrom = await lmDiff(repo, { staged: true, from: 'HEAD~1' });
    expect(stagedFrom.rows.map((r) => r['path'])).toEqual(['a.txt', 'b.txt']);
    expect((await lmDiff(repo, { paths: ['b.txt'] })).rows).toEqual([]);
  });

  test('bad revision => COMMAND_FAILED', async () => {
    const repo = sandbox().repo('diff-bad');
    await expect(lmDiff(repo, { from: 'no-such-rev' })).rejects.toMatchObject({ code: ErrorCode.CommandFailed });
  });
});

describe('lm_log / lm_show / lm_rev_parse', () => {
  test('log: merges, multi-line bodies, truncation, revision, bad input', async () => {
    const sb = sandbox();
    const repo = sb.repo('log');
    sb.git(repo, ['checkout', '-q', '-b', 'side']);
    sb.write(repo, 's.txt', 's\n');
    sb.git(repo, ['add', 's.txt']);
    sb.git(repo, ['commit', '-q', '-m', 'side subject', '-m', 'body para']);
    sb.git(repo, ['checkout', '-q', 'main']);
    sb.write(repo, 'm.txt', 'm\n');
    sb.commitAll(repo, 'main');
    sb.git(repo, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);

    const r = await lmLog(repo, 'HEAD', 2);
    expect(r.truncated).toBe(true);
    expect(r.rows[0]!.parents).toHaveLength(2);
    expect(r.rows[0]!.summary).toBe('merge side');
    expect(r.rows[0]!.author).toEqual({ name: AUTHOR_NAME, email: AUTHOR_EMAIL, time: FIXED_EPOCH });

    const side = await lmLog(repo, 'side', 10);
    expect(side.truncated).toBe(false);
    expect(side.rows[0]!.message).toBe('side subject\n\nbody para');
    expect(side.rows[0]!.summary).toBe('side subject');

    expect((await lmLog(repo, 'no-such-rev', 5)).rows).toEqual([]);

    await expect(lmLog(repo, 'HEAD', 0)).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  test('log: history that breaks mid-walk (missing parent object) => COMMAND_FAILED', async () => {
    const sb = sandbox();
    const repo = sb.repo('log-corrupt');
    const root = sb.git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    for (const m of ['two', 'three', 'four']) sb.commitAll(repo, m);
    // Loose objects only (gc.auto=0): deleting the root commit's object file
    // makes `git log` print the newest commits, then die with exit 128 while
    // traversing further, i.e. non-zero exit with non-empty stdout.
    unlinkSync(join(repo, '.git', 'objects', root.slice(0, 2), root.slice(2)));
    await expect(lmLog(repo, 'HEAD', 10)).rejects.toMatchObject({ code: ErrorCode.CommandFailed });
  });

  test('show: commit body, missing file => NOT_FOUND, bad revision => COMMAND_FAILED', async () => {
    const sb = sandbox();
    const repo = sb.repo('show', { 'f.txt': 'f\n' });
    sb.git(repo, ['commit', '-q', '--allow-empty', '-m', 'subject', '-m', 'details']);
    const c = (await lmShow(repo, 'HEAD')) as { commit: Record<string, unknown> };
    expect(c.commit).toMatchObject({ summary: 'subject', message: 'subject\n\ndetails' });
    expect(c.commit['parents']).toHaveLength(1);
    expect(await lmShow(repo, 'HEAD~1', 'f.txt')).toMatchObject({ file: 'f.txt', content: 'f\n', revision: 'HEAD~1' });
    await expect(lmShow(repo, 'HEAD', 'missing.txt')).rejects.toMatchObject({ code: ErrorCode.NotFound });
    await expect(lmShow(repo, 'no-such-rev')).rejects.toMatchObject({ code: ErrorCode.CommandFailed });
  });

  test('rev-parse: annotated tag peels to commit, tree has no commit, unknown => NOT_FOUND', async () => {
    const sb = sandbox();
    const repo = sb.repo('revparse');
    sb.git(repo, ['tag', '-a', 'v1', '-m', 'annotated']);
    const head = sb.git(repo, ['rev-parse', 'HEAD']).stdout.trim();
    const tag = await lmRevParse(repo, 'v1');
    expect(tag.kind).toBe('tag');
    expect(tag.commit).toBe(head);
    expect(tag.oid).not.toBe(head);
    const tree = await lmRevParse(repo, 'HEAD^{tree}');
    expect(tree.kind).toBe('tree');
    expect(tree.commit).toBeUndefined();
    await expect(lmRevParse(repo, 'nope')).rejects.toMatchObject({ code: ErrorCode.NotFound });
  });
});

describe('lm_branch upstream tracking', () => {
  test('ahead/behind against upstream, --all includes remotes, gone upstream => partial warning', async () => {
    const sb = sandbox();
    const base = sb.dir('br');
    const bare = join(base, 'r.git');
    sb.git(base, ['init', '-q', '--bare', '-b', 'main', bare]);
    const a = join(base, 'a');
    sb.git(base, ['clone', '-q', bare, a]);
    sb.commitAll(a, 'one');
    sb.git(a, ['push', '-q', '-u', 'origin', 'main']);
    sb.git(a, ['push', '-q', 'origin', 'main:doomed']);
    const b = join(base, 'b');
    sb.git(base, ['clone', '-q', bare, b]);
    sb.commitAll(a, 'two');
    sb.git(a, ['push', '-q']);
    sb.git(b, ['fetch', '-q']);
    sb.commitAll(b, 'local');

    const r = await lmBranch(b, false);
    expect(r.partial).toBe(false);
    expect(r.rows[0]).toMatchObject({ name: 'main', current: true, upstream: 'origin/main', ahead: 1, behind: 1, remote: false });

    const all = await lmBranch(b, true);
    expect(all.rows.some((x) => x['remote'] === true && x['name'] === 'origin/doomed')).toBe(true);

    sb.git(b, ['branch', '-q', '--track', 'tracks-doomed', 'origin/doomed']);
    sb.git(b, ['update-ref', '-d', 'refs/remotes/origin/doomed']);
    const gone = await lmBranch(b, false);
    const tracking = gone.rows.find((x) => x['name'] === 'tracks-doomed');
    // git still reports the configured upstream (its ref is gone), so
    // ahead/behind can't be computed => partial result with a warning.
    expect(tracking).toMatchObject({ upstream: 'origin/doomed' });
    expect(tracking?.['ahead']).toBeUndefined();
    expect(gone.partial).toBe(true);
    expect('warnings' in gone ? gone.warnings[0] : undefined).toMatchObject({ code: 'GIT_GRAPH_INCOMPLETE' });
  });
});

describe('lm_remote redaction from real git config', () => {
  test('fetch/push URLs and refspecs, credentials stripped', async () => {
    const sb = sandbox();
    const repo = sb.repo('remote');
    sb.git(repo, ['remote', 'add', 'origin', 'https://user:s3cret@example.test/r.git?token=abc#frag']);
    sb.git(repo, ['config', '--add', 'remote.origin.url', 'https://other:pw@mirror.example.test/r.git']);
    sb.git(repo, ['config', 'remote.origin.pushurl', 'ssh://deploy:key@example.test:2222/r.git']);
    sb.git(repo, ['config', 'remote.origin.push', 'refs/heads/main:refs/heads/main']);
    sb.git(repo, ['remote', 'add', 'scp', 'git@example.test:org/r.git']);
    sb.git(repo, ['remote', 'add', 'local', '/srv/repos/r.git']);
    sb.git(repo, ['config', 'remote.weird.fetch', '+refs/heads/*:refs/remotes/weird/*']);

    const r = await lmRemote(repo);
    const origin = r.rows.find((x) => x['name'] === 'origin')!;
    expect(origin).toEqual({
      name: 'origin',
      fetch_url: 'https://example.test/r.git',
      push_url: 'ssh://example.test:2222/r.git',
      configured_fetch_urls: ['https://example.test/r.git', 'https://mirror.example.test/r.git'],
      configured_push_urls: ['ssh://example.test:2222/r.git'],
      fetch_refspecs: ['+refs/heads/*:refs/remotes/origin/*'],
      push_refspecs: ['refs/heads/main:refs/heads/main'],
    });
    expect(JSON.stringify(r)).not.toMatch(/s3cret|token=|pw@|key@/);
    expect(r.rows.find((x) => x['name'] === 'scp')).toMatchObject({
      fetch_url: 'git@example.test:org/r.git',
      push_url: 'git@example.test:org/r.git',
    });
    expect(r.rows.find((x) => x['name'] === 'local')!['fetch_url']).toBe('/srv/repos/r.git');
    const weird = r.rows.find((x) => x['name'] === 'weird')!;
    expect(weird).toMatchObject({ fetch_url: null, push_url: null, configured_fetch_urls: [] });
  });

  test('valueless boolean config keys do not break parsing', async () => {
    const sb = sandbox();
    const repo = sb.repo('remote-bool');
    const cfg = join(repo, '.git', 'config');
    // `[weird] flag` (no value) is emitted by `config --list --null` as a
    // bare "weird.flag\0" record without the key/value newline.
    writeFileSync(cfg, '[core]\n\tbare = false\n\trepositoryformatversion = 0\n[weird]\n\tflag\n');
    expect((await lmRemote(repo)).rows).toEqual([]);
  });
});

describe('lm_ls_files / lm_blame', () => {
  test('ls-files: path filter, executable mode, unicode names', async () => {
    const sb = sandbox();
    const repo = sb.repo('ls', { 'run.sh': '#!/bin/sh\n', 'dir/ü.txt': 'u\n' });
    chmodSync(join(repo, 'run.sh'), 0o755);
    sb.git(repo, ['add', 'run.sh']);
    const all = await lmLsFiles(repo);
    expect(all.rows.find((r) => r['path'] === 'run.sh')?.['mode']).toBe('100755');
    expect((await lmLsFiles(repo, ['dir'])).rows.map((r) => r['path'])).toEqual(['dir/ü.txt']);
  });

  test('blame: grouped lines, tz offset, failure => COMMAND_FAILED', async () => {
    const sb = sandbox();
    const repo = sb.repo('blame', { 'b.txt': 'one\ntwo\nthree\n' });
    sb.write(repo, 'b.txt', 'one\nTWO\nthree\nfour\n');
    sb.commitAll(repo, 'edit');
    const r = await lmBlame(repo, 'b.txt', 'HEAD');
    expect(r.rows.map((x) => x['content'])).toEqual(['one', 'TWO', 'three', 'four']);
    expect(r.rows.map((x) => x['line'])).toEqual([1, 2, 3, 4]);
    expect(r.rows[0]!['author']).toEqual({ name: AUTHOR_NAME, email: AUTHOR_EMAIL, time: FIXED_EPOCH, offset_minutes: 0 });
    expect(r.rows[1]!['commit']).not.toBe(r.rows[0]!['commit']);

    await expect(lmBlame(repo, 'missing.txt', 'HEAD')).rejects.toMatchObject({ code: ErrorCode.CommandFailed });
  });
});
