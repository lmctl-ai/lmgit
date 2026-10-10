/**
 * @fileoverview Read-only git inspection ops, ported from
 * lmctl-ai/lmprobe crates/lmprobe/src/git_command.rs.
 *
 * These ops mirror lmprobe's semantics while executing via the git binary
 * under git2's existing executor + policy:
 *  - Byte-preserving fields: non-UTF8 strings are wrapped as {bytes_hex:...}.
 *  - Remote URLs are redacted (credentials stripped from fetch/push URLs).
 *  - Branches include upstream ahead/behind where computable.
 *  - All ops are read-only.
 * @module git2/lm-git
 */

import { execGitCommandSafe } from './utils/git-executor.js';
import { CliError, ErrorCode } from '@lmctl-ai/lmts/server';

// ---------------------------------------------------------------------------
// Byte-preserving helpers (mirror Rust bytes_text / path_text)
// ---------------------------------------------------------------------------

export type BytesText = string | { bytes_hex: string };

export function bytesText(input: Buffer): BytesText {
  const utf8 = input.toString('utf-8');
  // Re-encode compare: if UTF-8 roundtrip differs from input, encode as hex.
  if (Buffer.from(utf8, 'utf-8').equals(input)) {
    return utf8;
  }
  return { bytes_hex: input.toString('hex') };
}

export function pathText(input: string): BytesText {
  return bytesText(Buffer.from(input, 'utf-8'));
}

function btStr(value: BytesText | undefined): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : value.bytes_hex;
}

// ---------------------------------------------------------------------------
// URL redaction (mirror Rust redact_url_bytes)
// ---------------------------------------------------------------------------

