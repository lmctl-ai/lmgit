/**
 * @fileoverview End-to-end tests for the git2 CLI (src/cli.ts), spawned as
 * `bun src/cli.ts ...` with cwd set to a temp repo and an isolated env
 * (HOME / git config in the sandbox). Covers discovery (--help/--list/
 * --schema/--explain), every op through argv or --input-json/--input-file/
 * --input-graphql, the JSON error envelope + exit codes, and policy gates
 * (--dryrun, --readonly, GIT2_DRYRUN / GIT2_READONLY env floors, --confirm).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ALL_GIT2_SCHEMAS } from '../src/schemas.js';
import { rec, recs, runCli, useSandbox, type CliRun, type Sandbox } from './helpers/sandbox.js';

const sandbox = useSandbox('cli');

function ok(r: CliRun): Record<string, unknown> {
  if (r.status !== 0) throw new Error(`expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  return rec(r.json);
}

function fail(r: CliRun, exit: number, code: string): Record<string, unknown> {
  expect({ status: r.status, code: rec(rec(r.json)['error'])['code'] }).toEqual({ status: exit, code });
  const env = rec(r.json);
  expect(env['success']).toBe(false);
  return rec(env['error']);
}

function snapshot(sb: Sandbox, repo: string): string {
  return [
    sb.git(repo, ['rev-parse', 'HEAD']).stdout,
    sb.git(repo, ['for-each-ref']).stdout,
    sb.git(repo, ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
    sb.git(repo, ['stash', 'list']).stdout,
    sb.git(repo, ['config', '--local', '--list']).stdout,
  ].join('\n--\n');
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------

describe('discovery', () => {
  test('no args and --help print tool help; op --help prints op help', () => {
    const cwd = sandbox().dir('help');
    for (const args of [[], ['--help'], ['-h']]) {
      const r = runCli(sandbox(), cwd, args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('git2');
      expect(r.stdout).toContain('lm_status');
      expect(r.stdout).toContain('--dryrun');
    }
    const op = runCli(sandbox(), cwd, ['commit', '--help']);
    expect(op.status).toBe(0);
    expect(op.stdout).toContain('--message');
  });

  test('--list: every op with access, description and schema', () => {
    const r = runCli(sandbox(), sandbox().dir('list'), ['--list']);
    const ops = recs(r.json);
    expect(r.status).toBe(0);
    expect(ops.map((o) => o['name']).sort()).toEqual(ALL_GIT2_SCHEMAS.map((s) => s.name).sort());
    for (const o of ops) {
      const schema = ALL_GIT2_SCHEMAS.find((s) => s.name === o['name'])!;
      expect(o['access']).toBe(schema.access!);
      expect(typeof o['description']).toBe('string');
      expect(o['schema']).toBeDefined();
    }
  });

  test('--schema publishes a versioned document with globals', () => {
    const r = runCli(sandbox(), sandbox().dir('schema'), ['--schema']);
    const doc = ok(r);
    const text = JSON.stringify(doc);
    expect(text).toContain('git2');
    expect(text).toContain('0.1.0');
    expect(text).toContain('lm_blame');
    expect(text).toContain('readonly');
    expect(text).not.toMatch(/"derived"\s*:\s*true/);
  });

  test('--explain json / text / errors', () => {
    const cwd = sandbox().dir('explain');
    expect(ok(runCli(sandbox(), cwd, ['--explain', 'status']))['name']).toBe('status');
    const text = runCli(sandbox(), cwd, ['--explain', 'clone', '--format', 'text']);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('--remote-url');
    fail(runCli(sandbox(), cwd, ['--explain']), 2, 'INVALID_REQUEST');
    fail(runCli(sandbox(), cwd, ['--explain', 'nope']), 2, 'INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// errors / validation
// ---------------------------------------------------------------------------

describe('error envelope + exit codes', () => {
  test('unknown op, missing op, validation errors, mixed input', () => {
    const repo = sandbox().repo('errors');
    const sb = sandbox();
    expect(fail(runCli(sb, repo, ['frobnicate']), 2, 'INVALID_REQUEST')['message']).toContain('Unknown operation');
    expect(fail(runCli(sb, repo, ['--dryrun']), 2, 'INVALID_REQUEST')['message']).toBe('No operation specified');
    fail(runCli(sb, repo, ['commit']), 2, 'VALIDATION_ERROR');
    fail(runCli(sb, repo, ['status', '--bogus-flag']), 2, 'VALIDATION_ERROR');
    fail(runCli(sb, repo, ['reset', '--mode', 'sideways']), 2, 'VALIDATION_ERROR');
    fail(runCli(sb, repo, ['log', '--max-count', 'many']), 2, 'VALIDATION_ERROR');
    const mixed = fail(runCli(sb, repo, ['commit', '--message', 'x', '--input-json', '{"message":"y"}']), 2, 'VALIDATION_ERROR');
    expect(JSON.stringify(mixed)).toContain('MIXED_INPUT');
    fail(runCli(sb, repo, ['status', '--input-json', '{not json']), 2, 'VALIDATION_ERROR');
    fail(runCli(sb, repo, ['status', '--input-json', '{"op":"log","params":{}}']), 2, 'VALIDATION_ERROR');
    fail(runCli(sb, repo, ['status', '--input-file', join(repo, 'missing.json')]), 2, 'INVALID_REQUEST');
  });

  test('runtime git failures map to codes: not a repo, missing ref, NOT_FOUND, COMMAND_FAILED', () => {
    const sb = sandbox();
    const plain = sb.dir('not-a-repo');
    expect(fail(runCli(sb, plain, ['status']), 2, 'INVALID_REQUEST')['message']).toContain('not a git repository');
    const repo = sb.repo('rt-errors');
    // cat-file's "Not a valid object name" matches no mapper pattern.
    fail(runCli(sb, repo, ['show', '--object', 'no-such-ref']), 1, 'INTERNAL_ERROR');
    fail(runCli(sb, repo, ['log', '--branch', 'no-such-ref']), 2, 'INVALID_REQUEST');
    fail(runCli(sb, repo, ['lm_rev_parse', '--revision', 'no-such-ref']), 4, 'NOT_FOUND');
    fail(runCli(sb, repo, ['lm_show', '--file', 'missing.txt']), 4, 'NOT_FOUND');
    fail(runCli(sb, repo, ['lm_diff', '--from', 'no-such-ref']), 1, 'COMMAND_FAILED');
    fail(runCli(sb, repo, ['lm_diff', '--staged', '--to', 'HEAD']), 2, 'INVALID_REQUEST');
    fail(runCli(sb, repo, ['status', '--path', join(repo, 'nope')]), 2, 'INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// read ops
// ---------------------------------------------------------------------------

describe('read ops via argv', () => {
  test('status / log / show / diff / blame / reflog / branch / remote / tag / stash / worktree', () => {
    const sb = sandbox();
    const repo = sb.repo('reads', { 'a.txt': 'one\n', 'sp ace.txt': 's\n' });
    sb.git(repo, ['tag', '-a', 'v1', '-m', 'v1']);
    sb.git(repo, ['remote', 'add', 'origin', 'https://user:pw@example.test/r.git']);
    sb.write(repo, 'a.txt', 'two\n');
    sb.git(repo, ['stash', 'push', '-q', '-m', 'saved']);
    sb.write(repo, 'a.txt', 'three\n');

    expect(ok(runCli(sb, repo, ['status']))).toMatchObject({ currentBranch: 'main', isClean: false });
    expect(ok(runCli(sb, repo, ['status', '--no-include-untracked', '--path', '.']))['currentBranch']).toBe('main');
    expect(recs(ok(runCli(sb, repo, ['log', '--max-count', '1']))['commits'])[0]!['subject']).toBe('initial');
    expect(ok(runCli(sb, repo, ['show', '--object', 'HEAD', '--file-path', 'a.txt']))['content']).toBe('one\n');
    expect(ok(runCli(sb, repo, ['diff', '--paths', 'a.txt', '--unified', '0']))['filesChanged']).toBe(1);
    expect(ok(runCli(sb, repo, ['blame', '--file', 'sp ace.txt']))['totalLines']).toBe(1);
    expect(ok(runCli(sb, repo, ['reflog', '--max-count', '5']))['ref']).toBe('HEAD');
    expect(recs(ok(runCli(sb, repo, ['branch_list']))['branches'])[0]!['name']).toBe('main');
    expect(ok(runCli(sb, repo, ['branch_current']))['current']).toBe('main');
    expect(recs(ok(runCli(sb, repo, ['remote_list']))['remotes'])[0]!['name']).toBe('origin');
    // NB: the non-lm remote ops return the raw configured URL (no redaction).
    expect(ok(runCli(sb, repo, ['remote_get_url', '--name', 'origin']))['url']).toBe('https://user:pw@example.test/r.git');
    expect(recs(ok(runCli(sb, repo, ['tag_list', '--limit', '5']))['tags'])[0]!['name']).toBe('v1');
    expect(ok(runCli(sb, repo, ['tag_verify', '--tag-name', 'v1']))['verified']).toBe(false);
    expect(recs(ok(runCli(sb, repo, ['stash_list']))['stashes'])[0]!['description']).toBe('saved');
    expect(recs(ok(runCli(sb, repo, ['worktree_list']))['worktrees'])).toHaveLength(1);
  });

  test('lm_* ops, incl. remote credential redaction and --path relative to cwd', () => {
    const sb = sandbox();
    const parent = sb.dir('lm-parent');
    const repo = join(parent, 'repo');
    sb.git(parent, ['init', '-q', '-b', 'main', repo]);
    sb.write(repo, 'f.txt', 'x\n');
    sb.commitAll(repo, 'first');
    sb.git(repo, ['remote', 'add', 'origin', 'https://user:hunter2@example.test/r.git?access_token=zzz']);
    sb.write(repo, 'f.txt', 'y\n');

    const st = ok(runCli(sb, repo, ['lm_status']));
    expect(st['clean']).toBe(false);
    expect(recs(st['rows'])[0]).toMatchObject({ path: 'f.txt', worktree_status: 'modified' });
    expect(ok(runCli(sb, repo, ['lm_status', '--ignored']))['clean']).toBe(false);

    // lm_status resolves --path against the process cwd
    expect(ok(runCli(sb, parent, ['lm_status', '--path', 'repo']))['workdir']).toBe(repo);
    // other ops resolve --path through resolvePath (relative to cwd too)
    expect(ok(runCli(sb, parent, ['lm_log', '--path', 'repo', '--max-count', '1']))['maxCount']).toBe(1);

    const remote = ok(runCli(sb, repo, ['lm_remote']));
    expect(recs(remote['rows'])[0]!['fetch_url']).toBe('https://example.test/r.git');
    expect(JSON.stringify(remote)).not.toMatch(/hunter2|access_token/);

    expect(recs(ok(runCli(sb, repo, ['lm_diff', '--paths', 'f.txt']))['rows'])[0]!['path']).toBe('f.txt');
    expect(recs(ok(runCli(sb, repo, ['lm_log']))['rows'])[0]!['summary']).toBe('first');
    expect(rec(ok(runCli(sb, repo, ['lm_show']))['commit'])['summary']).toBe('first');
    expect(ok(runCli(sb, repo, ['lm_show', '--revision', 'HEAD', '--file', 'f.txt']))['content']).toBe('x\n');
    expect(recs(ok(runCli(sb, repo, ['lm_branch', '--all']))['rows'])[0]!['name']).toBe('main');
    expect(ok(runCli(sb, repo, ['lm_rev_parse']))['kind']).toBe('commit');
    expect(recs(ok(runCli(sb, repo, ['lm_ls_files', '--paths', 'f.txt']))['rows'])).toHaveLength(1);
    expect(recs(ok(runCli(sb, repo, ['lm_blame', '--file', 'f.txt']))['rows'])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// write ops
// ---------------------------------------------------------------------------

describe('write ops via argv and documents', () => {
  test('init / add / commit / branch / checkout / merge / cherry_pick / reset / clean / tag / stash', () => {
    const sb = sandbox();
    const cwd = sb.dir('writes');
    const repo = join(cwd, 'r');
    expect(ok(runCli(sb, cwd, ['init', '--path', 'r', '--initial-branch', 'main']))['path']).toBe(repo);
    sb.write(repo, 'a.txt', 'a\n');
    expect(ok(runCli(sb, repo, ['add', '--paths', 'a.txt']))['stagedFiles']).toEqual(['a.txt']);
    const c = ok(
      runCli(sb, repo, ['--input-json', JSON.stringify({ op: 'commit', params: { message: 'first', author: { name: 'JSON Author', email: 'j@example.test' } } })]),
    );
    expect(c['author']).toBe('JSON Author');

    ok(runCli(sb, repo, ['branch_create', '--branch-name', 'feat']));
    ok(runCli(sb, repo, ['checkout', '--target', 'feat']));
    sb.write(repo, 'f.txt', 'f\n');
    ok(runCli(sb, repo, ['add', '--all']));
    const fc = ok(runCli(sb, repo, ['commit', '--message', 'feat work']));
    ok(runCli(sb, repo, ['checkout', '--target', 'main']));
    expect(ok(runCli(sb, repo, ['merge', '--branch', 'feat']))['fastForward']).toBe(true);

    ok(runCli(sb, repo, ['checkout', '--target', 'pick', '--create-branch']));
    sb.write(repo, 'p.txt', 'p\n');
    ok(runCli(sb, repo, ['add', '--paths', 'p.txt']));
    const pc = ok(runCli(sb, repo, ['commit', '--message', 'to pick']));
    ok(runCli(sb, repo, ['checkout', '--target', 'main']));
    expect(ok(runCli(sb, repo, ['cherry_pick', '--commits', String(pc['commitHash'])]))['conflicts']).toBe(false);

    ok(runCli(sb, repo, ['branch_rename', '--branch-name', 'pick', '--new-branch-name', 'picked']));
    ok(runCli(sb, repo, ['branch_delete', '--branch-name', 'picked', '--force']));
    expect(ok(runCli(sb, repo, ['reset', '--mode', 'soft', '--commit', String(fc['commitHash'])]))['filesReset']).toEqual(['p.txt']);
    ok(runCli(sb, repo, ['commit', '--message', 're-commit']));

    sb.write(repo, 'junk.txt', 'j');
    expect(ok(runCli(sb, repo, ['clean', '--dry-run']))['filesRemoved']).toEqual(['junk.txt']);
    // NB: "dangerous" ops (clean --force, reset --mode hard, push --force)
    // are NOT gated behind --confirm in git2 (Git2.guard never passes
    // dangerous: true), so they run without it; --confirm is accepted.
    expect(ok(runCli(sb, repo, ['clean', '--force']))['filesRemoved']).toEqual(['junk.txt']);
    sb.write(repo, 'a.txt', 'dirty\n');
    expect(ok(runCli(sb, repo, ['reset', '--mode', 'hard']))['filesReset']).toEqual(['a.txt']);
    expect(ok(runCli(sb, repo, ['reset', '--mode', 'hard', '--confirm']))['success']).toBe(true);

    ok(runCli(sb, repo, ['tag_create', '--tag-name', 'v1', '--message', 'release']));
    ok(runCli(sb, repo, ['tag_delete', '--tag-name', 'v1']));

    sb.write(repo, 'a.txt', 's1\n');
    ok(runCli(sb, repo, ['stash_push', '--message', 'one']));
    ok(runCli(sb, repo, ['stash_apply']));
    sb.git(repo, ['checkout', '-q', '--', 'a.txt']);
    ok(runCli(sb, repo, ['stash_pop']));
    sb.git(repo, ['checkout', '-q', '--', 'a.txt']);
    sb.write(repo, 'a.txt', 's2\n');
    ok(runCli(sb, repo, ['stash_push', '--include-untracked', '--keep-index']));
    ok(runCli(sb, repo, ['stash_drop', '--stash-ref', 'stash@{0}']));
    ok(runCli(sb, repo, ['stash_clear']));
    expect(sb.git(repo, ['log', '--format=%s']).stdout.split('\n').filter(Boolean)).toEqual([
      're-commit', // soft reset folded the cherry-picked commit into this one
      'feat work',
      'first',
    ]);
  });

  test('remotes: clone / remote_* / fetch / push / pull against a local bare repo', () => {
    const sb = sandbox();
    const base = sb.dir('cli-remote');
    const bare = join(base, 'r.git');
    sb.git(base, ['init', '-q', '--bare', '-b', 'main', bare]);
    const seed = join(base, 'seed');
    sb.git(base, ['clone', '-q', bare, seed]);
    sb.commitAll(seed, 'seed');
    sb.git(seed, ['push', '-q', 'origin', 'main']);

    const cl = ok(runCli(sb, base, ['clone', '--remote-url', bare, '--local-path', join(base, 'work')]));
    const work = String(cl['localPath']);
    expect(cl['branch']).toBe('main');

    ok(runCli(sb, work, ['remote_add', '--name', 'mirror', '--url', bare]));
    ok(runCli(sb, work, ['remote_set_url', '--name', 'mirror', '--url', bare, '--push']));
    ok(runCli(sb, work, ['remote_remove', '--name', 'mirror']));

    sb.commitAll(seed, 'upstream change');
    sb.git(seed, ['push', '-q', 'origin', 'main']);
    expect(ok(runCli(sb, work, ['fetch', '--prune', '--tags']))['fetchedRefs']).toEqual(['origin/main']);
    expect(ok(runCli(sb, work, ['pull', '--remote', 'origin', '--branch', 'main']))['strategy']).toBe('fast-forward');

    sb.write(work, 'w.txt', 'w\n');
    sb.commitAll(work, 'from work');
    expect(ok(runCli(sb, work, ['push', '--dry-run']))['success']).toBe(true);
    expect(sb.git(bare, ['log', '-1', '--format=%s']).stdout.trim()).toBe('upstream change');
    ok(runCli(sb, work, ['push', '--branch', 'main', '--set-upstream']));
    expect(sb.git(bare, ['log', '-1', '--format=%s']).stdout.trim()).toBe('from work');
    sb.git(work, ['commit', '-q', '--amend', '-m', 'rewritten']);
    fail(runCli(sb, work, ['push', '--branch', 'main']), 1, 'INTERNAL_ERROR');
    ok(runCli(sb, work, ['push', '--branch', 'main', '--force']));
    expect(sb.git(bare, ['log', '-1', '--format=%s']).stdout.trim()).toBe('rewritten');
  });

  test('worktree_add / worktree_remove / worktree_prune use --repo as working dir, --path as payload', () => {
    const sb = sandbox();
    const repo = sb.repo('cli-wt');
    const elsewhere = sb.dir('cli-wt-cwd');
    const wt = join(sb.dir('cli-wt-trees'), 'tree');
    expect(ok(runCli(sb, elsewhere, ['worktree_add', '--repo', repo, '--path', wt, '--branch', 'wtb']))['added']).toBe(wt);
    expect(existsSync(join(wt, 'README.md'))).toBe(true);
    expect(recs(ok(runCli(sb, repo, ['worktree_list']))['worktrees'])).toHaveLength(2);
    ok(runCli(sb, elsewhere, ['worktree_remove', '--repo', repo, '--path', wt, '--force']));
    ok(runCli(sb, repo, ['worktree_prune', '--dry-run', '--verbose']));
    expect(existsSync(wt)).toBe(false);
  });

  test('--input-file, --input-graphql and root-level {op, params} envelopes', () => {
    const sb = sandbox();
    const repo = sb.repo('cli-docs');
    const doc = join(sb.dir('cli-docs-in'), 'in.json');
    writeFileSync(doc, JSON.stringify({ op: 'branch_create', params: { branchName: 'from-file' } }));
    expect(ok(runCli(sb, repo, ['--input-file', doc]))['created']).toBe('from-file');
    expect(ok(runCli(sb, repo, ['branch_create', '--input-json', '{"branchName":"bare-params"}']))['created']).toBe(
      'bare-params',
    );
    const gql = ok(runCli(sb, repo, ['--input-graphql', 'mutation { tag_create(tagName: "gql-tag") { __typename } }']));
    expect(gql['created']).toBe('gql-tag');
    expect(sb.git(repo, ['branch', '--list']).stdout).toContain('from-file');
    fail(runCli(sb, repo, ['--input-json', '{"params":{}}']), 2, 'INVALID_REQUEST');
  });
});

// ---------------------------------------------------------------------------
// policy gates
// ---------------------------------------------------------------------------

describe('policy gates via the CLI', () => {
  const writeInvocations: string[][] = [
    ['commit', '--message', 'x', '--allow-empty'],
    ['branch_create', '--branch-name', 'nope'],
    ['tag_create', '--tag-name', 'nope'],
    ['reset', '--mode', 'hard', '--commit', 'HEAD~1'],
    ['clean', '--force', '--directories'],
    ['stash_push', '--include-untracked'],
    ['remote_add', '--name', 'x', '--url', 'https://example.test/x.git'],
    ['push', '--force'],
    ['checkout', '--target', 'side'],
    ['init', '--path', 'sub'],
  ];

  function policyRepo(name: string): string {
    const sb = sandbox();
    const repo = sb.repo(name, { 'a.txt': '1\n' });
    sb.write(repo, 'a.txt', '2\n');
    sb.commitAll(repo, 'second');
    sb.git(repo, ['branch', 'side', 'HEAD~1']);
    sb.write(repo, 'a.txt', 'dirty\n');
    sb.write(repo, 'untracked.txt', 'u\n');
    return repo;
  }

  test('--dryrun returns the simulated result and leaves the repo unchanged', () => {
    const sb = sandbox();
    const repo = policyRepo('dry');
    const before = snapshot(sb, repo);
    for (const args of writeInvocations) {
      const r = ok(runCli(sb, repo, [...args, '--dryrun']));
      expect(r).toMatchObject({ success: true, dryRun: true });
      expect(String(r['simulated'])).toMatch(/^git_/);
    }
    // The global alias --dry-run works for ops without their own dryRun param...
    expect(ok(runCli(sb, repo, ['commit', '--message', 'x', '--allow-empty', '--dry-run']))['simulated']).toBe('git_commit');
    // ...but clean/push/worktree_prune declare a `dryRun` param, which wins
    // over the global alias: `--dry-run` there means git's own -n/--dry-run
    // (git still runs, read-only), not the policy simulation.
    const own = ok(runCli(sb, repo, ['clean', '--dry-run']));
    expect(own['simulated']).toBeUndefined();
    expect(own['filesRemoved']).toEqual(['untracked.txt']);
    expect(snapshot(sb, repo)).toBe(before);
    expect(existsSync(join(repo, 'sub'))).toBe(false);
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf-8')).toBe('u\n');
  });

  test('--readonly refuses every write op with READONLY_VIOLATION (exit 6); reads still work', () => {
    const sb = sandbox();
    const repo = policyRepo('ro');
    const before = snapshot(sb, repo);
    for (const args of writeInvocations) {
      for (const flag of ['--readonly', '--read-only']) {
        const err = fail(runCli(sb, repo, [...args, flag]), 6, 'READONLY_VIOLATION');
        expect(String(err['message'])).toContain('read-only mode');
      }
    }
    expect(snapshot(sb, repo)).toBe(before);
    for (const args of [['status'], ['log'], ['branch_list'], ['lm_status'], ['lm_remote'], ['stash_list'], ['tag_list']]) {
      expect(runCli(sb, repo, [...args, '--readonly']).status).toBe(0);
    }
  });

  test('env floors: GIT2_READONLY / GIT2_DRYRUN (truthy spellings) and falsy values', () => {
    const sb = sandbox();
    const repo = policyRepo('env');
    const before = snapshot(sb, repo);
    for (const v of ['1', 'true', 'YES', 'on']) {
      fail(runCli(sb, repo, ['branch_create', '--branch-name', 'e'], { GIT2_READONLY: v }), 6, 'READONLY_VIOLATION');
      expect(ok(runCli(sb, repo, ['branch_create', '--branch-name', 'e'], { GIT2_DRYRUN: v }))['dryRun']).toBe(true);
    }
    // readonly wins over dryrun when both are set
    fail(runCli(sb, repo, ['commit', '--message', 'x', '--dryrun'], { GIT2_READONLY: '1' }), 6, 'READONLY_VIOLATION');
    expect(runCli(sb, repo, ['status'], { GIT2_READONLY: '1' }).status).toBe(0);
    expect(snapshot(sb, repo)).toBe(before);
    // falsy values do not enable the floors
    expect(ok(runCli(sb, repo, ['branch_create', '--branch-name', 'real'], { GIT2_READONLY: '0', GIT2_DRYRUN: 'no' }))['created']).toBe(
      'real',
    );
  });

  test('--confirm / --i-understand are accepted and do not bypass --readonly', () => {
    const sb = sandbox();
    const repo = policyRepo('confirm');
    fail(runCli(sb, repo, ['reset', '--mode', 'hard', '--confirm', '--readonly']), 6, 'READONLY_VIOLATION');
    expect(ok(runCli(sb, repo, ['clean', '--force', '--i-understand']))['filesRemoved']).toEqual(['untracked.txt']);
  });
});

// ---------------------------------------------------------------------------
// known CLI <-> operation option mismatches
// ---------------------------------------------------------------------------

describe('known schema/option mismatches (documented)', () => {
  // KNOWN BUG (src/cli.ts + schemas.ts): the rebase schema exposes
  // `branch`/`abort`/`continueOp`, but executeRebase reads `upstream`/`mode`,
  // so `git2 rebase --branch main` always fails with "upstream is required".
  test.failing('rebase --branch <upstream> rebases (currently broken)', () => {
    const sb = sandbox();
    const repo = sb.repo('cli-rebase');
    sb.git(repo, ['checkout', '-q', '-b', 'topic']);
    sb.commitAll(repo, 'topic');
    sb.git(repo, ['checkout', '-q', 'main']);
    sb.commitAll(repo, 'main');
    sb.git(repo, ['checkout', '-q', 'topic']);
    ok(runCli(sb, repo, ['rebase', '--branch', 'main']));
  });

  test('rebase via CLI currently fails with INTERNAL_ERROR', () => {
    const sb = sandbox();
    const repo = sb.repo('cli-rebase-now');
    expect(String(fail(runCli(sb, repo, ['rebase', '--branch', 'main']), 1, 'INTERNAL_ERROR')['message'])).toContain(
      'upstream is required',
    );
  });

  // KNOWN BUG: log schema param `file` is passed through as `file`, but
  // executeLog filters on `path`, so --file is silently ignored.
  test.failing('log --file filters by file (currently ignored)', () => {
    const sb = sandbox();
    const repo = sb.repo('cli-log-file', { 'a.txt': 'a\n' });
    sb.write(repo, 'b.txt', 'b\n');
    sb.commitAll(repo, 'add b');
    const r = ok(runCli(sb, repo, ['log', '--file', 'a.txt']));
    expect(recs(r['commits'])).toHaveLength(1);
  });
});
