/**
 * @fileoverview Hermetic tests for product compatibility checking in git2.
 * Verifies that git2 enforces its product range (git >=2.43.0 <3.0.0),
 * accepts tested versions, rejects incompatible/missing binaries with exit 10,
 * runs --schema/--list/--help unconditionally, and caches version detection.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const CLI_PATH = resolve(REPO_ROOT, 'src/cli.ts');

const REAL_GIT_VERSION_OUTPUT = 'git version 2.43.0\n';
const GIT_PATTERN = 'git version (\\d+\\.\\d+\\.\\d+)';
const SUPPORTED_RANGE = '>=2.43.0 <3.0.0';

describe('git2 product compatibility', () => {
  let tempBinDir: string;
  let counterFile: string;

  beforeEach(() => {
    tempBinDir = mkdtempSync(join(tmpdir(), 'git2-product-test-'));
    counterFile = join(tempBinDir, 'call-count.txt');
  });

  afterEach(() => {
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  function createFakeGit(output: string, exitCode = 0, trackCount = false) {
    const gitPath = join(tempBinDir, 'git');
    const countSnippet = trackCount ? `echo "call" >> "${counterFile}"` : '';
    const script = `#!/bin/sh
if [ "$1" = "--version" ]; then
  ${countSnippet}
  cat <<'EOF'
${output}
EOF
  exit ${exitCode}
fi

# Fallback echo for any other git command
echo "fake git executed: $@"
exit 0
`;
    writeFileSync(gitPath, script);
    chmodSync(gitPath, 0o755);
  }

  function runGit2(args: string[], extraEnv: Record<string, string> = {}) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${tempBinDir}:/usr/bin:/bin`,
        ...extraEnv,
      },
    });
  }

  test('verified: REAL git --version output matches pattern and satisfies range', () => {
    const match = REAL_GIT_VERSION_OUTPUT.match(new RegExp(GIT_PATTERN));
    expect(match).not.toBeNull();
    expect(match![1]).toBe('2.43.0');

    createFakeGit(REAL_GIT_VERSION_OUTPUT);
    const proc = runGit2(['status']);
    expect(proc.status).toBe(0);
  });

  test('supported version (>=2.43.0 <3.0.0) allows operation to run', () => {
    createFakeGit('git version 2.45.2\n');
    const proc = runGit2(['status']);
    expect(proc.status).toBe(0);
  });

  test('too old version (<2.43.0) refuses operation with exit 10 and UNSUPPORTED_PRODUCT_VERSION', () => {
    createFakeGit('git version 2.42.0\n');
    const proc = runGit2(['status']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'git',
      found: '2.42.0',
      supported: SUPPORTED_RANGE,
    });
  });

  test('too new version (>=3.0.0) refuses operation with exit 10 and UNSUPPORTED_PRODUCT_VERSION', () => {
    createFakeGit('git version 3.0.0\n');
    const proc = runGit2(['status']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'git',
      found: '3.0.0',
      supported: SUPPORTED_RANGE,
    });
  });

  test('garbage/unparseable output refuses operation with exit 10 and found: null', () => {
    createFakeGit('git version unknown-string-without-semver\n');
    const proc = runGit2(['status']);
    expect(proc.status).toBe(10);

    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'git',
      found: null,
      supported: SUPPORTED_RANGE,
    });
  });

  test('missing git binary on isolated PATH refuses operation with exit 10 and found: null', () => {
    // Isolated PATH containing only an empty directory
    const proc = spawnSync(process.execPath, [CLI_PATH, 'status'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: tempBinDir, // no git binary in here
      },
    });

    expect(proc.status).toBe(10);
    const payload = JSON.parse(proc.stdout);
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
    expect(payload.error.data).toEqual({
      product: 'git',
      found: null,
      supported: SUPPORTED_RANGE,
    });
  });

  test('--schema, --list, and --help succeed regardless of product version check', () => {
    // Set up an incompatible git version that would fail any operation
    createFakeGit('git version 1.9.0\n');

    const schemaProc = runGit2(['--schema']);
    expect(schemaProc.status).toBe(0);
    const schemaDoc = JSON.parse(schemaProc.stdout);
    expect(schemaDoc.tool).toBe('git2');
    expect(schemaDoc.product).toBeDefined();
    expect(schemaDoc.product.name).toBe('git');
    expect(schemaDoc.product.supported).toBe(SUPPORTED_RANGE);

    const listProc = runGit2(['--list']);
    expect(listProc.status).toBe(0);
    expect(listProc.stdout).toContain('status');

    const helpProc = runGit2(['--help']);
    expect(helpProc.status).toBe(0);
    expect(helpProc.stdout).toContain('Structured git CLI');
  });

  test('version detection command is spawned only once per process', () => {
    createFakeGit(REAL_GIT_VERSION_OUTPUT, 0, true);

    const productJson = JSON.stringify({
      name: 'git',
      supported: SUPPORTED_RANGE,
      detect: {
        argv: ['git', '--version'],
        pattern: GIT_PATTERN,
      },
    });

    const testScript = `
import { checkProductVersion } from '@lmctl-ai/lmts/server';
const product = ${productJson};
const res1 = await checkProductVersion(product);
const res2 = await checkProductVersion(product);
if (!res1.ok || !res2.ok) {
  console.error('res1:', res1, 'res2:', res2);
  process.exit(1);
}
process.exit(0);
`;
    const res = spawnSync(process.execPath, ['-e', testScript], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${tempBinDir}:/usr/bin:/bin`,
      },
    });

    expect(res.status).toBe(0);
    const countData = readFileSync(counterFile, 'utf-8');
    const count = countData.trim().split('\n').filter(Boolean).length;
    expect(count).toBe(1);
  });
});
