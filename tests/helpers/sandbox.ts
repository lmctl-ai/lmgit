/**
 * @fileoverview Hermetic test sandbox for git2 tests.
 *
 * Every test file that touches git creates one Sandbox: a mkdtemp directory
 * under os.tmpdir() holding a fake HOME, an isolated global git config, a
 * fake gpg program and any repositories the tests need. Git is always run
 * with an isolated environment (no system/user config, fixed identity and
 * dates, LC_ALL=C), so the developer's HOME, cwd and git config are never
 * read or written.
 */

import { afterAll, beforeAll } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Fixed author/committer date so commit ids are reproducible. */
export const FIXED_DATE = '2024-01-02T03:04:05+00:00';
/** FIXED_DATE as unix seconds. */
export const FIXED_EPOCH = 1704164645;
export const AUTHOR_NAME = 'Test Author';
export const AUTHOR_EMAIL = 'author@example.test';

export const CLI_PATH = resolve(import.meta.dir, '../../src/cli.ts');

export interface Sandbox {
  /** Root temp dir (removed by cleanup()). */
  root: string;
  /** Fake HOME. */
  home: string;
  /** Isolated GIT_CONFIG_GLOBAL file. */
  globalConfig: string;
  /** File whose content selects the fake gpg program's behaviour. */
  gpgModeFile: string;
  /** Full isolated environment for spawning git / the CLI. */
  env: Record<string, string>;
  /** Create a fresh sub-directory of the sandbox. */
  dir(name: string): string;
  /** Run git synchronously with the isolated env; throws on failure. */
  git(cwd: string, args: string[], opts?: { allowFail?: boolean; input?: string }): GitRun;
  /** Create a repo (on `main`) with one commit containing `files`. */
  repo(name: string, files?: Record<string, string>): string;
  /** Write a file (creating parents) relative to `cwd`. */
  write(cwd: string, rel: string, content: string | Uint8Array): void;
  /** Stage everything and commit with `message`; returns the new HEAD oid. */
  commitAll(cwd: string, message: string): string;
  /** Select the fake gpg behaviour (see FAKE_GPG). */
  setGpgMode(mode: GpgMode): void;
  /** Remove the sandbox. */
  cleanup(): void;
}

export interface GitRun {
  stdout: string;
  stderr: string;
  status: number;
}

export type GpgMode =
  | 'sign-fail'
  | 'good'
  | 'bad'
  | 'x509-good'
  | 'ssh-unconfigured'
  | 'ssh-bad'
  | 'ssh-good'
  | 'unknown-ok'
  | 'unknown-fail';

/**
 * Fake gpg: signing prints a dummy armored signature plus the SIG_CREATED
 * status line git requires (or fails in sign-fail mode); verifying emits
 * canned human-readable output on stderr and GOODSIG status lines on stdout
 * for the modes that should make `git tag -v` exit 0.
 */
const FAKE_GPG = `#!/bin/sh
mode=$(cat "$(dirname "$0")/gpg-mode" 2>/dev/null || echo good)
verify=0
for a in "$@"; do [ "$a" = "--verify" ] && verify=1; done
cat >/dev/null
if [ "$verify" = "0" ]; then
  if [ "$mode" = "sign-fail" ]; then echo "gpg: signing failed: No secret key" >&2; exit 2; fi
  printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 1704164645 ABCDEF0123456789\\n' >&2
  printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'
  exit 0
fi
good() { printf '[GNUPG:] NEWSIG\\n[GNUPG:] GOODSIG ABCDEF0123456789 Test Signer <s@example.test>\\n[GNUPG:] VALIDSIG ABCDEF0123456789ABCDEF0123456789ABCDEF01 2024-01-02 1704164645 0 4 0 1 8 00 ABCDEF0123456789ABCDEF0123456789ABCDEF01\\n[GNUPG:] TRUST_ULTIMATE 0 pgp\\n'; }
case "$mode" in
  good) good; echo 'gpg: Signature made Tue Jan  2 03:04:05 2024 UTC' >&2; echo 'gpg:                using RSA key ABCDEF0123456789' >&2; echo 'gpg: Good signature from "Test Signer <s@example.test>" [ultimate]' >&2; exit 0;;
  bad) printf '[GNUPG:] BADSIG ABCDEF0123456789 Test Signer\\n'; echo 'gpg: BAD signature from "Test Signer <s@example.test>" [ultimate]' >&2; exit 1;;
  x509-good) good; echo 'gpgsm: Good signature from "CN=Test Signer"' >&2; exit 0;;
  ssh-unconfigured) echo 'error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification' >&2; exit 1;;
  ssh-bad) echo 'Signature verification failed: incorrect signature for "signer@example.test"' >&2; exit 1;;
  ssh-good) good; echo 'Good "git" signature for signer@example.test with ED25519 key SHA256:AbCdEf0123' >&2; exit 0;;
  unknown-ok) good; echo 'some future verifier output' >&2; exit 0;;
  *) echo 'some unrecognised verifier failure' >&2; exit 1;;
esac
`;

/** Remove inherited git-related variables so nothing leaks in from the host. */
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  // Only PATH is inherited (to locate git and bun); everything else is fixed.
  env['PATH'] = process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';
  return env;
}