export function redactUrlBytes(urlBytes: Buffer): BytesText {
  const s = urlBytes.toString('latin1');
  const schemeEnd = s.indexOf('://');
  if (schemeEnd < 0) {
    return bytesText(urlBytes); // local path / scp-style — leave unchanged
  }
  const rest = s.slice(schemeEnd + 3);
  const authorityEndIdx = rest.search(/[/?#]/);
  const authority = authorityEndIdx < 0 ? rest : rest.slice(0, authorityEndIdx);
  const suffix = authorityEndIdx < 0 ? '' : rest.slice(authorityEndIdx);
  const suffixEndIdx = suffix.search(/[?#]/);
  const suffixPart = suffixEndIdx < 0 ? suffix : suffix.slice(0, suffixEndIdx);
  const hostStartFrom = authority.lastIndexOf('@') + 1;
  const afterAuthority = authority.slice(hostStartFrom);
  const redactedLatin1 = s.slice(0, schemeEnd + 3) + afterAuthority + suffixPart;
  return bytesText(Buffer.from(redactedLatin1, 'latin1'));
}

// ---------------------------------------------------------------------------
// Shared error wrapper
// ---------------------------------------------------------------------------

function fail(command: string, message: string, data?: Record<string, unknown>): never {
  throw new CliError(ErrorCode.CommandFailed, `git ${command} failed: ${message}`, data);
}

async function get(repo: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await execGitCommandSafe(args, repo);
  return { stdout: result.stdout, exitCode: result.exitCode ?? 0 };
}

// ---------------------------------------------------------------------------
// Repo envelope (mirror the lmprobe rust envelope metadata)
// ---------------------------------------------------------------------------

export interface LmRepoEnvelope {
  repo: string; // git admin dir
  workdir?: string | null;
  head?: string | null;
  headName?: BytesText | null;
  unborn: boolean;
  detached: boolean;
  bare: boolean;
  shallow: boolean;
}

async function lmEnvelope(repo: string): Promise<LmRepoEnvelope> {
  const { stdout: adminDir } = await get(repo, ['rev-parse', '--git-dir']);
  const { stdout: isBare } = await get(repo, ['rev-parse', '--is-bare-repository']);
  const { stdout: workTree } = await get(repo, ['rev-parse', '--is-inside-work-tree']);
  const { stdout: workdirOut } = await get(repo, ['rev-parse', '--show-toplevel']);
  const { stdout: shallowOut } = await get(repo, ['rev-parse', '--is-shallow-repository']);
  const { stdout: headOid, exitCode: headEx } = await get(repo, ['rev-parse', '--verify', 'HEAD']);
  const { stdout: headNameOut } = await get(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);

  const bare = isBare.trim() === 'true';
  const inside = workTree.trim() === 'true';
  const unborn = headEx !== 0;
  const headName = headNameOut.trim();
  const detached = !unborn && headName === '';

  const adminDirAbs = adminDir.trim();
  return {
    repo: adminDirAbs,
    workdir: inside && workdirOut.trim() ? workdirOut.trim() : null,
    head: unborn ? null : headOid.trim(),
    unborn,
    detached,
    bare,
    shallow: shallowOut.trim() === 'true',
    ...(headName ? { headName: pathText(headName) } : {}),
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

interface StatusRow {
  path: BytesText;
  index_status: string;
  worktree_status: string;
  index_old_path?: BytesText | null;
  index_new_path?: BytesText | null;
  worktree_old_path?: BytesText | null;
  worktree_new_path?: BytesText | null;
  untracked: boolean;
  ignored: boolean;
  conflicted: boolean;
}

export async function lmStatus(repoPath: string, includeIgnored = false) {
  const envelope = await lmEnvelope(repoPath);
  const args = ['status', '--porcelain=v1', '-z'];
  if (includeIgnored) args.push('--ignored');
  const { stdout } = await get(repoPath, args);
  const entries = stdout.split('\0').filter((s) => s.length > 0);
  const rows: StatusRow[] = [];
  for (const raw of entries) {
    if (raw.length < 4) continue;
    const x = raw[0]!;
    const y = raw[1]!;
    const pathAndRest = raw.slice(3);
    // Porcelain v1: rename format is "from -> to"
    let pathField = pathAndRest;
    let renameFrom: string | undefined;
    let renameTo: string | undefined;
    if ((x === 'R' || y === 'R') && pathAndRest.includes(' -> ')) {
      const split = pathAndRest.split(' -> ');
      renameFrom = split[0];
      renameTo = split.slice(1).join(' -> ');
      pathField = renameTo ?? pathAndRest;
    }
    const flagged = (x + y).trim();
    const untracked = flagged === '??';
    const ignored = flagged === '!!';
    const conflicted =
      x === 'U' || y === 'U' || flagged === 'DD' || flagged === 'AA' || flagged === 'DU' || flagged === 'UD' ||
      flagged === 'AU' || flagged === 'UA';
    rows.push({
      path: pathText(pathField),
      index_status: statusSide(x),
      worktree_status: statusSide(y),
      ...(renameFrom !== undefined
        ? {
            index_old_path: pathText(renameFrom),
            index_new_path: pathText(renameTo ?? ''),
          }
        : {}),
      untracked,
      ignored,
      conflicted,
    });
  }
  const clean = rows.every((r) => r.untracked !== true && r.ignored !== true &&
    r.index_status === 'clean' && r.worktree_status === 'clean');
  return { ...envelope, rows, clean };
}

function statusSide(code: string): string {
  switch (code) {
    case 'R': return 'renamed';
    case 'A': return 'added';
    case 'M': return 'modified';
    case 'D': return 'deleted';
    case 'T': return 'typechanged';
    case 'U': return 'conflicted';
    case '?': return 'untracked';
    case '!': return 'ignored';
    case ' ': return 'clean';
    default: return 'clean';
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export interface LmDiffOptions {
  from?: string;
  to?: string;
  staged?: boolean;
  paths?: string[];
}

export async function lmDiff(repoPath: string, options: LmDiffOptions = {}) {
  const envelope = await lmEnvelope(repoPath);
  const args = ['diff', '--no-color', '--no-ext-diff'];
  if (options.staged) {
    args.push('--cached');
    if (options.to) {
      throw new CliError(ErrorCode.InvalidRequest, '--staged cannot be combined with TO');
    }
    if (options.from) args.push(options.from);
  } else if (options.from && options.to) {
    args.push(options.from, options.to);
  } else if (options.from) {
    args.push(options.from);
  }
  if (options.paths && options.paths.length > 0) {
    args.push('--', ...options.paths);
  }
  const { stdout, exitCode } = await get(repoPath, args);
  if (exitCode !== 0) fail('diff', 'non-zero exit', { exitCode, rev: options.from ?? options.to });

  // Parse the unified diff into rows with hunks, preserving byte-level content.
  const buf = Buffer.from(stdout, 'utf-8');
  const text = buf.toString('utf-8');
  const rows: Array<Record<string, unknown>> = [];
  let current: Record<string, unknown> | undefined;
  let hunks: Array<Record<string, unknown>> = [];
  let currentHunk: Record<string, unknown> | undefined;
  let additions = 0;
  let deletions = 0;

  const pushHunk = () => {
    if (currentHunk && current) {
      hunks.push(currentHunk);
    }
    currentHunk = undefined;
  };
  const pushFile = () => {
    pushHunk();
    if (current) {
      current['hunks'] = hunks;
      current['additions'] = additions;
      current['deletions'] = deletions;
      rows.push(current);
    }
    current = undefined;
    hunks = [];
    additions = 0;
    deletions = 0;
  };

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git')) {
      pushFile();
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = {
        old_path: m ? pathText(m[1] ?? '') : null,
        new_path: m ? pathText(m[2] ?? '') : null,
        path: m ? pathText(m[2] ?? m[1] ?? '') : null,
        old_oid: '',
        new_oid: '',
        old_mode: '',
        new_mode: '',
        status: 'modified',
      };
      currentHunk = undefined;
    } else if (!current) continue;
    else if (line.startsWith('index ')) {
      const m = line.match(/^index ([0-9a-f]+)..([0-9a-f]+)(?: (\d+))?$/);
      if (m) {
        current['old_oid'] = m[1] ?? '';
        current['new_oid'] = m[2] ?? '';
        if (m[3]) {
          current['new_mode'] = m[3];
          if (!current['old_mode']) current['old_mode'] = m[3];
        }
      }
    } else if (line.startsWith('old mode ')) current['old_mode'] = line.slice(9).trim();
    else if (line.startsWith('new mode ')) current['new_mode'] = line.slice(9).trim();
    else if (line.startsWith('new file mode ')) { current['status'] = 'added'; current['new_mode'] = line.slice(14).trim(); }
    else if (line.startsWith('deleted file mode ')) { current['status'] = 'deleted'; current['old_mode'] = line.slice(18).trim(); }
    else if (line.startsWith('similarity index')) { /* rename hint */ }
    else if (line.startsWith('rename from ')) { current['status'] = 'renamed'; current['old_path'] = pathText(line.slice(12)); }
    else if (line.startsWith('rename to ')) { current['status'] = 'renamed'; current['new_path'] = pathText(line.slice(10)); current['path'] = current['new_path']; }
    else if (line.startsWith('Binary files')) { current['binary'] = true; }
    else if (line.startsWith('@@ ')) {
      pushHunk();
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
      if (m) {
        currentHunk = {
          old_start: Number(m[1]),
          old_lines: m[2] ? Number(m[2]) : 1,
          new_start: Number(m[3]),
          new_lines: m[4] ? Number(m[4]) : 1,
          header: pathText(m[5] ?? ''),
          lines: [],
        };
      }
    } else if (currentHunk) {
      const origin = line === '' ? ' ' : line[0]!;
      if (origin === '+' || origin === '-' || origin === ' ') {
        (currentHunk['lines'] as Array<Record<string, unknown>>).push({
          origin,
          content: pathText(line.slice(1)),
        });
        if (origin === '+') additions++;
        if (origin === '-') deletions++;
      } else if (origin === '\\') {
        // "\ No newline at end of file" — keep for fidelity
        (currentHunk['lines'] as Array<Record<string, unknown>>).push({
          origin: '\\',
          content: pathText(line.slice(1)),
        });
      }
    }
  }
  pushFile();
  // Stats: reuse the per-file counts already attached.
  const stats = {
    files: rows.length,
    insertions: rows.reduce((n, r) => n + ((r['additions'] as number) ?? 0), 0),
    deletions: rows.reduce((n, r) => n + ((r['deletions'] as number) ?? 0), 0),
  };
  return { ...envelope, rows, stats };
}

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

export async function lmLog(repoPath: string, revision = 'HEAD', maxCount = 20) {
  if (maxCount <= 0) throw new CliError(ErrorCode.InvalidRequest, '--max-count must be positive');
  const envelope = await lmEnvelope(repoPath);
  const recordSep = '';
  const fieldSep = '';
  const format = `%H${fieldSep}%h${fieldSep}%P${fieldSep}%T${fieldSep}%an${fieldSep}%ae${fieldSep}%at${fieldSep}%ai${fieldSep}%cn${fieldSep}%ce${fieldSep}%ct${fieldSep}%ci${fieldSep}%B${recordSep}`;
  const args = ['log', revision, `--pretty=format:${format}`, `--max-count=${maxCount}`, '-z'];
  const { stdout, exitCode } = await get(repoPath, args);
  if (exitCode !== 0) {
    if (/bad revision|unknown revision|Needed a single revision/i.test(stdout) || stdout === '') {
      return { ...envelope, rows: [], truncated: false, maxCount };
    }
    fail('log', 'non-zero exit', { revision, exitCode });
  }
  const records = stdout.split(recordSep).filter((r) => r.trim().length > 0);
  const rows = records.map((rec) => {
    const cleaned = rec.replace(/^\0+|\0+$/g, '');
    const fields = cleaned.split(fieldSep);
    const toBytes = (s: string | undefined): BytesText => pathText((s ?? '').replace(/\0/g, ''));
    const trimNl = (s: string) => s.replace(/\n+$/, '');
    const [fullHash, shortHash, parents, tree, an, ae, at, ai, cn, ce, ct, ci, body] = fields;
    return {
      id: fullHash ?? '',
      short_id: shortHash ?? '',
      parents: (parents ?? '').split(' ').filter(Boolean),
      tree: tree ?? '',
      summary: (() => {
        const b = trimNl(body ?? '');
        const firstLine = b.split('\n')[0] ?? '';
        return toBytes(firstLine);
      })(),
      message: (() => toBytes(trimNl(body ?? '')))(),
      author: { name: toBytes(an ?? ''), email: toBytes(ae ?? ''), time: Number(at ?? 0) },
      committer: { name: toBytes(cn ?? ''), email: toBytes(ce ?? ''), time: Number(ct ?? 0) },
    };
  });
  return { ...envelope, rows, truncated: rows.length === maxCount, maxCount };
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export async function lmShow(repoPath: string, revision = 'HEAD', file?: string) {
  const envelope = await lmEnvelope(repoPath);
  if (file) {
    const { stdout, exitCode } = await get(repoPath, ['show', `${revision}:${file}`]);
    if (exitCode !== 0) {
      throw new CliError(ErrorCode.NotFound, `no such path in revision`, { revision, file });
    }
    return {
      ...envelope,
      revision,
      file: pathText(file),
      content: bytesText(Buffer.from(stdout, 'utf-8')),
    };
  }
  const { stdout, exitCode } = await get(repoPath, [
    'show',
    '--no-color',
    '--format=%H%n%h%n%P%n%T%n%an%n%ae%n%at%n%cn%n%ce%n%ct%n%B',
    revision,
  ]);
  if (exitCode !== 0) fail('show', 'revision error', { revision });
  const lines = stdout.split('\n');
  const [hash, shortHash, parents, tree, an, ae, at, cn, ce, ct, ...rest] = lines;
  const message = rest.join('\n');
  return {
    ...envelope,
    revision,
    commit: {
      id: hash,
      short_id: shortHash,
      parents: (parents ?? '').split(' ').filter(Boolean),
      tree,
      summary: pathText((message.split('\n')[0] ?? '').trim()),
      message: pathText(message.trim()),
      author: { name: pathText(an ?? ''), email: pathText(ae ?? ''), time: Number(at ?? 0) },
      committer: { name: pathText(cn ?? ''), email: pathText(ce ?? ''), time: Number(ct ?? 0) },
    },
  };
}

// ---------------------------------------------------------------------------
// branch (with upstream ahead/behind)
// ---------------------------------------------------------------------------

export async function lmBranch(repoPath: string, all = false) {
  const envelope = await lmEnvelope(repoPath);
  const fmt = '%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)%00%(HEAD)';
  const refs = all ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
  const { stdout } = await get(repoPath, ['for-each-ref', `--format=${fmt}`, ...refs]);
  const rows: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [refname, shortname, oid, upstream, head] = line.split('\0');
    if (!refname) continue;
    let ahead: number | undefined;
    let behind: number | undefined;
    if (upstream) {
      const r = await get(repoPath, ['rev-list', '--left-right', '--count', `${oid}...${upstream}`]);
      if (r.exitCode === 0) {
        const parts = r.stdout.trim().split(/\s+/);
        ahead = Number(parts[0] ?? 0);
        behind = Number(parts[1] ?? 0);
      } else {
        warnings.push({ code: 'GIT_GRAPH_INCOMPLETE', message: 'could not compute ahead/behind' });
      }
    }
    rows.push({
      name: pathText(shortname ?? refname),
      refname: pathText(refname),
      remote: refname.startsWith('refs/remotes/'),
      current: head === '*',
      target: oid ?? null,
      upstream: upstream ? pathText(upstream) : null,
      ...(ahead !== undefined ? { ahead } : {}),
      ...(behind !== undefined ? { behind } : {}),
    });
  }
  return {
    ...envelope,
    rows,
    ...(warnings.length > 0 ? { partial: true, warnings } : { partial: false }),
  };
}

// ---------------------------------------------------------------------------
// remote (redacted)
// ---------------------------------------------------------------------------

export async function lmRemote(repoPath: string) {
  const envelope = await lmEnvelope(repoPath);
  const { stdout: namesOut } = await get(repoPath, ['remote']);
  const names = namesOut.split('\n').map((n) => n.trim()).filter(Boolean);
  const rows: Array<Record<string, unknown>> = [];
  const warnings: Array<Record<string, unknown>> = [];
  // `git config --list --null` emits "key\nvalue\0" records (key on one line,
  // value on the next, record terminated by NUL). Parsing newline-delimited
  // "key=value" silently drops every entry.
  const cfg = await get(repoPath, ['config', '--list', '--null']);
  const records = cfg.stdout.split('\0');
  const configByKey = new Map<string, string[]>();
  for (const record of records) {
    if (!record) continue;
    const newline = record.indexOf('\n');
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? '' : record.slice(newline + 1).replace(/\n$/, '');
    const existing = configByKey.get(key) ?? [];
    existing.push(value);
    configByKey.set(key, existing);
  }
  for (const name of names) {
    const fetch = (configByKey.get(`remote.${name}.url`) ?? [])[0];
    const push = (configByKey.get(`remote.${name}.pushurl`) ?? [])[0] ?? fetch;
    rows.push({
      name: pathText(name),
      fetch_url: fetch ? redactUrlBytes(Buffer.from(fetch, 'utf-8')) : null,
      push_url: push ? redactUrlBytes(Buffer.from(push, 'utf-8')) : null,
      configured_fetch_urls: (configByKey.get(`remote.${name}.url`) ?? []).map((v) =>
        redactUrlBytes(Buffer.from(v, 'utf-8')),
      ),
      configured_push_urls: (configByKey.get(`remote.${name}.pushurl`) ?? []).map((v) =>
        redactUrlBytes(Buffer.from(v, 'utf-8')),
      ),
      fetch_refspecs: (configByKey.get(`remote.${name}.fetch`) ?? []).map((v) => pathText(v)),
      push_refspecs: (configByKey.get(`remote.${name}.push`) ?? []).map((v) => pathText(v)),
    });
  }
  return { ...envelope, rows, ...(warnings.length > 0 ? { warnings } : {}) };
}

// ---------------------------------------------------------------------------
// rev-parse
// ---------------------------------------------------------------------------

export async function lmRevParse(repoPath: string, revision = 'HEAD') {
  const envelope = await lmEnvelope(repoPath);
  const { stdout, exitCode } = await get(repoPath, ['rev-parse', revision]);
  if (exitCode !== 0) {
    throw new CliError(ErrorCode.NotFound, `unresolvable revision: ${revision}`, { revision });
  }
  const oid = stdout.trim();
  // Peel to commit if it is a tag/annotated object.
  const { stdout: kindOut } = await get(repoPath, ['cat-file', '-t', oid]);
  const kind = kindOut.trim();
  let commit: string | undefined;
  if (kind === 'commit') commit = oid;
  else if (kind === 'tag') {
    const peeled = await get(repoPath, ['rev-list', '-n', '1', oid]);
    if (peeled.exitCode === 0 && peeled.stdout.trim()) {
      commit = peeled.stdout.trim();
    }
  }
  return { ...envelope, revision, oid, kind, ...(commit !== undefined ? { commit } : {}) };
}

// ---------------------------------------------------------------------------
// ls-files
// ---------------------------------------------------------------------------

export async function lmLsFiles(repoPath: string, paths: string[] = []) {
  const envelope = await lmEnvelope(repoPath);
  const args = ['ls-files', '--stage', '-z'];
  if (paths.length > 0) args.push('--', ...paths);
  const { stdout } = await get(repoPath, args);
  const rows: Array<Record<string, unknown>> = [];
  for (const entry of stdout.split('\0')) {
    if (!entry) continue;
    // Format: <mode> SP <oid> SP <stage> TAB <path>
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    rows.push({
      path: pathText(path),
      mode: meta[0] ?? '',
      oid: meta[1] ?? '',
      stage: Number(meta[2] ?? 0),
    });
  }
  return { ...envelope, rows };
}

// ---------------------------------------------------------------------------
// blame
// ---------------------------------------------------------------------------

export async function lmBlame(repoPath: string, file: string, revision = 'HEAD') {
  const envelope = await lmEnvelope(repoPath);
  const { stdout, exitCode } = await get(repoPath, [
    'blame', '--line-porcelain', revision, '--', file,
  ]);
  if (exitCode !== 0) {
    fail('blame', 'blame failed', { file, revision });
  }
  const rows: Array<Record<string, unknown>> = [];
  let current: { commit: string; originalLine: number; finalLine: number; groupSize: number; idxInGroup: number } | undefined;
  let bufferAuthors: Record<string, { name: BytesText; email: BytesText; time: number; offset_minutes: number }> = {};
  let pendingAuthor: { name?: BytesText; email?: BytesText; time?: number; offset?: number } = {};

  const flushGroupIfDone = () => {
    if (!current) return;
    if (current.idxInGroup >= current.groupSize) {
      current = undefined;
      pendingAuthor = {};
    }
  };

  for (const line of stdout.split('\n')) {
    const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (headerMatch) {
      flushGroupIfDone();
      const [, commit, origLine, finalLine, groupSizeStr] = headerMatch;
      current = {
        commit: commit!,
        originalLine: Number(origLine),
        finalLine: Number(finalLine),
        groupSize: groupSizeStr ? Number(groupSizeStr) : 1,
        idxInGroup: 0,
      };
      pendingAuthor = {};
      continue;
    }
    if (!current) continue;

    if (line.startsWith('author ')) {
      pendingAuthor.name = pathText(line.slice(7));
    } else if (line.startsWith('author-mail ')) {
      const m = line.slice(12).replace(/^<|>$/g, '');
      pendingAuthor.email = pathText(m);
    } else if (line.startsWith('author-time ')) {
      pendingAuthor.time = Number(line.slice(12));
    } else if (line.startsWith('author-tz ')) {
      const tz = line.slice(10);
      const sign = tz.startsWith('-') ? -1 : 1;
      const [h, m] = tz.replace(/^[+-]/, '').split(':').map(Number);
      pendingAuthor.offset = sign * ((h ?? 0) * 60 + (m ?? 0));
    } else if (line.startsWith('\t')) {
      // Content line: end of this line's entry
      const author = {
        name: pendingAuthor.name ?? '',
        email: pendingAuthor.email ?? '',
        time: pendingAuthor.time ?? 0,
        offset_minutes: pendingAuthor.offset ?? 0,
      };
      bufferAuthors[current.commit] = author as never;
      rows.push({
        line: current.finalLine + current.idxInGroup,
        original_line: current.originalLine + current.idxInGroup,
        commit: current.commit,
        author,
        path: pathText(file),
        content: pathText(line.slice(1)),
        boundary: false,
      });
      current.idxInGroup++;
    }
  }
  return { ...envelope, rows, revision, file };
}

// ---------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------

export { btStr as __bytesTextAsString__ };