export function createSandbox(prefix: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), `git2-${prefix}-`));
  const home = join(root, 'home');
  mkdirSync(home);
  const globalConfig = join(home, 'gitconfig');
  const gpgDir = join(root, 'gpg');
  mkdirSync(gpgDir);
  const gpgProgram = join(gpgDir, 'fake-gpg.sh');
  const gpgModeFile = join(gpgDir, 'gpg-mode');
  writeFileSync(gpgProgram, FAKE_GPG);
  chmodSync(gpgProgram, 0o755);
  writeFileSync(gpgModeFile, 'good');
  writeFileSync(
    globalConfig,
    [
      '[user]',
      `\tname = ${AUTHOR_NAME}`,
      `\temail = ${AUTHOR_EMAIL}`,
      '\tsigningkey = ABCDEF0123456789',
      '[init]',
      '\tdefaultBranch = main',
      '[gpg]',
      `\tprogram = ${gpgProgram}`,
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '[pull]',
      '\trebase = false',
      '[gc]',
      '\tauto = 0',
      '[maintenance]',
      '\tauto = false',
      '[advice]',
      '\tdetachedHead = false',
      '[core]',
      '\tautocrlf = false',
      '[protocol "file"]',
      '\tallow = always',
      '',
    ].join('\n'),
  );

  const env: Record<string, string> = {
    ...baseEnv(),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GNUPGHOME: join(home, '.gnupg'),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_PAGER: 'cat',
    LC_ALL: 'C',
    LANG: 'C',
    NO_COLOR: '1',
    TZ: 'UTC',
  };

  let counter = 0;
  const sb: Sandbox = {
    root,
    home,
    globalConfig,
    gpgModeFile,
    env,
    dir(name: string): string {
      counter++;
      const d = join(root, `${String(counter).padStart(3, '0')}-${name}`);
      mkdirSync(d, { recursive: true });
      return d;
    },
    git(cwd, args, opts = {}) {
      const res = Bun.spawnSync(['git', ...args], {
        cwd,
        env,
        stdin: opts.input !== undefined ? Buffer.from(opts.input) : 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const out: GitRun = {
        stdout: res.stdout.toString(),
        stderr: res.stderr.toString(),
        status: res.exitCode ?? -1,
      };
      if (out.status !== 0 && !opts.allowFail) {
        throw new Error(`git ${args.join(' ')} failed (${out.status}): ${out.stderr}`);
      }
      return out;
    },
    write(cwd, rel, content) {
      const full = join(cwd, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    },
    repo(name, files = { 'README.md': '# repo\n' }) {
      const d = sb.dir(name);
      sb.git(d, ['init', '-q', '-b', 'main']);
      for (const [rel, content] of Object.entries(files)) sb.write(d, rel, content);
      sb.commitAll(d, 'initial');
      return d;
    },
    commitAll(cwd, message) {
      sb.git(cwd, ['add', '-A']);
      sb.git(cwd, ['commit', '-q', '--allow-empty', '-m', message]);
      return sb.git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
    },
    setGpgMode(mode) {
      writeFileSync(gpgModeFile, mode);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return sb;
}

/**
 * Apply the sandbox env to process.env (for in-process library calls, whose
 * executor spawns git with process.env). Returns a restore function that puts
 * back exactly the previous values.
 */
export function applyEnv(env: Record<string, string>): () => void {
  const saved = new Map<string, string | undefined>();
  const touch = (k: string) => {
    if (!saved.has(k)) saved.set(k, process.env[k]);
  };
  // Drop inherited GIT_* variables (GIT_DIR etc. would redirect git).
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GIT_') || k.startsWith('GIT2_')) {
      touch(k);
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(env)) {
    if (k === 'PATH') continue;
    touch(k);
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

/**
 * Register beforeAll/afterAll hooks that create a sandbox, point
 * process.env at it for the duration of the file, and restore + clean up
 * afterwards. Returns a getter for the sandbox.
 */
export function useSandbox(prefix: string): () => Sandbox {
  let sb: Sandbox | undefined;
  let restore: (() => void) | undefined;
  beforeAll(() => {
    sb = createSandbox(prefix);
    restore = applyEnv(sb.env);
  });
  afterAll(() => {
    restore?.();
    sb?.cleanup();
  });
  return () => {
    if (!sb) throw new Error('sandbox not initialised');
    return sb;
  };
}

/** Temporarily set process.env vars; returns a restore function. */
export function setEnv(vars: Record<string, string | undefined>): () => void {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

export interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
  /** Parsed stdout JSON (undefined if stdout is not JSON). */
  json: unknown;
}

/** Spawn `bun src/cli.ts ...args` with cwd + isolated env from the sandbox. */
export function runCli(
  sb: Sandbox,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): CliRun {
  const res = Bun.spawnSync([process.execPath, CLI_PATH, ...args], {
    cwd,
    env: { ...sb.env, ...extraEnv },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = res.stdout.toString();
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { status: res.exitCode ?? -1, stdout, stderr: res.stderr.toString(), json };
}

/** Narrow an unknown to a record for property assertions. */
export function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`expected object, got ${String(v)}`);
  return v as Record<string, unknown>;
}

/** Narrow an unknown to an array of records. */
export function recs(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) throw new Error(`expected array, got ${String(v)}`);
  return v as Array<Record<string, unknown>>;
}
